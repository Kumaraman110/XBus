/**
 * BrokerFacade — the ONLY broker-facing surface an adapter is given (§11). It wraps
 * the EXISTING IpcClient so an adapter can never reach into src/broker/*,
 * src/database/*, the root secret, or the transport keys. Every method maps 1:1
 * onto an existing FrameType, so it adds NOTHING to the wire — `compatibilityId
 * xbus-p1-stp1-s5` is untouched.
 *
 * The facade is constructed by the SDK host (which owns the IpcClient + rootSecret),
 * NOT by the adapter. PR1 introduces the facade alongside the existing channel code;
 * no production caller is migrated yet (that is PR3).
 */

import type { IpcClient } from '../ipc/client.js';
import type { Frame } from '../protocol/commands.js';
import { AdapterError, AdapterErrorCode } from './errors.js';

/** A response unwrapper that turns a broker `error` frame into a typed AdapterError. */
function unwrap(frame: Frame, failCode: AdapterErrorCode): unknown {
  if (frame.frameType === 'error') {
    const p = (frame.payload ?? {}) as { code?: string; message?: string };
    throw new AdapterError(failCode, p.message ?? 'broker error', { brokerCode: p.code ?? 'unknown' });
  }
  return frame.payload;
}

export interface SessionRegistration { sessionId: string; receiveMode: string; capabilities?: string[] }
export interface OutboundMessage { to: string; text: string; [k: string]: unknown }
export interface AckCommand { injectionId: string; status: 'accepted' | 'rejected'; reason?: string }
export interface ReplyCommand { injectionId: string; text: string }

/** The stable broker surface. No SQLite/state/secret/key is reachable through it. */
export interface BrokerFacade {
  registerSession(reg: SessionRegistration): Promise<unknown>;
  registerAlias(alias: string): Promise<unknown>;
  send(msg: OutboundMessage): Promise<unknown>;
  /** Privileged hook pull — the SDK host binds it to the authenticated connection. */
  pullCheckpoint(req: { checkpointId: string; limit: number }): Promise<unknown>;
  inbox(req?: { limit?: number }): Promise<unknown>;
  redeliver(req: { messageId: string; reason?: string }): Promise<unknown>;
  acknowledge(a: AckCommand): Promise<unknown>;
  reply(r: ReplyCommand): Promise<unknown>;
  listSessions(): Promise<unknown>;
  signalReadiness(r: { ackAvailable: boolean; versionOk: boolean }): Promise<void>;
  getStatus(): Promise<unknown>;
  onShutdownNotice(cb: () => void): void;
  close(): void;
}

/**
 * Build a BrokerFacade over an already-connected, already-hello'd IpcClient. The
 * IpcClient (and the rootSecret it holds) stay private to the host that created it.
 * Each method is a thin, typed call to `client.request(<existing FrameType>, …)`.
 */
export function makeBrokerFacade(client: IpcClient): BrokerFacade {
  return {
    async registerSession(reg) {
      return unwrap(await client.request('register_session', reg), AdapterErrorCode.NOT_READY);
    },
    async registerAlias(alias) {
      return unwrap(await client.request('register_alias', { alias }), AdapterErrorCode.DELIVERY_FAILED);
    },
    async send(msg) {
      return unwrap(await client.request('send_message', msg), AdapterErrorCode.DELIVERY_FAILED);
    },
    async pullCheckpoint(req) {
      // hook_checkpoint receive leg. The broker derives identity from the
      // authenticated connection — the facade never lets a caller spoof a sessionId.
      return unwrap(await client.request('checkpoint_pull_hook', req), AdapterErrorCode.DELIVERY_FAILED);
    },
    async inbox(req) {
      return unwrap(await client.request('inbox', req ?? {}), AdapterErrorCode.DELIVERY_FAILED);
    },
    async redeliver(req) {
      return unwrap(await client.request('redeliver', req), AdapterErrorCode.DELIVERY_FAILED);
    },
    async acknowledge(a) {
      return unwrap(await client.request('ack_message', a), AdapterErrorCode.ACK_FAILED);
    },
    async reply(r) {
      return unwrap(await client.request('reply_message', r), AdapterErrorCode.REPLY_FAILED);
    },
    async listSessions() {
      return unwrap(await client.request('list_sessions', {}), AdapterErrorCode.DELIVERY_FAILED);
    },
    async signalReadiness(r) {
      await client.request('signal_readiness', r);
    },
    async getStatus() {
      return unwrap(await client.request('get_status', {}), AdapterErrorCode.HEALTH_FAILED);
    },
    onShutdownNotice(cb) {
      client.onPush((f: Frame) => { if (f.frameType === 'shutdown_notice') cb(); });
    },
    close() {
      client.close();
    },
  };
}
