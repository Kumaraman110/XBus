/**
 * Regression: ACK-timeout redelivery must NEVER touch a message that does not
 * require an ack.
 *
 * Real acceptance failure (evidence db 1BF0B754…): a reply message with
 * requires_ack=0 / requires_reply=0 was delivered once, then the reaper applied
 * ACK_TIMEOUT_REQUEUE after the (wrongly-armed) deadline and the body reappeared
 * at later checkpoints — with no injection id, because the at-most-once injection
 * guard blocked a second logical injection #1.
 *
 * Root cause: reaper.reapAckTimeouts() selected every transport_written delivery
 * with a lease_expires_at, ignoring messages.requires_ack; and the injection paths
 * armed lease_expires_at for ALL messages. Fix: only ack-required messages get an
 * ack deadline / ack-timeout processing, and a no-ack/no-reply message completes
 * the moment its body reaches the checkpoint.
 *
 * Driven with a FakeClock so every deadline is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps, INJECTION_METADATA_KEY } from '../../src/broker/delivery.js';
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let reaper: Reaper; let clock: FakeClock;
const A = 'aaaa3333-0000-4000-8000-00000000000a';
const B = 'bbbb3333-0000-4000-8000-00000000000b';
const ACK_DEADLINE_MS = 5 * 60_000;

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-nack-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('m');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids, ACK_DEADLINE_MS);
  reaper = new Reaper(db, clock, ids, { backoff: { initialDelayMs: 1000, maxDelayMs: 60_000, maxAttempts: 3, factor: 2 }, rng: () => 1 });
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
function hookAuth(authB: SessionAuthority): SessionAuthority { return { ...authB, role: 'hook' as never }; }
function allocSeq(recipientSessionId: string): number {
  const row = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(recipientSessionId) as { next_sequence: number } | undefined;
  const seq = row ? row.next_sequence : 1;
  db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(recipientSessionId, seq + 1);
  return seq;
}
function deliveryRow(messageId: string) {
  return db.prepare('SELECT state, lease_expires_at, application_completed_at, attempt_ack_timeout, next_attempt_at, failure_category FROM deliveries WHERE message_id=?').get(messageId) as { state: string; lease_expires_at: string | null; application_completed_at: string | null; attempt_ack_timeout: number; next_attempt_at: string | null; failure_category: string | null };
}
function injectionCount(messageId: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=?').get(messageId) as { n: number }).n;
}
function transportWrites(messageId: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM transport_write_log WHERE message_id=?').get(messageId) as { n: number }).n;
}
function auditCount(messageId: string, type: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM audit_events WHERE message_id=? AND event_type=?').get(messageId, type) as { n: number }).n;
}

beforeEach(() => setup());
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('non-ack redelivery regression', () => {
  // 1. Fire-and-forget (no ack, no reply): completed on injection; reaper inert.
  it('1. fire-and-forget completes on injection and is never redelivered', () => {
    const { authA, authB } = pair();
    const messageId = store.send(authA, { to: 'implementer', text: 'EVENT-1', kind: 'event', requiresAck: false, requiresReply: false }).messageId;

    const pulled = delivery.checkpointPull(hookAuth(authB), 'cp1', 10);
    expect(pulled).toHaveLength(1);                 // body returned exactly once
    expect(pulled[0]!.messageId).toBe(messageId);

    const d = deliveryRow(messageId);
    expect(d.state).toBe('completed');              // terminal immediately
    expect(d.application_completed_at).not.toBeNull();
    expect(d.lease_expires_at).toBeNull();          // no ack timer armed
    expect(injectionCount(messageId)).toBe(1);      // exactly one injection
    expect(transportWrites(messageId)).toBe(1);
    expect(auditCount(messageId, 'DELIVERY_COMPLETED_NO_RESPONSE_REQUIRED')).toBe(1);

    // A later checkpoint returns nothing (already terminal).
    expect(delivery.checkpointPull(hookAuth(authB), 'cp2', 10)).toHaveLength(0);

    // Advance PAST the would-be ack deadline and sweep repeatedly: no requeue,
    // no dead-letter, no extra transport write, no extra injection, state stable.
    clock.advance(ACK_DEADLINE_MS + 60_000);
    const s1 = reaper.sweep();
    const s2 = reaper.sweep();
    expect(s1.ackTimedOut + s2.ackTimedOut).toBe(0);
    expect(s1.deadLettered + s2.deadLettered).toBe(0);
    expect(deliveryRow(messageId).attempt_ack_timeout).toBe(0);
    expect(auditCount(messageId, 'ACK_TIMEOUT_REQUEUE')).toBe(0);
    expect(transportWrites(messageId)).toBe(1);
    expect(injectionCount(messageId)).toBe(1);
    expect(deliveryRow(messageId).state).toBe('completed');
  });

  // 2. The exact real failure shape: a reply, no ack, no reply-required.
  it('2. reply message (no ack, no reply) stays completed across checkpoints, deadline, and sweeps', () => {
    const { authA, authB } = pair();
    // Send a request so the recipient can reply (the reply is the message under test).
    const reqId = store.send(authA, { to: 'implementer', text: 'PING', kind: 'request', requiresAck: false, requiresReply: true }).messageId;
    delivery.checkpointPull(hookAuth(authB), 'cp-req', 10);
    const replyRes = delivery.reply(authB, { messageId: reqId, text: 'ALPHA-REPLY-001', outcome: 'completed' }, allocSeq);
    const replyId = replyRes.replyMessageId;
    // The reply is addressed back to A. Verify its message-level contract matches
    // the evidence: kind=reply, requires_ack=0, requires_reply=0.
    const rm = db.prepare('SELECT kind, requires_ack, requires_reply FROM messages WHERE message_id=?').get(replyId) as { kind: string; requires_ack: number; requires_reply: number };
    expect(rm).toMatchObject({ kind: 'reply', requires_ack: 0, requires_reply: 0 });

    // A pulls its reply at a checkpoint — delivered once, completed, no timer.
    const pulled = delivery.checkpointPull(hookAuth(authA), 'cp-reply', 10);
    const got = pulled.find((m) => m.messageId === replyId);
    expect(got, 'reply body delivered once').toBeTruthy();
    expect(deliveryRow(replyId).state).toBe('completed');
    expect(deliveryRow(replyId).lease_expires_at).toBeNull();

    // Across many later checkpoints + deadline + sweeps: stays completed, never
    // re-presented, never ack-timed-out.
    for (let i = 0; i < 3; i++) {
      clock.advance(ACK_DEADLINE_MS + 1000);
      const s = reaper.sweep();
      expect(s.ackTimedOut).toBe(0);
      expect(s.deadLettered).toBe(0);
      expect(delivery.checkpointPull(hookAuth(authA), `cp-late-${i}`, 10).find((m) => m.messageId === replyId)).toBeUndefined();
    }
    expect(deliveryRow(replyId).state).toBe('completed');
    expect(transportWrites(replyId)).toBe(1);
    expect(injectionCount(replyId)).toBe(1);
    expect(auditCount(replyId, 'ACK_TIMEOUT_REQUEUE')).toBe(0);

    // Restart simulation: reopen the DB and re-run a sweep — still terminal, still once.
    const dbPath = path.join(dir, 'x.sqlite');
    db.close();
    db = openDatabase(dbPath, { applyPragmas: true });
    const ids2 = new SeqIdGen('m2');
    const reaper2 = new Reaper(db, clock, ids2, { backoff: { initialDelayMs: 1000, maxDelayMs: 60_000, maxAttempts: 3, factor: 2 }, rng: () => 1 });
    clock.advance(ACK_DEADLINE_MS + 1000);
    const sr = reaper2.sweep();
    expect(sr.ackTimedOut).toBe(0);
    expect(deliveryRow(replyId).state).toBe('completed');
    expect(transportWrites(replyId)).toBe(1);
  });

  // 3. No-ack but reply-required: injected, no ack timer, reaper ignores, reply completes.
  it('3. no-ack/reply-required is injected without an ack timer, ignored by the reaper, and completed by a reply', () => {
    const { authA, authB } = pair();
    const messageId = store.send(authA, { to: 'implementer', text: 'PLEASE-REPLY', kind: 'request', requiresAck: false, requiresReply: true }).messageId;

    const pulled = delivery.checkpointPull(hookAuth(authB), 'cp1', 10);
    expect(pulled).toHaveLength(1);
    const d = deliveryRow(messageId);
    expect(d.state).toBe('transport_written');      // NOT auto-completed (reply pending)
    expect(d.lease_expires_at).toBeNull();          // NO ack timer armed

    // Reaper ignores it forever (no ack required).
    clock.advance(ACK_DEADLINE_MS + 120_000);
    const s = reaper.sweep();
    expect(s.ackTimedOut).toBe(0);
    expect(s.deadLettered).toBe(0);
    expect(deliveryRow(messageId).state).toBe('transport_written');
    // Not automatically redelivered.
    expect(delivery.checkpointPull(hookAuth(authB), 'cp2', 10).find((m) => m.messageId === messageId)).toBeUndefined();
    expect(transportWrites(messageId)).toBe(1);

    // A correlated reply completes the original delivery via the existing path.
    const rep = delivery.reply(authB, { messageId, text: 'HERE-IS-MY-REPLY', outcome: 'completed' }, allocSeq);
    expect(rep.correlationId).toBeTruthy();
    expect(deliveryRow(messageId).state).toBe('completed');
  });

  // 4. Existing ACK behavior is retained.
  it('4. ack-required still arms a deadline, requeues on timeout, increments, and dead-letters', () => {
    const { authA, authB } = pair();
    const messageId = store.send(authA, { to: 'implementer', text: 'NEED-ACK', kind: 'request', requiresAck: true, requiresReply: false }).messageId;

    delivery.checkpointPull(hookAuth(authB), 'cp1', 10);
    expect(deliveryRow(messageId).lease_expires_at).not.toBeNull(); // deadline armed
    expect(deliveryRow(messageId).state).toBe('transport_written');

    // First timeout -> requeue (++attempt).
    clock.advance(ACK_DEADLINE_MS + 1000);
    expect(reaper.sweep().ackTimedOut).toBe(1);
    expect(deliveryRow(messageId).state).toBe('retry_wait');
    expect(deliveryRow(messageId).attempt_ack_timeout).toBe(1);
    expect(auditCount(messageId, 'ACK_TIMEOUT_REQUEUE')).toBe(1);

    // Re-inject and time out again until exhaustion -> dead_letter. Advance PAST
    // the backoff window FIRST (the requeue armed a future next_attempt_at, and
    // injection-selection gates on next_attempt_at <= now), then re-inject (which
    // re-arms the ack deadline so escalation proceeds — the body is NOT re-presented
    // on re-injection, per the Layer-3 invariant; escalation is verified by STATE),
    // then let the ack deadline lapse and sweep.
    for (let i = 1; i < 3; i++) {
      clock.advance(60_000); // clear the backoff window (maxDelay cap = 60s)
      delivery.checkpointPull(hookAuth(authB), `cp-${i}`, 10);
      // Re-injection re-arms the ack deadline (transport_written) so the reaper can
      // time it out again — the escalation engine, not a body re-presentation.
      expect(deliveryRow(messageId).state).toBe('transport_written');
      expect(deliveryRow(messageId).lease_expires_at).not.toBeNull();
      clock.advance(ACK_DEADLINE_MS + 1000);
      reaper.sweep();
    }
    expect(deliveryRow(messageId).state).toBe('dead_letter');
    expect(auditCount(messageId, 'ACK_TIMEOUT_DEAD_LETTER')).toBe(1);
  });

  // 5. Injection-ID invariant: automatic re-injection can never return a body with
  //    an empty injection id. (With the fix, a fire-and-forget never re-injects at
  //    all; this proves the blocked-duplicate path cannot leak a body-without-id.)
  it('5. automatic re-injection never returns a body without an injection id', () => {
    const { authA, authB } = pair();
    const messageId = store.send(authA, { to: 'implementer', text: 'EVENT-2', kind: 'event', requiresAck: false, requiresReply: false }).messageId;

    const first = delivery.checkpointPull(hookAuth(authB), 'cp1', 10);
    expect(first).toHaveLength(1);
    expect(first[0]!.metadata?.[INJECTION_METADATA_KEY]).toBeTruthy(); // first injection HAS an id

    // Force as many automatic pulls + sweeps as a redelivery loop would: the body
    // must NEVER be returned again, and certainly never with an empty injection id.
    for (let i = 0; i < 4; i++) {
      clock.advance(ACK_DEADLINE_MS + 1000);
      reaper.sweep();
      const again = delivery.checkpointPull(hookAuth(authB), `cp-loop-${i}`, 10);
      const dup = again.find((m) => m.messageId === messageId);
      expect(dup, 'fire-and-forget body must not reappear').toBeUndefined();
    }
    // Exactly one injection row ever existed; the body was presented exactly once.
    expect(injectionCount(messageId)).toBe(1);
    expect(transportWrites(messageId)).toBe(1);

    // Belt-and-suspenders: no checkpoint output anywhere carried an injection-id-less body.
    // (Any returned PendingMessage either has a non-empty xbus_injection_id, or it was
    //  the deduped-skip case which returns nothing — never a body with an empty id.)
  });
});
