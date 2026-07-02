/**
 * COMPOSITION Group 3 — 15-day expiry (beta.4, ADR 0012 D5/D6) × PR #4 support award.
 *
 * The award (connAwarded) is per-CONNECTION in-memory daemon state, cleared at the start
 * of every registration attempt and on disconnect. Expiry is per-SESSION durable state.
 * The composed guarantee this file proves — with a deterministic FakeClock, at the store
 * + reaper layer (where expiry is authoritative) — is:
 *
 *   • expiry clears the active NAME (retired, name released) AND drops the session from
 *     discovery, so no routing survives on the expired identity;
 *   • an expired recipient rejects new sends FINAL (RECIPIENT_SESSION_EXPIRED) — a stale
 *     award cannot make an expired adapter routable;
 *   • re-registration after expiry starts a FRESH epoch (the daemon re-runs award
 *     evaluation against broker-owned evidence for that new epoch — the OLD award, being
 *     epoch/connection-scoped and cleared at attempt start, cannot survive);
 *   • the beta.3 non-ACK invariant (I3) is preserved: a non-ACK message to an expired
 *     recipient is dead-lettered as expired, NEVER ack-timeout-requeued.
 *
 * The award map itself is daemon in-memory state with no persistence, so "an old award
 * cannot survive a new epoch" is enforced structurally (daemon clears connAwarded at the
 * start of every onRegister and on disconnect — see daemon.ts). This file proves the
 * SESSION-side half of the composition: expiry fully de-routes the identity and a resume
 * is a genuinely fresh lifecycle (new epoch) that must be re-awarded from scratch.
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
import { XBusError, XBusErrorCode } from '../../src/protocol/errors.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let reaper: Reaper; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-compexp-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
  delivery = new DeliveryOps(db, clock, new SeqIdGen('d'), 5 * 60_000);
  reaper = new Reaper(db, clock, new SeqIdGen('r'));
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function ready(name: string): SessionAuthority {
  const s = sid();
  const auth = store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: name });
  store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
  return auth;
}
function nameState(sessionId: string): { state: string; norm: string | null; expired: string | null } {
  return db.prepare('SELECT session_name_state AS state, normalized_session_name AS norm, expired_at AS expired FROM sessions WHERE session_id=?').get(sessionId) as never;
}

describe('Group 3 — expiry clears name + de-routes the identity', () => {
  it('expiry retires the name, releases it, and drops the session from discovery', () => {
    const a = ready('award-victim');
    expect(nameState(a.sessionId).state).toBe('active');
    clock.advance(15 * DAY + 1000);
    expect(reaper.sweep().sessionsExpired).toBe(1);
    const row = nameState(a.sessionId);
    expect(row.expired).not.toBeNull();
    expect(row.state).toBe('retired');
    expect(row.norm).toBeNull();                                   // name released
    expect(store.listActiveNamedSessions().map((s) => s.sessionId)).not.toContain(a.sessionId); // gone from discovery
  });

  it('a send to an expired (formerly named+awarded) recipient is rejected FINAL — no stale routing', () => {
    const sender = ready('g3-snd');
    const rcv = ready('g3-rcv');
    clock.advance(15 * DAY + 1000);
    reaper.sweep(); // expires both (both idle 15d)
    // Re-register the sender so it is active again (fresh epoch), then target the expired rcv.
    const sender2 = store.register({ sessionId: sender.sessionId, instanceId: 'i2', connectionId: 'c-snd2', processId: 9, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', supersede: true, requestedSessionName: 'g3-snd' });
    store.signalReadiness(sender2, { ackAvailable: true, versionOk: true });
    try {
      store.send(sender2, { to: rcv.sessionId, text: 'hi', kind: 'request', requiresAck: true, requiresReply: false });
      throw new Error('expected send to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(XBusError);
      expect((e as XBusError).code).toBe(XBusErrorCode.RECIPIENT_SESSION_EXPIRED);
    }
  });

  it('re-registration after expiry is a FRESH epoch (award must be re-evaluated, not inherited)', () => {
    const rcv = ready('g3-fresh');
    const oldEpoch = rcv.epoch;
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    expect(nameState(rcv.sessionId).expired).not.toBeNull();
    // Resume (same sessionId, no supersede — the real claude --resume path).
    const resumed = store.register({ sessionId: rcv.sessionId, instanceId: 'i2', connectionId: 'c-fresh2', processId: 7, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'g3-fresh' });
    store.signalReadiness(resumed, { ackAvailable: true, versionOk: true });
    // A fresh epoch: any per-epoch/per-connection award computed for oldEpoch is moot.
    expect(resumed.epoch).toBeGreaterThan(oldEpoch);
    expect(nameState(rcv.sessionId).expired).toBeNull(); // tombstone cleared
    expect(nameState(rcv.sessionId).state).toBe('active'); // name re-claimed on the fresh epoch
  });

  it('preserves I3: a non-ACK message to an expired recipient is dead-lettered as expired, never ack-timeout-requeued', () => {
    const sender = ready('g3-na-snd');
    const rcv = ready('g3-na-rcv');
    const { messageId } = store.send(sender, { to: 'g3-na-rcv', text: 'f', kind: 'event', requiresAck: false, requiresReply: false });
    clock.advance(15 * DAY + 1000);
    const r = reaper.sweep();
    expect(r.sessionsExpired).toBe(2);   // sender + recipient (both idle 15d)
    expect(r.ackTimedOut).toBe(0);       // the non-ACK message NEVER entered the ack path
    const d = db.prepare('SELECT state, failure_category AS fc FROM deliveries WHERE message_id=?').get(messageId) as { state: string; fc: string };
    expect(d.state).toBe('dead_letter');
    expect(d.fc).toBe('recipient_inactive_15_days');
  });

  it('an idempotent send RETRY after the recipient expired does NOT create new routing (reports the dead-lettered state, no new delivery)', () => {
    // Adversarial hardening (composition review): a duplicate send with the same
    // idempotencyKey short-circuits BEFORE the expiry guard. Prove that this is still
    // safe: the sweep atomically sets expired_at AND dead-letters the queued delivery in
    // ONE transaction, so the idempotent return reflects the LIVE dead_letter state and
    // inserts NO new delivery — it can never resurrect routing to an expired recipient.
    const sender = ready('idem-snd');
    const rcv = ready('idem-rcv');
    const key = 'idem-key-1';
    const first = store.send(sender, { to: 'idem-rcv', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    const beforeCount = (db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE message_id=?').get(first.messageId) as { n: number }).n;
    expect(beforeCount).toBe(1);
    clock.advance(15 * DAY + 1000);
    reaper.sweep(); // expires rcv AND dead-letters the queued delivery, same txn
    // Re-register the sender so it is active for the retry (fresh epoch).
    const sender2 = store.register({ sessionId: sender.sessionId, instanceId: 'i2', connectionId: 'c-idem2', processId: 9, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', supersede: true, requestedSessionName: 'idem-snd' });
    store.signalReadiness(sender2, { ackAvailable: true, versionOk: true });
    // Idempotent RETRY (same key) — short-circuits before the expiry guard.
    const retry = store.send(sender2, { to: 'idem-rcv', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    expect(retry.deduplicated).toBe(true);
    expect(retry.messageId).toBe(first.messageId);        // same message, no new one
    expect(retry.state).toBe('dead_letter');              // LIVE state, not a stale 'queued'
    const afterCount = (db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE message_id=?').get(first.messageId) as { n: number }).n;
    expect(afterCount).toBe(1);                            // NO new delivery row created
    // And there is exactly one delivery total for this recipient (nothing re-queued).
    const rcvDeliveries = db.prepare('SELECT state FROM deliveries WHERE recipient_session_id=?').all(rcv.sessionId) as Array<{ state: string }>;
    expect(rcvDeliveries).toHaveLength(1);
    expect(rcvDeliveries[0]!.state).toBe('dead_letter');
  });

  it('an idempotent reply RETRY after the original-sender expired does NOT create new routing to it', () => {
    // Symmetric hardening for reply(): a duplicate reply short-circuits before the
    // expired-original-sender guard, but returns the ALREADY-created reply's identity
    // and inserts no new delivery — the reply's own delivery (to the now-expired sender)
    // was created legitimately pre-expiry and is dead-lettered by the sweep.
    const a = ready('idr-a');
    const b = ready('idr-b');
    const { messageId } = store.send(a, { to: 'idr-b', text: 'q', kind: 'request', requiresAck: true, requiresReply: true });
    const v = delivery.inboxView(b, 'cp1', 10);
    delivery.ack(b, { messageId, status: 'accepted', injectionId: v[0]!.injectionId! });
    const allocSeq = (rid: string): number => { const row = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(rid) as { next_sequence: number } | undefined; const seq = row ? row.next_sequence : 1; db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?,?)').run(rid, seq + 1); return seq; };
    // First reply (A still alive) succeeds and is queued to A.
    const rkey = 'idr-key-1';
    const firstReply = delivery.reply(b, { messageId, text: 'answer', outcome: 'completed', idempotencyKey: rkey }, allocSeq);
    const replyDeliveriesBefore = db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE message_id=?').get(firstReply.replyMessageId) as { n: number };
    expect(replyDeliveriesBefore.n).toBe(1);
    // Expire A (the original sender / reply recipient).
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    expect(nameState(a.sessionId).expired).not.toBeNull();
    // Idempotent RETRY of the reply — short-circuits before the expiry guard.
    const retry = delivery.reply(b, { messageId, text: 'answer', outcome: 'completed', idempotencyKey: rkey }, allocSeq);
    expect(retry.deduplicated).toBe(true);
    expect(retry.replyMessageId).toBe(firstReply.replyMessageId);   // same reply, no new one
    const replyDeliveriesAfter = db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE message_id=?').get(firstReply.replyMessageId) as { n: number };
    expect(replyDeliveriesAfter.n).toBe(1);                          // NO new delivery row created
    // The one reply delivery to the (now expired) A was dead-lettered by the sweep.
    const st = db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(firstReply.replyMessageId) as { state: string };
    expect(st.state).toBe('dead_letter');
  });
});

describe('send() idempotency × expiry contract (final-review R2-3)', () => {
  function deliveriesFor(sessionId: string): Array<{ state: string }> {
    return db.prepare('SELECT state FROM deliveries WHERE recipient_session_id=?').all(sessionId) as Array<{ state: string }>;
  }

  it('retry BEFORE expiry returns the recorded result, no new delivery (plain idempotency)', () => {
    const s = ready('c-snd-1'); const r = ready('c-rcv-1');
    const key = 'k-before';
    const first = store.send(s, { to: 'c-rcv-1', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    const retry = store.send(s, { to: 'c-rcv-1', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    expect(retry.deduplicated).toBe(true);
    expect(retry.messageId).toBe(first.messageId);
    expect(deliveriesFor(r.sessionId)).toHaveLength(1); // no new delivery
  });

  it('retry AFTER expiry (delivery dead-lettered by the sweep) returns the terminal dead_letter, no revival', () => {
    const s = ready('c-snd-2'); const r = ready('c-rcv-2');
    const key = 'k-after';
    const first = store.send(s, { to: 'c-rcv-2', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    clock.advance(15 * DAY + 1000);
    reaper.sweep(); // expires r + dead-letters the queued delivery (terminal)
    const s2 = store.register({ sessionId: s.sessionId, instanceId: 'i2', connectionId: 'c-s2', processId: 9, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', supersede: true, requestedSessionName: 'c-snd-2' });
    store.signalReadiness(s2, { ackAvailable: true, versionOk: true });
    const retry = store.send(s2, { to: 'c-rcv-2', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    expect(retry.deduplicated).toBe(true);
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.state).toBe('dead_letter');            // terminal recorded outcome
    expect(deliveriesFor(r.sessionId)).toHaveLength(1);  // NOT re-queued / resurrected
    expect(deliveriesFor(r.sessionId)[0]!.state).toBe('dead_letter');
  });

  it('retry to an expired recipient whose delivery is still NON-terminal throws RECIPIENT_SESSION_EXPIRED (no silent live routing)', () => {
    // Contract edge: expire the recipient WITHOUT the delivery reaching a terminal state
    // (simulate a not-yet-swept live delivery), then retry. A live (non-terminal) delivery
    // to a now-expired recipient must be rejected FINAL, not reported as success.
    const s = ready('c-snd-3'); const r = ready('c-rcv-3');
    const key = 'k-live-expired';
    const first = store.send(s, { to: 'c-rcv-3', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(first.messageId) as { state: string }).state).toBe('queued');
    // Expire the recipient row directly but leave the delivery 'queued' (non-terminal).
    db.prepare(`UPDATE sessions SET expired_at=?, expiration_reason='recipient_inactive_15_days', session_name_state='retired', normalized_session_name=NULL WHERE session_id=?`).run(clock.nowIso(), r.sessionId);
    try {
      store.send(s, { to: 'c-rcv-3', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
      throw new Error('expected the idempotent retry to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(XBusError);
      expect((e as XBusError).code).toBe(XBusErrorCode.RECIPIENT_SESSION_EXPIRED);
    }
    // No new delivery was created by the rejected retry.
    expect(deliveriesFor(r.sessionId)).toHaveLength(1);
  });

  it('a NEW idempotency key to an expired recipient fails with RECIPIENT_SESSION_EXPIRED', () => {
    const s = ready('c-snd-4'); const r = ready('c-rcv-4');
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    const s2 = store.register({ sessionId: s.sessionId, instanceId: 'i2', connectionId: 'c-s4b', processId: 9, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', supersede: true, requestedSessionName: 'c-snd-4' });
    store.signalReadiness(s2, { ackAvailable: true, versionOk: true });
    try {
      store.send(s2, { to: r.sessionId, text: 'fresh', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: 'brand-new-key' });
      throw new Error('expected the fresh send to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(XBusError);
      expect((e as XBusError).code).toBe(XBusErrorCode.RECIPIENT_SESSION_EXPIRED);
    }
  });

  it('recipient RE-REGISTRATION (new epoch) does not resurrect an old body; a same-key retry still returns the old terminal result', () => {
    const s = ready('c-snd-5'); const r = ready('c-rcv-5');
    const key = 'k-reepoch';
    const first = store.send(s, { to: 'c-rcv-5', text: 'old-body', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    clock.advance(15 * DAY + 1000);
    reaper.sweep(); // r expires, delivery dead-lettered
    // r re-registers → fresh epoch, tombstone cleared.
    const r2 = store.register({ sessionId: r.sessionId, instanceId: 'i2', connectionId: 'c-r5b', processId: 7, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', supersede: true, requestedSessionName: 'c-rcv-5' });
    store.signalReadiness(r2, { ackAvailable: true, versionOk: true });
    expect(r2.epoch).toBeGreaterThan(r.epoch);
    // The OLD dead-lettered body is NOT delivered to the new epoch.
    const got = delivery.checkpointPull({ ...r2, role: 'hook' as never }, 'cp-reepoch', 10);
    expect(got.find((m) => m.text === 'old-body')).toBeUndefined();
    // A same-key retry returns the recorded (dead_letter) terminal result — recipient is
    // NOT expired now (re-registered), delivery is terminal ⇒ faithful replay, no new row.
    const retry = store.send(s, { to: 'c-rcv-5', text: 'old-body', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    expect(retry.deduplicated).toBe(true);
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.state).toBe('dead_letter');
    // No new delivery row for the old message.
    expect((db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE message_id=?').get(first.messageId) as { n: number }).n).toBe(1);
  });

  it('is deterministic across a broker restart (reopen the same DB): retry after expiry still returns dead_letter, no new routing', () => {
    const s = ready('c-snd-6'); const r = ready('c-rcv-6');
    const key = 'k-restart';
    const first = store.send(s, { to: 'c-rcv-6', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    // "Restart": close + reopen the same on-disk DB into a fresh store (same clock state).
    db.close();
    db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
    store = new BrokerStore(db, clock, new SeqIdGen('m2'), 'b');
    const s2 = store.register({ sessionId: s.sessionId, instanceId: 'i2', connectionId: 'c-s6b', processId: 9, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', supersede: true, requestedSessionName: 'c-snd-6' });
    store.signalReadiness(s2, { ackAvailable: true, versionOk: true });
    const retry = store.send(s2, { to: 'c-rcv-6', text: 'q', kind: 'request', requiresAck: true, requiresReply: false, idempotencyKey: key });
    expect(retry.deduplicated).toBe(true);
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.state).toBe('dead_letter');
    expect((db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=?').get(r.sessionId) as { n: number }).n).toBe(1);
  });
});
