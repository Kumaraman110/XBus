/**
 * BLOCKER #3 (beta.9.1) — reply-pending 'accepted' orphan. RED-FIRST regression guard.
 *
 * DEFECT: a requiresAck+requiresReply request that has been ack(accepted) (body already
 * presented + acknowledged, reply still owed) becomes a PERMANENT, invisible, unrepliable,
 * never-terminal orphan when the recipient's epoch advances (successor reclaim) OR when the
 * recipient simply idles 15 days (pure expiry). The sender's requires_reply is never answered
 * and the persistent state never records that a reply was owed-and-not-delivered.
 *
 * This file asserts the TARGET post-fix invariants (see each `it`), so it is a genuine
 * regression guard, NOT a bug-asserter:
 *   - at the beta.9 baseline (0ed86fb) it FAILS on every counted path (the invariants are absent);
 *   - after the fix it PASSES.
 * A test that is green on both baseline and fixed code would be invalid evidence — this one is
 * red at baseline by construction (it demands recovery/observability the baseline does not have).
 *
 * PATHS COUNTED (genuinely distinct transitions into the orphan):
 *   Path 1 — reclaim epoch-bump: accepted row stranded when a successor reclaims (epoch N->N+1).
 *   Path 2 — pure 15-day expiry: accepted row stranded when the recipient merely idles (NO reclaim).
 * NOT a separate path (honesty, per Release-Engineer gate): a SCHEDULED requiresAck+requiresReply
 * delivery reaches 'accepted' through store.operatorSend -> the SAME delivery-state layer, so it
 * hits the IDENTICAL reclaim/expiry logic. The scheduled-origin case below is included ONLY as an
 * explicit same-code demonstration (labelled), folded into path 1 — it is not counted as a third path.
 *
 * TARGET INVARIANTS (user-specified):
 *  1. The request body is NOT automatically injected again on reclaim (no duplicate model-visible work).
 *  2. The successor can DISCOVER that a correlated reply remains outstanding.
 *  3. The successor receives valid authority to COMPLETE that pending reply.
 *  4. The superseded (old) epoch cannot ack or reply.
 *  5. EXACTLY ONE correlated reply can complete the original request.
 *  6. Broker restart does not lose the pending-reply obligation.
 *  7. On expiry, the accepted reply-pending row reaches an EXPLICIT observable terminal that
 *     preserves the "reply owed and not delivered" signal (distinct failure_category), NOT a silent
 *     dead_letter / vanish. Sender+operator can distinguish: never-delivered / delivered-but-unacked /
 *     acked-but-reply-outstanding / explicitly-abandoned-or-expired.
 *
 * Driven with a FakeClock; store/delivery/reaper harness mirrors non-ack-redelivery.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

const DAY = 24 * 60 * 60_000;
const ACK_DEADLINE_MS = 5 * 60_000;

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let reaper: Reaper; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-orphan-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('m');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids, ACK_DEADLINE_MS);
  reaper = new Reaper(db, clock, ids, { backoff: { initialDelayMs: 1000, maxDelayMs: 60_000, maxAttempts: 3, factor: 2 }, rng: () => 1 });
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function reg(over: Partial<Parameters<BrokerStore['register']>[0]> = {}): SessionAuthority {
  const s = over.sessionId ?? sid();
  const auth = store.register({ sessionId: s, instanceId: `i-${s}`, connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
  // §2 readiness gate: checkpointPull defers injection for a session that has not signalled
  // ready. A reclaiming successor comes back 'initializing', so re-signal after every register.
  store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
  return auth;
}
function hookAuth(a: SessionAuthority): SessionAuthority { return { ...a, role: 'hook' as never }; }
function allocSeq(recipientSessionId: string): number {
  const row = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(recipientSessionId) as { next_sequence: number } | undefined;
  const seq = row ? row.next_sequence : 1;
  db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(recipientSessionId, seq + 1);
  return seq;
}
/** Mirror daemon.onConnClose: predecessor is GONE (disconnected + live components closed). */
function disconnect(sessionId: string): void {
  const now = clock.nowIso();
  db.prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL, last_seen_at=? WHERE session_id=?`).run(now, sessionId);
  db.prepare(`UPDATE component_instances SET state='closed', disconnected_at=? WHERE session_id=? AND state='live'`).run(now, sessionId);
}
function deliveryRow(messageId: string): { state: string; failure_category: string | null; application_accepted_at: string | null; application_completed_at: string | null } {
  return db.prepare('SELECT state, failure_category, application_accepted_at, application_completed_at FROM deliveries WHERE message_id=?').get(messageId) as never;
}
function injectionCount(messageId: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=?').get(messageId) as { n: number }).n;
}
/** transport_write_log rows = actual BODY presentations to the transport (the true "was the body
 *  shown again?" signal). Re-homing reply AUTHORITY must NOT add a transport write. */
function bodyPresentations(messageId: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM transport_write_log WHERE message_id=?').get(messageId) as { n: number }).n;
}
function replyCount(originalMessageId: string): number {
  // A completing reply is a message whose parent_message_id is the original request.
  return (db.prepare(`SELECT COUNT(*) n FROM messages WHERE parent_message_id=? AND kind='reply'`).get(originalMessageId) as { n: number }).n;
}
/** Drive a request to the 'accepted' (acked, reply-pending) state on the recipient. */
function sendInjectAck(senderAuth: SessionAuthority, recipientAuth: SessionAuthority, toAlias: string, text: string): string {
  const messageId = store.send(senderAuth, { to: toAlias, text, kind: 'request', requiresAck: true, requiresReply: true }).messageId;
  const pulled = delivery.checkpointPull(hookAuth(recipientAuth), `cp-${messageId}`, 10);
  expect(pulled.some((m) => m.messageId === messageId), 'body injected once at checkpoint').toBe(true);
  const acked = delivery.ack(recipientAuth, { messageId, status: 'accepted' });
  expect(acked.state).toBe('accepted');
  expect(deliveryRow(messageId).state).toBe('accepted'); // acked, reply still owed
  return messageId;
}

describe('BLOCKER #3 — reply-pending accepted orphan (RED-first regression guard)', () => {
  // ─── PATH 1: reclaim epoch-bump ───────────────────────────────────────────────────────
  it('PATH 1 (reclaim): successor completes the outstanding reply WITHOUT body re-injection; old epoch fenced; exactly one reply', () => {
    const sidR = sid();
    const rA = reg({ sessionId: sidR, requestedSessionName: 'worker' });
    const secret = rA.ownerSecret!;
    const sender = reg({ requestedSessionName: 'ops' });

    const messageId = sendInjectAck(sender, rA, 'worker', 'do-the-thing');
    expect(injectionCount(messageId)).toBe(1);      // one authority row (epoch N) so far
    expect(bodyPresentations(messageId)).toBe(1);   // body presented to transport exactly once

    // Recipient A crashes (not expired). Successor B reclaims -> epoch N->N+1.
    disconnect(sidR);
    const sidB = sid();
    const rB = reg({ sessionId: sidB, requestedSessionName: 'worker', ownerSecret: secret });
    expect(rB.sessionId).toBe(sidR);          // redirected onto canonical identity
    expect(rB.epoch).toBeGreaterThan(rA.epoch); // fresh epoch

    // INVARIANT 2 — the successor can DISCOVER the outstanding reply obligation.
    const view = delivery.inboxView(rB, 'cp-successor', 50);
    const outstanding = view.find((e) => e.messageId === messageId);
    expect(outstanding, 'successor discovers the reply-pending request in its inbox view').toBeTruthy();
    expect(outstanding!.requiresReply).toBe(true);

    // INVARIANT 1 — the body was NOT auto re-injected merely to recreate authority.
    // (A re-home of AUTHORITY must not re-present the body: injection count for the
    // original message must not have grown a fresh logical#1 body presentation.)
    expect(outstanding!.bodyIncluded, 'successor is NOT re-shown the already-accepted body').toBe(false);

    // INVARIANT 4 — the OLD epoch (predecessor authority) can no longer reply.
    expect(() => delivery.reply(rA, { messageId, text: 'stale-epoch-reply', outcome: 'completed' }, allocSeq))
      .toThrow(); // superseded epoch is fenced

    // INVARIANT 3 — the successor HAS valid authority to complete the pending reply.
    const replyRes = delivery.reply(rB, { messageId, text: 'here-is-the-answer', outcome: 'completed' }, allocSeq);
    expect(replyRes.replyMessageId).toBeTruthy();
    expect(deliveryRow(messageId).state).toBe('completed'); // original request finally completed

    // INVARIANT 5 — EXACTLY ONE correlated reply completed the original request.
    expect(replyCount(messageId)).toBe(1);
    // INVARIANT 1 (again) — the BODY was never re-presented. Re-homing authority legitimately adds
    // ONE authority row for the new epoch (so context_injections == 2, one per epoch), but the
    // transport_write_log (actual body presentations) stays at 1 — the successor completed the
    // reply WITHOUT ever being re-shown the request body.
    expect(bodyPresentations(messageId)).toBe(1);
    expect(injectionCount(messageId)).toBe(2); // epoch-N (original) + epoch-N+1 (re-homed authority)
  });

  it('PATH 1 (reclaim) SAME-CODE demo — scheduled-origin request (store.operatorSend) orphans + recovers identically (NOT counted as a separate path)', () => {
    // A scheduled requiresAck+requiresReply delivery enters the delivery-state layer via
    // store.operatorSend — the SAME code as a peer send. This case demonstrates the defect/fix
    // is in the shared layer, not a schedule-specific transition; it is folded into path 1.
    const sidR = sid();
    const rA = reg({ sessionId: sidR, requestedSessionName: 'sched-worker' });
    const secret = rA.ownerSecret!;

    // Operator/scheduler enqueue (idempotency key mimics a fired schedule slot).
    const sent = store.operatorSend({ to: 'sched-worker', text: 'scheduled-task', kind: 'request', requiresAck: true, requiresReply: true, idempotencyKey: 'sched:demo:slot-1' } as never);
    const messageId = sent.messageId;
    delivery.checkpointPull(hookAuth(rA), 'cp-sched', 10);
    expect(delivery.ack(rA, { messageId, status: 'accepted' }).state).toBe('accepted');

    disconnect(sidR);
    const rB = reg({ sessionId: sid(), requestedSessionName: 'sched-worker', ownerSecret: secret });
    expect(rB.sessionId).toBe(sidR);

    // Shared-layer proof: post-reclaim the scheduled-origin reply-pending obligation is DISCOVERABLE
    // by the successor (invisible at baseline) and its reply AUTHORITY has been re-homed to the new
    // epoch — identical to a peer send, because store.operatorSend uses the SAME delivery-state layer.
    const view = delivery.inboxView(rB, 'cp-sched-successor', 50);
    const entry = view.find((e) => e.messageId === messageId);
    expect(entry, 'scheduled-origin reply-pending is discoverable post-reclaim').toBeTruthy();
    expect(entry!.requiresReply).toBe(true);
    expect(entry!.bodyIncluded, 'scheduled body is NOT re-shown to the successor').toBe(false);
    // Reply authority now exists for the NEW epoch (rB.epoch), so receipts.authorize('reply') would
    // pass — the completion mechanics themselves are exercised by the peer-to-peer PATH 1 test above.
    // (We don't drive reply() here: a scheduled message's sender is the operator principal, and
    // replying to the operator is a distinct flow orthogonal to the orphan being fixed.)
    const authRow = db.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=? AND recipient_epoch=?').get(messageId, rB.epoch) as { n: number };
    expect(authRow.n, 'reply authority re-homed to the successor epoch').toBe(1);
    expect(deliveryRow(messageId).state).toBe('accepted'); // still accepted (not re-queued, body not re-shown)
  });

  it('PATH 1 (reclaim) + INVARIANT 6 — broker restart preserves the pending-reply obligation', () => {
    const sidR = sid();
    const rA = reg({ sessionId: sidR, requestedSessionName: 'restart-worker' });
    const secret = rA.ownerSecret!;
    const sender = reg({ requestedSessionName: 'ops-r' });
    const messageId = sendInjectAck(sender, rA, 'restart-worker', 'survive-restart');
    disconnect(sidR);

    // Simulate a broker restart: reopen the SAME on-disk DB with fresh store/delivery.
    const dbPath = path.join(dir, 'x.sqlite');
    db.close();
    db = openDatabase(dbPath, { applyPragmas: true });
    const ids2 = new SeqIdGen('m2');
    store = new BrokerStore(db, clock, ids2, 'b');
    delivery = new DeliveryOps(db, clock, ids2, ACK_DEADLINE_MS);

    // Successor reclaims after the restart; the obligation must still be completable.
    const rB = reg({ sessionId: sid(), requestedSessionName: 'restart-worker', ownerSecret: secret });
    expect(rB.sessionId).toBe(sidR);
    const view = delivery.inboxView(rB, 'cp-after-restart', 50);
    expect(view.find((e) => e.messageId === messageId), 'obligation survives broker restart').toBeTruthy();
    const replyRes = delivery.reply(rB, { messageId, text: 'post-restart-answer', outcome: 'completed' }, allocSeq);
    expect(replyRes.replyMessageId).toBeTruthy();
    expect(deliveryRow(messageId).state).toBe('completed');
    expect(replyCount(messageId)).toBe(1);
  });

  // ─── PATH 2: pure 15-day expiry (NO reclaim) ─────────────────────────────────────────────
  it('PATH 2 (pure expiry): an accepted reply-pending row reaches an EXPLICIT observable terminal preserving the reply-owed signal — not a silent dead_letter, not immortal', () => {
    const sidR = sid();
    const rA = reg({ sessionId: sidR, requestedSessionName: 'idle-worker' });
    const sender = reg({ requestedSessionName: 'ops-e' });
    const messageId = sendInjectAck(sender, rA, 'idle-worker', 'reply-owed-then-idle');
    expect(deliveryRow(messageId).state).toBe('accepted');

    // The recipient simply idles > 15 days. NO reclaim. Sweep.
    clock.advance(15 * DAY + 60_000);
    reaper.sweep();

    const d = deliveryRow(messageId);
    // NOT immortal: the accepted row must not remain 'accepted' forever.
    expect(d.state, 'accepted reply-pending must not stay non-terminal after 15d expiry').not.toBe('accepted');
    // Explicit observable terminal that PRESERVES the "reply owed and not delivered" signal —
    // a distinct, auditable failure_category, NOT the generic recipient_inactive_15_days bucket
    // used for never-acked deliveries (that would disguise the acked-but-unanswered case).
    expect(d.failure_category, 'expiry reason must distinguish acked-but-reply-outstanding from never-acked').toBeTruthy();
    expect(d.failure_category).not.toBe('recipient_inactive_15_days');
    // The acked timestamp is preserved so an observer can see the request WAS accepted.
    expect(d.application_accepted_at, 'accepted timestamp preserved for observability').not.toBeNull();
    // It was never completed (no reply was ever delivered) — the obligation is recorded as unmet.
    expect(d.application_completed_at, 'no reply was delivered, so completion stays null').toBeNull();
  });

  it('PATH 2 (observability): the four delivery outcomes are distinguishable in persistent state', () => {
    // Build one of each and assert they carry DISTINCT observable signals so the sender/operator
    // can tell them apart: never-delivered / delivered-but-unacked / acked-reply-outstanding /
    // abandoned-or-expired.
    const sidR = sid();
    const rA = reg({ sessionId: sidR, requestedSessionName: 'obs-worker' });
    const sender = reg({ requestedSessionName: 'ops-o' });

    // (a) never-delivered: queued, expires before injection.
    const neverId = store.send(sender, { to: 'obs-worker', text: 'never', kind: 'request', requiresAck: true, requiresReply: true, ttlSeconds: 60 } as never).messageId;
    // (b) delivered-but-unacked: injected (transport_written), never acked.
    const unackedId = store.send(sender, { to: 'obs-worker', text: 'unacked', kind: 'request', requiresAck: true, requiresReply: true }).messageId;
    // (c) acked-reply-outstanding: injected + acked accepted, no reply.
    const acceptedId = sendInjectAck(sender, rA, 'obs-worker', 'acked-outstanding');
    // inject (b) so it is transport_written (after (c)'s pull it may already be pulled; pull explicitly)
    delivery.checkpointPull(hookAuth(rA), 'cp-obs', 10);

    clock.advance(15 * DAY + 60_000);
    reaper.sweep();

    const never = deliveryRow(neverId);
    const unacked = deliveryRow(unackedId);
    const accepted = deliveryRow(acceptedId);
    // The acked-reply-outstanding case MUST reach an explicit terminal (not remain 'accepted'
    // forever). At baseline it stays 'accepted' → this fails (correct RED). This is what stops
    // the test passing vacuously just because 'accepted:null' is coincidentally a 3rd signature.
    expect(accepted.state, 'acked-reply-outstanding must reach an explicit terminal on expiry').not.toBe('accepted');
    expect(accepted.application_accepted_at, 'acked timestamp preserved').not.toBeNull();
    // Distinguishable observables — no two of the four collapse. Each carries a DISTINCT
    // (state, failure_category) signature so sender/operator can tell them apart.
    const signatures = new Set([
      `${never.state}:${never.failure_category}`,       // never-delivered
      `${unacked.state}:${unacked.failure_category}`,   // delivered-but-unacked
      `${accepted.state}:${accepted.failure_category}`, // acked-reply-outstanding (explicit terminal)
    ]);
    expect(signatures.size, 'never-delivered / delivered-unacked / acked-reply-outstanding must be distinguishable').toBe(3);
    // The acked-reply-outstanding terminal carries its OWN reason, distinct from the never-acked bucket.
    expect(accepted.failure_category, 'acked-outstanding must not reuse the never-acked reason').not.toBe(unacked.failure_category);
    expect(accepted.failure_category).not.toBe('recipient_inactive_15_days');
  });
});
