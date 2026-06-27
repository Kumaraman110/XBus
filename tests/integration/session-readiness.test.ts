/**
 * §2 — explicit session readiness. A registered-but-initializing session must
 * not be injected a request it cannot yet acknowledge. These tests pin the
 * readiness state machine and the races around it (send-before-ready,
 * become-ready-then-deliver, supersede-resets-readiness, degraded paths).
 *
 * Uses BrokerStore + DeliveryOps directly with a FakeClock so the
 * "while initializing" invariants (no injection, no attempt, no ack timer) are
 * observable in the DB without timing flakiness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { resolveReadiness } from '../../src/broker/readiness.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let clock: FakeClock;
const A = 'aaaa1111-0000-4000-8000-00000000000a';
const B = 'bbbb1111-0000-4000-8000-00000000000b';

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ready-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('r');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids);
}
function regA(): SessionAuthority {
  const a = store.register({ sessionId: A, instanceId: 'iA', connectionId: 'cA', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
  store.registerAlias(a, 'architect');
  return a;
}
function regB(caps: string[] = ['ack', 'reply']): SessionAuthority {
  const b = store.register({ sessionId: B, instanceId: 'iB', connectionId: 'cB', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: caps, role: 'mcp' });
  store.registerAlias(b, 'implementer');
  return b;
}
function send(a: SessionAuthority): string {
  return store.send(a, { to: 'implementer', text: 'REQ-BODY', kind: 'request', requiresAck: true, requiresReply: true }).messageId;
}
function deliveryState(messageId: string): string {
  return (db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(messageId) as { state: string }).state;
}
function injectionCount(messageId: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=?').get(messageId) as { n: number }).n;
}

beforeEach(setup);
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('§2 session readiness model', () => {
  it('1: a freshly-registered session is `initializing`, not ready', () => {
    regB();
    expect(store.readinessOf(B)).toBe('initializing');
  });

  it('2: an explicit readiness signal moves Bedrock hook_checkpoint -> ready_checkpoint', () => {
    const b = regB();
    const r = store.signalReadiness(b, { ackAvailable: true, versionOk: true });
    expect(r.readiness).toBe('ready_checkpoint');
    expect(store.readinessOf(B)).toBe('ready_checkpoint');
  });

  it('3: while initializing, a send is persisted but NOT injected; no attempt, no ack timer', () => {
    const a = regA();
    const b = regB();
    const messageId = send(a);
    // Persisted + still queued.
    expect(deliveryState(messageId)).toBe('queued');
    // A checkpoint pull while initializing injects NOTHING.
    const pulled = delivery.checkpointPull({ ...b, role: 'hook' as never }, 'cp1', 10);
    expect(pulled).toHaveLength(0);
    expect(injectionCount(messageId)).toBe(0); // no injection
    expect(deliveryState(messageId)).toBe('queued'); // still queued, not transport_written
    const d = db.prepare('SELECT attempt, transport_written_at, lease_expires_at FROM deliveries WHERE message_id=?').get(messageId) as { attempt: number; transport_written_at: string | null; lease_expires_at: string | null };
    expect(d.attempt).toBe(0); // no attempt consumed
    expect(d.transport_written_at).toBeNull(); // no ack timer armed
    expect(d.lease_expires_at).toBeNull();
  });

  it('4: send to an initializing receiver does not error — it queues durably', () => {
    const a = regA();
    regB(); // B initializing
    const res = store.send(a, { to: 'implementer', text: 'x', kind: 'request', requiresAck: true, requiresReply: false });
    expect(res.messageId).toBeTruthy();
    expect(res.deduplicated).toBe(false);
  });

  it('5: race — message sent BEFORE ready is delivered AFTER the readiness signal', () => {
    const a = regA();
    const b = regB();
    const messageId = send(a); // arrives while initializing
    expect(delivery.checkpointPull({ ...b, role: 'hook' as never }, 'cp-early', 10)).toHaveLength(0);
    // Now B signals readiness; the SAME message becomes deliverable.
    store.signalReadiness(b, { ackAvailable: true, versionOk: true });
    const pulled = delivery.checkpointPull({ ...b, role: 'hook' as never }, 'cp-late', 10);
    expect(pulled).toHaveLength(1);
    expect(pulled[0]!.messageId).toBe(messageId);
    expect(injectionCount(messageId)).toBe(1); // injected exactly once, after ready
  });

  it('6: a receiver that cannot ack lands in degraded_ack_unavailable and is NOT injected', () => {
    const a = regA();
    const b = regB([]); // no ack capability declared
    const r = store.signalReadiness(b, { ackAvailable: false, versionOk: true });
    expect(r.readiness).toBe('degraded_ack_unavailable');
    const messageId = send(a);
    expect(delivery.checkpointPull({ ...b, role: 'hook' as never }, 'cp1', 10)).toHaveLength(0);
    expect(injectionCount(messageId)).toBe(0); // degraded => not injected (§2 invariant)
  });

  it('7: hook-unavailable for a hook_checkpoint session => degraded_hook_unavailable, not injected', () => {
    const a = regA();
    const b = regB();
    const r = store.signalReadiness(b, { ackAvailable: true, hookAvailable: false, versionOk: true });
    expect(r.readiness).toBe('degraded_hook_unavailable');
    const messageId = send(a);
    expect(delivery.checkpointPull({ ...b, role: 'hook' as never }, 'cp1', 10)).toHaveLength(0);
    expect(injectionCount(messageId)).toBe(0);
  });

  it('8: an incompatible version signal beats every other hint', () => {
    const b = regB();
    const r = store.signalReadiness(b, { ackAvailable: true, hookAvailable: true, versionOk: false });
    expect(r.readiness).toBe('incompatible');
    expect(store.readinessOf(B)).toBe('incompatible');
  });

  it('9: a supersede (new epoch) RESETS readiness to initializing — no stale-ready injection', () => {
    const a = regA();
    const b1 = regB();
    store.signalReadiness(b1, { ackAvailable: true, versionOk: true });
    expect(store.readinessOf(B)).toBe('ready_checkpoint');
    // New owner takes over the session (genuine supersede => new epoch).
    const b2 = store.register({ sessionId: B, instanceId: 'iB2', connectionId: 'cB2', processId: 3, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', supersede: true });
    expect(store.readinessOf(B)).toBe('initializing'); // reset — must re-signal
    const messageId = send(a);
    expect(delivery.checkpointPull({ ...b2, role: 'hook' as never }, 'cp1', 10)).toHaveLength(0); // new epoch not ready
    expect(injectionCount(messageId)).toBe(0);
    // Old authority's readiness signal must NOT move the new epoch.
    expect(() => store.signalReadiness(b1, { ackAvailable: true, versionOk: true })).toThrow();
  });

  it('10: readiness is reported SEPARATELY from connection state and receive mode', () => {
    const b = regB();
    store.signalReadiness(b, { ackAvailable: true, versionOk: true });
    const row = db.prepare('SELECT state AS connection, receive_mode, readiness FROM sessions WHERE session_id=?').get(B) as { connection: string; receive_mode: string; readiness: string };
    expect(row.connection).toBe('connected');         // connection state
    expect(row.receive_mode).toBe('hook_checkpoint');  // how it takes delivery
    expect(row.readiness).toBe('ready_checkpoint');    // whether it's SAFE to inject
    // The three are distinct dimensions, each set independently.
    expect(row.connection).not.toBe(row.readiness);
  });

  it('resolveReadiness is a pure derivation (no I/O) and never trusts a bare "ready"', () => {
    expect(resolveReadiness({ receiveMode: 'hook_checkpoint', capabilities: ['ack'], hints: {} })).toBe('ready_checkpoint');
    expect(resolveReadiness({ receiveMode: 'hook_checkpoint', capabilities: [], hints: {} })).toBe('degraded_ack_unavailable');
    expect(resolveReadiness({ receiveMode: 'live_push', capabilities: ['ack'], hints: { live: true } })).toBe('ready_live');
    expect(resolveReadiness({ receiveMode: 'hook_checkpoint', capabilities: ['ack'], hints: { versionOk: false } })).toBe('incompatible');
  });
});

describe('§2 — process_next honors the readiness gate', () => {
  it('process_next does NOT inject while initializing (no transport_written, no ack timer)', () => {
    const a = regA();
    const b = regB(); // initializing — never signalled
    const messageId = send(a);
    const got = delivery.processNext({ ...b, role: 'hook' as never }, 'pn1');
    expect(got).toHaveLength(0);
    expect(injectionCount(messageId)).toBe(0);
    expect(deliveryState(messageId)).toBe('queued');
    const d = db.prepare('SELECT transport_written_at, lease_expires_at, attempt FROM deliveries WHERE message_id=?').get(messageId) as { transport_written_at: string | null; lease_expires_at: string | null; attempt: number };
    expect(d.transport_written_at).toBeNull(); // no ack timer armed
    expect(d.lease_expires_at).toBeNull();
    expect(d.attempt).toBe(0);
  });

  it('process_next DOES inject once the session is ready_checkpoint', () => {
    const a = regA();
    const b = regB();
    store.signalReadiness(b, { ackAvailable: true, versionOk: true });
    const messageId = send(a);
    const got = delivery.processNext({ ...b, role: 'hook' as never }, 'pn1');
    expect(got).toHaveLength(1);
    expect(injectionCount(messageId)).toBe(1);
    expect(deliveryState(messageId)).toBe('transport_written');
  });

  it('process_next does NOT inject to a degraded_ack_unavailable receiver', () => {
    const a = regA();
    const b = regB([]);
    store.signalReadiness(b, { ackAvailable: false, versionOk: true }); // degraded_ack_unavailable
    const messageId = send(a);
    expect(delivery.processNext({ ...b, role: 'hook' as never }, 'pn1')).toHaveLength(0);
    expect(injectionCount(messageId)).toBe(0);
  });

  it('process_next rejects a stale epoch (superseded owner cannot single-step)', () => {
    const a = regA();
    const b1 = regB();
    store.signalReadiness(b1, { ackAvailable: true, versionOk: true });
    // New owner supersedes; b1 is now a stale epoch.
    store.register({ sessionId: B, instanceId: 'iB2', connectionId: 'cB2', processId: 3, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', supersede: true });
    send(a);
    expect(() => delivery.processNext({ ...b1, role: 'hook' as never }, 'pn1')).toThrow(); // EPOCH_MISMATCH
  });
});
