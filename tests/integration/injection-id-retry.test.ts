/**
 * Regression: a NORMAL automatic checkpoint must never re-present a message body,
 * and must never return a checkpoint message without a valid injection id.
 *
 * Real failure shape (independent review of the non-ack fix):
 *   1. ack-required message → first checkpoint injects it (logical injection #1,
 *      body + valid injection id).
 *   2. ACK deadline passes → reaper requeues transport_written → retry_wait.
 *   3. a later NORMAL checkpoint re-selects the message (retry_wait is injectable),
 *      re-marks it transport_written, and `ReceiptStore.issue()` returns null
 *      (logical #1 already exists for this epoch — the at-most-once guard), yet the
 *      OLD code still pushed the full body. The model received an automatically
 *      repeated body with NO injection id.
 *
 * This is a Layer-3 violation (docs/delivery-semantics.md §"Layer 3"): no normal
 * path — repeated checkpoint pull, reconnect, or broker restart — may repeat a
 * body; only explicit redelivery may, and it allocates the next logical injection
 * number and returns a valid id.
 *
 * Driven with a FakeClock so deadlines are deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps, INJECTION_METADATA_KEY, type PendingMessage } from '../../src/broker/delivery.js';
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let reaper: Reaper; let clock: FakeClock;
const A = 'aaaa4444-0000-4000-8000-00000000000a';
const B = 'bbbb4444-0000-4000-8000-00000000000b';
const ACK_DEADLINE_MS = 5 * 60_000;

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-injid-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('m');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids, ACK_DEADLINE_MS);
  reaper = new Reaper(db, clock, ids, { backoff: { initialDelayMs: 1000, maxDelayMs: 60_000, maxAttempts: 5, factor: 2 }, rng: () => 1 });
}
function pair(): { authA: SessionAuthority; authB: SessionAuthority } {
  const authA = store.register({ sessionId: A, instanceId: 'iA', connectionId: 'cA', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
  store.registerAlias(authA, 'architect');
  const authB = store.register({ sessionId: B, instanceId: 'iB', connectionId: 'cB', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
  store.registerAlias(authB, 'implementer');
  store.signalReadiness(authA, { ackAvailable: true, versionOk: true });
  store.signalReadiness(authB, { ackAvailable: true, versionOk: true });
  return { authA, authB };
}
function hookAuth(a: SessionAuthority): SessionAuthority { return { ...a, role: 'hook' as never }; }
function mcpAuth(a: SessionAuthority): SessionAuthority { return { ...a, role: 'mcp' as never }; }
function logicalRows(messageId: string): number[] {
  return (db.prepare('SELECT logical_injection_number n FROM context_injections WHERE message_id=? ORDER BY logical_injection_number ASC').all(messageId) as Array<{ n: number }>).map((r) => r.n);
}
function stateOf(messageId: string): string {
  return (db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(messageId) as { state: string }).state;
}
/** A returned checkpoint message that carries a full body. */
function hasBody(m: PendingMessage): boolean { return typeof m.text === 'string' && m.text.length > 0; }
function injId(m: PendingMessage): string | undefined { return m.metadata?.[INJECTION_METADATA_KEY]; }

beforeEach(() => setup());
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('injection-id retry invariant (Layer 3)', () => {
  it('ack-required message is never re-presented (body+id) by a normal checkpoint after ack-timeout requeue', () => {
    const { authA, authB } = pair();
    const messageId = store.send(authA, { to: 'implementer', text: 'NEED-ACK-BODY', kind: 'request', requiresAck: true, requiresReply: false }).messageId;

    // 1) First normal checkpoint: body + valid id + logical injection #1.
    const first = delivery.checkpointPull(hookAuth(authB), 'cp1', 10);
    expect(first).toHaveLength(1);
    expect(hasBody(first[0]!)).toBe(true);
    const firstId = injId(first[0]!);
    expect(firstId, 'first injection has a valid id').toBeTruthy();
    expect(logicalRows(messageId)).toEqual([1]);
    expect(stateOf(messageId)).toBe('transport_written');

    // 2) ACK deadline passes → reaper requeues to retry_wait (existing policy).
    clock.advance(ACK_DEADLINE_MS + 1000);
    expect(reaper.sweep().ackTimedOut).toBe(1);
    expect(stateOf(messageId)).toBe('retry_wait');

    // 3) Later NORMAL checkpoints in the same epoch must NOT re-present the body
    //    and must NEVER return a checkpoint message with an empty/null injection id.
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000); // clear any backoff window
      const again = delivery.checkpointPull(hookAuth(authB), `cp-again-${i}`, 10);
      for (const m of again) {
        if (m.messageId !== messageId) continue;
        // THE INVARIANT: a normal automatic checkpoint result either does not
        // include this message at all, or — if it must reference it — never
        // includes the body again and never carries an empty injection id.
        expect(hasBody(m), 'normal checkpoint must not repeat the body').toBe(false);
        expect(injId(m) && injId(m)!.length > 0, 'no empty injection id in a normal checkpoint result').toBe(true);
      }
      // and no second logical injection row was created automatically.
      expect(logicalRows(messageId)).toEqual([1]);
    }

    // 4) The recipient can still ACK using the ORIGINAL injection record.
    //    (requireReceipt is off in this harness; authorize via the recorded
    //     injection to prove the original record still validates.)
    const ackRes = delivery.ack(mcpAuth(authB), { messageId, status: 'accepted', injectionId: firstId });
    expect(ackRes.duplicate).toBe(false);
    expect(['accepted']).toContain(ackRes.state);

    // 5) Explicit redelivery remains the ONLY body re-presentation: new logical
    //    number, valid id, audited.
    const red = delivery.redeliver(mcpAuth(authB), messageId, 'manual recheck');
    expect(red, 'redeliver returns an entry').toBeTruthy();
    expect(red!.bodyIncluded).toBe(true);
    expect(red!.text).toBe('NEED-ACK-BODY');
    expect(red!.injectionId && red!.injectionId.length > 0).toBe(true);
    expect(logicalRows(messageId)).toEqual([1, 2]);
    expect((db.prepare("SELECT COUNT(*) n FROM audit_events WHERE message_id=? AND event_type='EXPLICIT_REDELIVERY'").get(messageId) as { n: number }).n).toBe(1);
  });

  it('survives a DB reopen between requeue and the later checkpoint (no resurrected body)', () => {
    const { authA, authB } = pair();
    const messageId = store.send(authA, { to: 'implementer', text: 'RESTART-BODY', kind: 'request', requiresAck: true, requiresReply: false }).messageId;
    const first = delivery.checkpointPull(hookAuth(authB), 'cp1', 10);
    expect(injId(first[0]!)).toBeTruthy();
    clock.advance(ACK_DEADLINE_MS + 1000);
    reaper.sweep();
    expect(stateOf(messageId)).toBe('retry_wait');

    // Reopen the DB (broker restart) and rebuild the ops against the same file.
    const dbPath = path.join(dir, 'x.sqlite');
    db.close();
    db = openDatabase(dbPath, { applyPragmas: true });
    const ids2 = new SeqIdGen('m2');
    const delivery2 = new DeliveryOps(db, clock, ids2, ACK_DEADLINE_MS);

    clock.advance(60_000);
    const again = delivery2.checkpointPull(hookAuth(authB), 'cp-after-restart', 10);
    for (const m of again) {
      if (m.messageId !== messageId) continue;
      expect(hasBody(m)).toBe(false);
      expect(injId(m) && injId(m)!.length > 0).toBe(true);
    }
    expect(logicalRows(messageId)).toEqual([1]);
  });
});
