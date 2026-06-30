/**
 * IPC server: accepts local connections, frames them, and routes decoded frames
 * to a handler. Enforces F18 controls: per-connection idle timeout, global
 * buffered-byte budget, max connections.
 */
import net from 'node:net';
import fs from 'node:fs';
import { FrameDecoder, encodeFrame } from './framing.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import type { Frame } from '../protocol/commands.js';
import { safeField } from '../observability/redaction.js';
import type { BrokerMetrics } from '../observability/metrics.js';
import { parseClientHello, serverHandshake, serverVerifyFinish, SecureSession, ProtocolMismatch, type DerivedKeys } from './secure-channel.js';

export interface ServerConn {
  readonly id: string;
  send(frame: Frame): void;
  close(reason?: string): void;
}

export interface ServerOptions {
  maxConnections?: number;
  idleTimeoutMs?: number;
  globalBufferBudgetBytes?: number;
  /** Max new connections accepted per sliding second (DoS bound). */
  connectRatePerSec?: number;
  /** Max time a connection may remain pre-secure-handshake before it is closed.
   *  Bounds a slow-loris that trickles bytes to keep the idle timer alive but
   *  never completes the handshake (default 10s). */
  handshakeTimeoutMs?: number;
  /** Installation root secret — REQUIRED for the secure transport (XBUS-STP). */
  rootSecret?: Buffer;
  /** Broker instance id, bound into the handshake transcript. */
  brokerInstanceId?: string;
  /** §1 observability: process-lifetime counter sink. Bumps are side-effect-free
   *  `++` at the EXISTING log points — no new branch on any hot path. */
  metrics?: BrokerMetrics;
  log?: (line: string) => void;
}

export type FrameHandler = (conn: ServerConn, frame: Frame) => void;

export class IpcServer {
  private server: net.Server | null = null;
  private conns = new Map<string, { socket: net.Socket; decoder: FrameDecoder; secure: SecureSession | null; pendingTh?: Buffer; pendingKeys?: DerivedKeys; connIdForSession?: Buffer; handshakeTimer?: NodeJS.Timeout }>();
  private totalBuffered = 0;
  private seq = 0;
  private readonly maxConnections: number;
  private readonly idleTimeoutMs: number;
  private readonly globalBudget: number;
  private readonly log: (line: string) => void;
  // DoS bound for the untrusted-transport residual (Design B, ADR 0010):
  // a connect-rate token bucket so unauthenticated clients can't storm the broker.
  private connectTimestamps: number[] = [];
  private readonly connectRatePerSec: number;
  private readonly handshakeTimeoutMs: number;

  private readonly rootSecret: Buffer | undefined;
  private readonly brokerInstanceId: string;
  private readonly metrics: BrokerMetrics | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly onFrame: FrameHandler,
    private readonly onCloseConn: (id: string) => void,
    opts: ServerOptions = {},
  ) {
    this.maxConnections = opts.maxConnections ?? 64;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
    this.globalBudget = opts.globalBufferBudgetBytes ?? 16 * 1024 * 1024;
    this.connectRatePerSec = opts.connectRatePerSec ?? 50;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.rootSecret = opts.rootSecret;
    this.brokerInstanceId = opts.brokerInstanceId ?? 'broker';
    this.metrics = opts.metrics;
    this.log = opts.log ?? (() => {});
  }

  /** §1 on-read gauges: live connection + buffer state (no hot-path cost). */
  gauges(): { activeConnections: number; maxConnections: number; bufferBytesInUse: number; bufferBudgetBytes: number } {
    return { activeConnections: this.conns.size, maxConnections: this.maxConnections, bufferBytesInUse: this.totalBuffered, bufferBudgetBytes: this.globalBudget };
  }

  listen(): Promise<void> {
    return this.listenOnce(true);
  }

  /**
   * Bind the endpoint. On POSIX the endpoint is a filesystem Unix socket: a broker
   * that was HARD-KILLED (SIGKILL/OOM/crash) never ran its graceful unlink, so a
   * stale `broker.sock` file is left on disk and Node's listen() then fails
   * EADDRINUSE forever — silently wedging auto-start (ADR 0012 D7 / beta.4 review).
   * Node does NOT auto-remove a stale UDS path. So: if the FIRST bind fails
   * EADDRINUSE on a Unix-socket path, PROBE it — if nothing answers it is stale →
   * unlink and retry ONCE. If something answers, a real broker owns it → propagate
   * (the singleton arbiter maps it to BROKER_CONTENDED). Windows named pipes are not
   * filesystem paths and need no unlink, so this only applies to UDS endpoints.
   */
  private listenOnce(allowStaleSocketRecovery: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.accept(socket));
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === 'EADDRINUSE' && allowStaleSocketRecovery && this.isUnixSocketEndpoint()) {
          // Probe the existing socket; if unreachable it is stale → unlink + retry.
          this.probeStaleSocket().then((reachable) => {
            if (reachable) { reject(err); return; } // a real broker owns it
            try { fs.unlinkSync(this.endpoint); } catch { /* ignore */ }
            this.listenOnce(false).then(resolve, reject); // retry ONCE, no further recovery
          }, () => reject(err));
          return;
        }
        reject(err);
      };
      this.server.once('error', onError);
      this.server.listen(this.endpoint, () => {
        this.server!.removeListener('error', onError);
        this.server!.on('error', () => {}); // swallow post-bind transient socket errors
        resolve();
      });
    });
  }

  /** Is the endpoint a filesystem Unix socket (vs a Windows named pipe)? */
  private isUnixSocketEndpoint(): boolean {
    return process.platform !== 'win32' && !this.endpoint.startsWith('\\\\');
  }

  /** Bounded probe of the endpoint: true if a server answers, false otherwise. */
  private probeStaleSocket(timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection(this.endpoint);
      let done = false;
      const finish = (v: boolean): void => { if (!done) { done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); } };
      const timer = setTimeout(() => finish(false), timeoutMs);
      sock.once('connect', () => { clearTimeout(timer); finish(true); });
      sock.once('error', () => { clearTimeout(timer); finish(false); });
    });
  }

  private accept(socket: net.Socket): void {
    if (this.conns.size >= this.maxConnections) {
      socket.destroy();
      this.log('CONN_LIMIT refused a connection');
      this.metrics?.onRefusedConnLimit();
      return;
    }
    // Connect-rate limit (sliding 1s window): bounds an unauthenticated connect
    // storm (DoS residual of the untrusted-pipe model). Uses Date.now via the
    // socket's own arrival — acceptable for a rate guard (not a determinism point).
    const nowMs = Date.now();
    this.connectTimestamps = this.connectTimestamps.filter((t) => nowMs - t < 1000);
    if (this.connectTimestamps.length >= this.connectRatePerSec) {
      socket.destroy();
      this.log('CONNECT_RATE_LIMIT refused a connection');
      this.metrics?.onRefusedRateLimit();
      return;
    }
    this.connectTimestamps.push(nowMs);
    this.seq += 1;
    const id = `conn-${this.seq}`;
    const decoder = new FrameDecoder();
    const entry: { socket: net.Socket; decoder: FrameDecoder; secure: SecureSession | null; handshakeTimer?: NodeJS.Timeout } = { socket, decoder, secure: null };
    this.conns.set(id, entry);
    socket.setTimeout(this.idleTimeoutMs);
    socket.on('timeout', () => this.closeConn(id, 'idle_timeout'));
    // Slow-loris bound (§3): a connection that never completes the secure
    // handshake is force-closed regardless of byte-trickle keeping the idle
    // timer alive. Cleared the moment the secure session is established.
    if (this.rootSecret) {
      entry.handshakeTimer = setTimeout(() => {
        const c = this.conns.get(id);
        if (c && !c.secure) { this.metrics?.onHandshakeTimedOut(); this.closeConn(id, 'handshake_timeout'); }
      }, this.handshakeTimeoutMs);
      if (typeof entry.handshakeTimer.unref === 'function') entry.handshakeTimer.unref();
    }

    socket.on('data', (chunk: Buffer) => {
      try {
        const before = decoder.bufferedBytes;
        let result = decoder.push(chunk);
        this.totalBuffered += decoder.bufferedBytes - before;
        if (this.totalBuffered > this.globalBudget) {
          throw new XBusError(XBusErrorCode.BUFFER_BUDGET_EXCEEDED, 'global buffer budget exceeded');
        }
        for (;;) {
          for (const payload of result.frames) this.dispatch(id, payload);
          if (!result.hasMore) break;
          result = decoder.continueDrain();
        }
      } catch (e) {
        const code = e instanceof XBusError ? e.code : XBusErrorCode.PROTOCOL_VIOLATION;
        this.log(`closing ${id}: ${code}`);
        this.closeConn(id, code);
      }
    });
    socket.on('close', () => this.closeConn(id, 'closed'));
    socket.on('error', (e) => this.log(`socket ${id} error: ${safeField(e.message)}`));
  }

  private dispatch(id: string, payload: unknown): void {
    const c = this.conns.get(id);
    if (!c) return;

    // Secure transport (XBUS-STP). When a root secret is configured, the FIRST
    // wire messages MUST be the handshake ({h:'ch'} then {h:'cf'}); ordinary
    // protocol frames before handshake completion are rejected (no plaintext
    // privileged fallback).
    if (this.rootSecret) {
      const p = payload as { h?: string; d?: string };
      if (!c.secure) {
        if (p && p.h === 'ch' && typeof p.d === 'string') return this.onClientHello(id, p.d);
        if (p && p.h === 'cf' && typeof p.d === 'string') return this.onClientFinish(id, p.d);
        // any non-handshake frame before the channel is established -> reject
        this.log(`closing ${id}: frame before secure handshake`);
        this.metrics?.onPreHandshakeRejected();
        this.closeConn(id, 'pre_handshake_frame');
        return;
      }
      // established: every frame is a sealed buffer {d:<base64>}
      try {
        const sealed = Buffer.from((payload as { d: string }).d, 'base64');
        const pt = c.secure.open(sealed);
        const frame = JSON.parse(pt.toString('utf8')) as Frame;
        this.deliverFrame(id, frame);
      } catch {
        this.metrics?.onSecureOpenFailed();
        this.closeConn(id, 'secure_open_failed'); // tamper/replay/reorder
      }
      return;
    }

    // Insecure mode (tests only): plaintext frames.
    this.deliverFrame(id, payload);
  }

  private onClientHello(id: string, b64: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    try {
      const hello = parseClientHello(Buffer.from(b64, 'base64'));
      const srv = serverHandshake(this.rootSecret!, this.brokerInstanceId, hello);
      c.pendingTh = srv.th;
      c.pendingKeys = srv.keys;
      c.connIdForSession = hello.connId;
      // server_hello as a raw binary buffer wrapped in {h:'sh'}
      c.socket.write(encodeFrame({ h: 'sh', d: srv.serverHelloBytes.toString('base64') }));
    } catch (e) {
      // Uniform: never reveal whether it was a bad secret vs bad format. The
      // metric mirrors the SAME two-way split the log already makes (proto vs the
      // single uniform auth_failed bucket) — no finer oracle than already exists.
      const proto = e instanceof ProtocolMismatch;
      this.log(`handshake ${id} failed: ${proto ? 'proto' : 'auth'}`);
      if (proto) this.metrics?.onHandshakeProtoMismatch(); else this.metrics?.onHandshakeAuthFailed();
      this.closeConn(id, 'handshake_failed');
    }
  }

  private onClientFinish(id: string, b64: string): void {
    const c = this.conns.get(id);
    if (!c || !c.pendingTh || !c.pendingKeys) { this.metrics?.onHandshakeAuthFailed(); this.closeConn(id, 'handshake_state'); return; }
    try {
      serverVerifyFinish(c.pendingKeys, c.pendingTh, Buffer.from(b64, 'base64'));
      // The connId is recovered from the client_hello earlier; re-derive from keys
      // context by storing it — we kept it in the hello parse. Use a fresh session
      // bound to the same keys; connId is needed for AAD, captured below.
      c.secure = new SecureSession(c.pendingKeys, c.connIdForSession!, 'server');
      delete c.pendingTh; delete c.pendingKeys;
      if (c.handshakeTimer) { clearTimeout(c.handshakeTimer); delete c.handshakeTimer; }
      this.metrics?.onHandshakeOk();
    } catch {
      this.metrics?.onHandshakeAuthFailed();
      this.closeConn(id, 'auth_failed'); // uniform
    }
  }

  private deliverFrame(id: string, frame: unknown): void {
    const conn = this.makeServerConn(id);
    if (!frame || typeof frame !== 'object' || typeof (frame as Frame).frameType !== 'string') {
      conn.send(this.errorFrame('XBUS_PROTOCOL_VIOLATION', 'malformed frame'));
      return;
    }
    this.onFrame(conn, frame as Frame);
  }

  private makeServerConn(id: string): ServerConn {
    return {
      id,
      send: (frame: Frame) => {
        const c = this.conns.get(id);
        if (!c) return;
        try {
          if (c.secure) {
            const sealed = c.secure.seal(Buffer.from(JSON.stringify(frame), 'utf8'));
            c.socket.write(encodeFrame({ d: sealed.toString('base64') }));
          } else {
            c.socket.write(encodeFrame(frame));
          }
        } catch (e) {
          this.log(`write ${id} failed: ${safeField((e as Error).message)}`);
        }
      },
      close: (reason?: string) => this.closeConn(id, reason ?? 'server_close'),
    };
  }

  private errorFrame(code: string, message: string): Frame {
    return { protocolVersion: 1, frameType: 'error', timestamp: new Date().toISOString(), payload: { code, message } };
  }

  private closeConn(id: string, reason: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    if (c.handshakeTimer) { clearTimeout(c.handshakeTimer); delete c.handshakeTimer; }
    this.totalBuffered -= c.decoder.bufferedBytes;
    if (this.totalBuffered < 0) this.totalBuffered = 0;
    try {
      c.socket.destroy();
    } catch {
      /* ignore */
    }
    this.conns.delete(id);
    this.onCloseConn(id);
    this.log(`conn ${id} closed: ${reason}`);
  }

  close(): Promise<void> {
    for (const id of [...this.conns.keys()]) this.closeConn(id, 'shutdown');
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
