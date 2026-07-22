/**
 * BETA.11 (ADR 0038) — RED-first integration: the OUTWARD routing class + sender-facing delivery
 * signal, exercised over a real BrokerStore + DeliveryOps + the dashboard read-model, with a
 * FakeClock. Pins the operator's load-bearing assertions on the SURFACES (not just the pure fn):
 *
 *   #3  a stored (queued) message is NOT reported delivered/injected
 *   #9  a delay-tolerant message still queues durably (unchanged success)
 *   #14 dashboard routingClass == a direct derivation over the SAME DB row (parity; anti-vacuous)
 *   +   the LIVE bug: a DISCONNECTED session with stale readiness='ready_checkpoint' is `unavailable`
 *       on the dashboard surface, never advertised as routable.
 *
 * HOSTED_SAFE: in-process store + temp SQLite, OS-agnostic, no broker spawn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { DashboardReadModel } from '../../src/broker/dashboard/read-model.js';
import { deriveRoutingClass, deriveDeliverySignal, type Readiness } from '../../src/broker/routing-class.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let clock: FakeClock; let rm: DashboardReadModel;
const A = 'aaaa2222-0000-4000-8000-00000000000a';
const B = 'bbbb2222-0000-4000-8000-00000000000b';

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-routing-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('r');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids);
  rm = new DashboardReadModel(db);
}
function regA(): SessionAuthority {
  const a = store.register({ sessionId: A, instanceId: 'iA', connectionId: 'cA', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
  store.registerAlias(a, 'sender-a');
  return a;
}
function regB(): SessionAuthority {
  const b = store.register({ sessionId: B, instanceId: 'iB', connectionId: 'cB', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
  store.registerAlias(b, 'recipient-b');
  return b;
}
/** The dashboard read-model's routingClass for a session id (undefined if not present/hidden). */
function dashRoutingClass(sid: string): string | undefined {
  return rm.sessions().find((s) => s.sessionId === sid)?.routingClass;
}
function dashRoutable(sid: string): boolean | undefined {
  return rm.sessions().find((s) => s.sessionId === sid)?.autonomouslyRoutable;
}

beforeEach(setup);
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('routing honesty — dashboard surface derives the OUTWARD routing class', () => {
  it('a connected ready_checkpoint recipient with NO proven wake reads degraded_checkpoint_only, NOT routable (#1/#2)', () => {
    const b = regB();
    store.signalReadiness(b, { ackAvailable: true, versionOk: true }); // → ready_checkpoint
    // connected + ready_checkpoint + no host wake-probe on the read handle → degraded_checkpoint_only.
    expect(dashRoutingClass(B)).toBe('degraded_checkpoint_only');
    expect(dashRoutable(B)).toBe(false);
  });

  it('THE LIVE BUG: a DISCONNECTED session with stale readiness=ready_checkpoint is `unavailable` on the surface', () => {
    const b = regB();
    store.signalReadiness(b, { ackAvailable: true, versionOk: true });
    // Simulate the observed state: socket dropped (state='disconnected') but readiness left stale.
    db.prepare("UPDATE sessions SET state='disconnected' WHERE session_id=?").run(B);
    expect(store.readinessOf(B)).toBe('ready_checkpoint'); // stale readiness, exactly as observed live
    expect(dashRoutingClass(B)).toBe('unavailable');       // but the honest surface says unavailable
    expect(dashRoutable(B)).toBe(false);
  });

  it('#14 parity: dashboard routingClass == a direct deriveRoutingClass over the SAME DB row', () => {
    const b = regB();
    store.signalReadiness(b, { ackAvailable: true, versionOk: true });
    // Read the row the same way both surfaces do, and derive directly.
    const row = db.prepare('SELECT state, readiness, expired_at FROM sessions WHERE session_id=?').get(B) as { state: string; readiness: string; expired_at: string | null };
    const direct = deriveRoutingClass({
      readiness: row.readiness as Readiness, receiveMode: '', connectionState: row.state,
      expired: row.expired_at !== null, autoDeliveryEnabled: true, receiveControl: 'active',
    });
    expect(dashRoutingClass(B)).toBe(direct);
    // And after a disconnect, still equal (the parity guard's real value is catching input drift).
    db.prepare("UPDATE sessions SET state='disconnected' WHERE session_id=?").run(B);
    const row2 = db.prepare('SELECT state, readiness, expired_at FROM sessions WHERE session_id=?').get(B) as { state: string; readiness: string; expired_at: string | null };
    const direct2 = deriveRoutingClass({ readiness: row2.readiness as Readiness, receiveMode: '', connectionState: row2.state, expired: row2.expired_at !== null, autoDeliveryEnabled: true, receiveControl: 'active' });
    expect(dashRoutingClass(B)).toBe(direct2);
  });
});

describe('delivery honesty — queued is never "delivered"; delay-tolerant still queues (#3/#9)', () => {
  it('#3 a freshly-sent message is durably QUEUED and its delivery signal is "queued", not injected', () => {
    const a = regA(); regB();
    const r = store.send(a, { to: 'recipient-b', text: 'REQ', kind: 'request', requiresAck: true, requiresReply: true });
    const state = (db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(r.messageId) as { state: string }).state;
    expect(state).toBe('queued');
    // No wake attempt recorded yet → honest signal is plain "queued".
    expect(deriveDeliverySignal('queued', store.latestWakeOutcome(r.messageId))).toBe('queued');
  });

  it('#9 a delay-tolerant send still returns a durable messageId (success semantics preserved)', () => {
    const a = regA(); regB();
    const r = store.send(a, { to: 'recipient-b', text: 'later', kind: 'event', requiresAck: false, requiresReply: false });
    expect(r.messageId).toBeTruthy();
    expect((db.prepare('SELECT COUNT(*) n FROM deliveries WHERE message_id=?').get(r.messageId) as { n: number }).n).toBe(1);
  });

  it('#4/#5 a recorded wake attempt is reflected in the sender-facing signal (queued → wake_requested → wake_failed)', () => {
    const a = regA(); regB();
    const r = store.send(a, { to: 'recipient-b', text: 'REQ', kind: 'request', requiresAck: true, requiresReply: true });
    expect(deriveDeliverySignal('queued', store.latestWakeOutcome(r.messageId))).toBe('queued');
    store.recordWakeAttempt(r.messageId, B, 'requested');
    expect(deriveDeliverySignal('queued', store.latestWakeOutcome(r.messageId))).toBe('wake_requested');
    store.recordWakeAttempt(r.messageId, B, 'failed', 'no proven host wake path');
    expect(deriveDeliverySignal('queued', store.latestWakeOutcome(r.messageId))).toBe('wake_failed');
    // The latest outcome wins (ordered by monotonic audit_id).
    expect(store.latestWakeOutcome(r.messageId)).toBe('failed');
  });

  it('#12 wake intent + outcome survive a DB reopen (broker restart) with no schema change', () => {
    const a = regA(); regB();
    const r = store.send(a, { to: 'recipient-b', text: 'REQ', kind: 'request', requiresAck: true, requiresReply: true });
    store.recordWakeAttempt(r.messageId, B, 'requested');
    const dbPath = path.join(dir, 'x.sqlite');
    db.close();
    // Reopen the SAME file — a broker restart. The durable queue AND the wake record must survive.
    db = openDatabase(dbPath, { applyPragmas: true });
    const store2 = new BrokerStore(db, clock, new SeqIdGen('r2'), 'b');
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(r.messageId) as { state: string }).state).toBe('queued');
    expect(store2.latestWakeOutcome(r.messageId)).toBe('requested');
  });
});
