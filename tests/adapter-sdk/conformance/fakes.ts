/**
 * Deterministic conformance fakes (§11). These live UNDER tests/ (never src/) so prod
 * code can never import them to mint evidence. They simulate a host runtime + a broker
 * facade WITHOUT any real process, model, or on-disk persistence.
 *
 * Determinism: a seeded id generator + a fixed clock — no Date.now / Math.random.
 */
import type { RuntimeEnv, AdapterIdentity } from '../../../src/adapter/context.js';
import type { BrokerFacade, AckCommand, ReplyCommand, OutboundMessage } from '../../../src/adapter/facade.js';

/** A deterministic clock + id source. */
export function makeDeterministic(seed = 0): { clock: { nowIso(): string }; ids: { next(): string } } {
  let t = 1_700_000_000_000 + seed * 1000;
  let n = seed * 1000;
  return {
    clock: { nowIso: () => new Date(t += 1000).toISOString() },
    ids: { next: () => `id-${++n}` },
  };
}

/** A sandboxed RuntimeEnv with scripted vars (never the real process.env). */
export function makeFakeEnv(vars: Record<string, string>, cwd = '/work', nowIso = () => '2026-01-01T00:00:00.000Z'): RuntimeEnv {
  return { get: (k) => vars[k], cwd, now: nowIso };
}

export interface FakeBrokerScript {
  /** Force the next facade call of this verb to return a broker error frame. */
  errorOn?: Partial<Record<keyof BrokerFacade, { code: string; message: string }>>;
  /** Simulate broker unavailability (all calls reject). */
  unavailable?: boolean;
}

/**
 * A FakeBrokerFacade implementing the BrokerFacade contract in-memory. It records
 * the verb calls + correlation, round-trips send/ack/reply, and can inject faults.
 * It proves CONTRACT conformance — NOT durability/reaper internals (those stay with
 * the real integration suite). It performs no real I/O and holds no secret.
 */
export class FakeBrokerFacade implements BrokerFacade {
  readonly calls: Array<{ verb: string; arg: unknown }> = [];
  private shutdownCbs: Array<() => void> = [];
  private registered = false;
  private pendingByInjection = new Map<string, { acked: boolean; replied: boolean }>();
  constructor(private script: FakeBrokerScript = {}) {}

  private guard<T>(verb: keyof BrokerFacade, arg: unknown, ok: () => T): Promise<T> {
    this.calls.push({ verb, arg });
    if (this.script.unavailable) return Promise.reject(new Error('broker unavailable'));
    const err = this.script.errorOn?.[verb];
    if (err) return Promise.reject(Object.assign(new Error(err.message), { code: err.code }));
    return Promise.resolve(ok());
  }
  registerSession(reg: { sessionId: string }): Promise<unknown> { return this.guard('registerSession', reg, () => { this.registered = true; return { sessionId: reg.sessionId, ok: true }; }); }
  registerAlias(alias: string): Promise<unknown> { return this.guard('registerAlias', alias, () => ({ alias, ok: true })); }
  send(msg: OutboundMessage): Promise<unknown> { return this.guard('send', msg, () => ({ messageId: 'm-1', state: 'queued' })); }
  pullCheckpoint(req: { checkpointId: string; limit: number }): Promise<unknown> {
    return this.guard('pullCheckpoint', req, () => {
      const inj = 'inj-1';
      this.pendingByInjection.set(inj, { acked: false, replied: false });
      return [{ injectionId: inj, messageId: 'm-1', body: 'PEER BODY', requiresAck: true }];
    });
  }
  inbox(req?: { limit?: number }): Promise<unknown> { return this.guard('inbox', req, () => ({ messages: [] })); }
  redeliver(req: { messageId: string }): Promise<unknown> { return this.guard('redeliver', req, () => ({ ok: true })); }
  acknowledge(a: AckCommand): Promise<unknown> { return this.guard('acknowledge', a, () => { const r = this.pendingByInjection.get(a.injectionId); if (r) r.acked = true; return { ok: true, injectionId: a.injectionId }; }); }
  reply(r: ReplyCommand): Promise<unknown> { return this.guard('reply', r, () => { const e = this.pendingByInjection.get(r.injectionId); if (e) e.replied = true; return { ok: true, replyId: 'r-1' }; }); }
  listSessions(): Promise<unknown> { return this.guard('listSessions', undefined, () => ({ sessions: [] })); }
  signalReadiness(r: { ackAvailable: boolean; versionOk: boolean }): Promise<void> { return this.guard('signalReadiness', r, () => undefined); }
  getStatus(): Promise<unknown> { return this.guard('getStatus', undefined, () => ({ ok: this.registered })); }
  onShutdownNotice(cb: () => void): void { this.shutdownCbs.push(cb); }
  close(): void { this.calls.push({ verb: 'close', arg: undefined }); }

  // test helpers
  fireShutdown(): void { for (const cb of this.shutdownCbs) cb(); }
  ackState(injectionId: string): { acked: boolean; replied: boolean } | undefined { return this.pendingByInjection.get(injectionId); }
  verbs(): string[] { return this.calls.map((c) => c.verb); }
}

/** A scripted identity source for the fake host. */
export function makeIdentitySource(id: AdapterIdentity | null) {
  return {
    resolve(_env: RuntimeEnv): Promise<AdapterIdentity> {
      if (!id) return Promise.reject(new Error('IDENTITY_UNRESOLVED'));
      return Promise.resolve(id);
    },
  };
}
