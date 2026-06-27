/**
 * IPC client: connects to the broker endpoint, frames JSON, and provides a
 * request/response helper keyed on requestId plus a push-frame listener.
 */
import net from 'node:net';
import { FrameDecoder, encodeFrame } from './framing.js';
import { makeFrame, type Frame, type FrameType } from '../protocol/commands.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import { startClientHandshake, parseServerHello, clientFinish, SecureSession, AuthFailed, ProtocolMismatch, type HelloIdentity } from './secure-channel.js';
import { BUILD_ID } from '../protocol/handshake.js';

export interface ClientOptions {
  requestTimeoutMs?: number;
  idGen?: () => string;
  nowIso?: () => string;
  /** Installation root secret. Required for the secure transport (XBUS-STP). */
  rootSecret?: Buffer;
  /** Key version of the root secret (rotation). */
  keyVersion?: number;
  /** Identity claims for the handshake (role/session/epoch); informational at L1. */
  helloIdentity?: Partial<HelloIdentity>;
}

export class IpcClient {
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private pending = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private pushHandlers: Array<(f: Frame) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private reqSeq = 0;
  private readonly requestTimeoutMs: number;
  private readonly idGen: () => string;
  private readonly nowIso: () => string;
  private readonly rootSecret: Buffer | undefined;
  private readonly keyVersion: number;
  private readonly helloIdentity: Partial<HelloIdentity>;
  private secure: SecureSession | null = null;

  constructor(private readonly endpoint: string, opts: ClientOptions = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.idGen = opts.idGen ?? (() => `req-${++this.reqSeq}`);
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.rootSecret = opts.rootSecret;
    this.keyVersion = opts.keyVersion ?? 1;
    this.helloIdentity = opts.helloIdentity ?? {};
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint);
      this.socket = socket;
      socket.once('error', reject);
      socket.on('close', () => {
        for (const h of this.closeHandlers) h();
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new XBusError(XBusErrorCode.BROKER_UNAVAILABLE, 'connection closed'));
        }
        this.pending.clear();
      });
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        socket.on('error', () => {});
        resolve();
      });
    });
    if (this.rootSecret) {
      await this.performHandshake();
    }
    // After handshake (or in insecure test mode), wire the frame reader.
    this.socket!.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  /** XBUS-STP handshake over bounded plaintext, then all frames are sealed. */
  private performHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const id: HelloIdentity = {
        buildId: this.helloIdentity.buildId ?? BUILD_ID,
        appProtoRange: this.helloIdentity.appProtoRange ?? '1-1',
        claimedRole: this.helloIdentity.claimedRole ?? 'mcp',
        claimedSessionId: this.helloIdentity.claimedSessionId ?? '',
        claimedEpoch: this.helloIdentity.claimedEpoch ?? 0,
        capabilities: this.helloIdentity.capabilities ?? '',
      };
      const ch = startClientHandshake(this.keyVersion, id);
      const hsDecoder = new FrameDecoder();
      const timer = setTimeout(() => reject(new XBusError(XBusErrorCode.AUTH_FAILED, 'handshake timeout')), this.requestTimeoutMs);
      const onHsData = (chunk: Buffer) => {
        let res;
        try { res = hsDecoder.push(chunk); } catch (e) { cleanup(); reject(e instanceof Error ? e : new Error(String(e))); return; }
        const first = res.frames[0];
        if (first === undefined) return; // wait for full server_hello
        cleanup();
        try {
          const sh = parseServerHello(Buffer.from(first as { d: string }['d'] ? Buffer.from((first as { d: string }).d, 'base64') : Buffer.alloc(0)));
          void sh;
        } catch { /* fallthrough handled below */ }
        try {
          // server_hello is sent as a raw length-prefixed binary buffer wrapped
          // in a frame {h:'sh', d:<base64>}.
          const shBytes = Buffer.from((first as { d: string }).d, 'base64');
          const parsed = parseServerHello(shBytes);
          const fin = clientFinish(this.rootSecret!, ch.state, parsed);
          this.secure = new SecureSession(fin.keys, fin.connId, 'client');
          this.socket!.write(encodeFrame({ h: 'cf', d: fin.clientProof.toString('base64') }));
          resolve();
        } catch (e) {
          if (e instanceof AuthFailed) reject(new XBusError(XBusErrorCode.AUTH_FAILED, 'broker authentication failed'));
          else if (e instanceof ProtocolMismatch) reject(new XBusError(XBusErrorCode.PROTOCOL_MISMATCH, e.message));
          else reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      const cleanup = () => { clearTimeout(timer); this.socket!.removeListener('data', onHsData); };
      this.socket!.on('data', onHsData);
      // send client_hello wrapped
      this.socket!.write(encodeFrame({ h: 'ch', d: ch.clientHelloBytes.toString('base64') }));
    });
  }

  private onData(chunk: Buffer): void {
    let result;
    try {
      result = this.decoder.push(chunk);
    } catch {
      this.socket?.destroy();
      return;
    }
    for (;;) {
      for (const payload of result.frames) {
        if (this.secure) {
          // Each wire frame is a base64-wrapped sealed buffer; open -> JSON Frame.
          try {
            const sealed = Buffer.from((payload as { d: string }).d, 'base64');
            const pt = this.secure.open(sealed);
            this.onFrame(JSON.parse(pt.toString('utf8')) as Frame);
          } catch {
            this.socket?.destroy(); // tamper/replay -> drop connection
            return;
          }
        } else {
          this.onFrame(payload as Frame);
        }
      }
      if (!result.hasMore) break;
      result = this.decoder.continueDrain();
    }
  }

  /** Write a Frame, sealing it when the secure session is established. */
  private writeFrame(frame: Frame): void {
    if (!this.socket) throw new XBusError(XBusErrorCode.BROKER_UNAVAILABLE, 'not connected');
    if (this.secure) {
      const sealed = this.secure.seal(Buffer.from(JSON.stringify(frame), 'utf8'));
      this.socket.write(encodeFrame({ d: sealed.toString('base64') }));
    } else {
      this.socket.write(encodeFrame(frame));
    }
  }

  private onFrame(frame: Frame): void {
    if (frame.requestId && this.pending.has(frame.requestId)) {
      const p = this.pending.get(frame.requestId)!;
      clearTimeout(p.timer);
      this.pending.delete(frame.requestId);
      p.resolve(frame);
      return;
    }
    for (const h of this.pushHandlers) h(frame);
  }

  /** Send a request frame and await its correlated response. */
  request(frameType: FrameType, payload: unknown): Promise<Frame> {
    if (!this.socket) return Promise.reject(new XBusError(XBusErrorCode.BROKER_UNAVAILABLE, 'not connected'));
    const requestId = this.idGen();
    const frame = makeFrame(frameType, payload, requestId, this.nowIso());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new XBusError(XBusErrorCode.BROKER_UNAVAILABLE, `request ${frameType} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.writeFrame(frame);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  onPush(cb: (f: Frame) => void): void {
    this.pushHandlers.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }
  close(): void {
    this.socket?.destroy();
  }
}
