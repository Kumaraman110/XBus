/**
 * 15-day meaningful-activity expiry (beta.4, ADR 0012 Decisions 5-6).
 *
 * Mirrors the acceptance-test sequence with an injected clock:
 *   register -> 14d23h59m still active -> past 15d + sweep -> expired:
 *     - dropped from discovery
 *     - name released (reclaimable)
 *     - readiness disconnected
 *     - new sends rejected RECIPIENT_SESSION_EXPIRED (final, non-retryable)
 *     - pending deliveries dead-lettered (recipient_inactive_15_days)
 *     - tombstone = the expired sessions row (body-free) — no separate table
 *   re-register -> fresh epoch, old queued bodies NOT resurrected.
 * Plus: the sweep must NOT touch the non-ACK ack-timeout path (I3), must be
 * idempotent, and must not expire a session inside the 15-day window.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority, MEANINGFUL_ACTIVITY_RETENTION_MS } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { XBusError, XBusErrorCode } from '../../src/protocol/errors.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let reaper: Reaper; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-exp-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('m');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids, 5 * 60_000);
  reaper = new Reaper(db, clock, ids);
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function ready(name: string): SessionAuthority {
  const s = sid();
  const auth = store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: name });
  store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
  return auth;
}
function sessRow(sessionId: string): { state: string; expired_at: string | null; reason: string | null; readiness: string; norm: string | null } {
  return db.prepare('SELECT session_name_state AS state, expired_at, expiration_reason AS reason, readiness, normalized_session_name AS norm FROM sessions WHERE session_id=?').get(sessionId) as never;
}

describe('15-day expiry sweep', () => {
  it('stays active at 14d23h59m, expires after 15d', () => {
    const a = ready('exp-a');
    clock.advance(15 * DAY - 60_000); // 14d 23h 59m
    expect(reaper.sweep().sessionsExpired ?? 0).toBe(0);
    expect(sessRow(a.sessionId).expired_at).toBeNull();
    expect(sessRow(a.sessionId).state).toBe('active');
    // cross the boundary
    clock.advance(2 * 60_000); // now > 15d
    const r = reaper.sweep();
    expect(r.sessionsExpired).toBe(1);
    const row = sessRow(a.sessionId);
    expect(row.expired_at).toBe(clock.nowIso());
    expect(row.reason).toBe('recipient_inactive_15_days');
    expect(row.readiness).toBe('disconnected');
    // BETA.10 WS1 (ADR 0033) — EXPIRY = DORMANCY, NOT DELETION. Expiry no longer RETIRES the name
    // or releases the durable handle (beta.9 did — the handle-takeover / continuity-loss bug). The
    // dormancy flag is `expired_at`; the protected USER handle stays HELD so only the secret-bearing
    // owner can reactivate it. So session_name_state stays 'active' and the name remains held.
    expect(row.state).toBe('active'); // handle stays HELD (dormant), not retired/released
    expect(row.norm).toBe('exp-a');   // durable name still held for secret-gated reclaim
  });

  it('exactly 15 days is the boundary (expires_at == now is due)', () => {
    const a = ready('exp-boundary');
    // last_meaningful_activity_at + 15d == now exactly.
    clock.advance(MEANINGFUL_ACTIVITY_RETENTION_MS);
    expect(reaper.sweep().sessionsExpired).toBe(1);
    expect(sessRow(a.sessionId).expired_at).not.toBeNull();
  });

  it('drops the session from discovery but KEEPS its name HELD (dormant, not freed for secret-less takeover)', () => {
    // BETA.10 WS1 (ADR 0033) — EXPIRY = DORMANCY. beta.9 freed the name for reuse by any brand-new
    // session; that is exactly the handle-takeover the split-teardown decision forbids. Now the
    // dormant identity KEEPS its protected handle: it drops out of the ACTIVE discovery view, but a
    // brand-new SECRET-LESS session claiming the same name gets PENDING (not active), and only the
    // valid owner secret reactivates the identity. (Explicit destruction via operatorRemoveRecord is
    // the path that frees the handle — covered by identity-map-lifecycle CASE 3.)
    const a = ready('exp-name');
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    expect(store.listActiveNamedSessions().map((s) => s.sessionId)).not.toContain(a.sessionId);
    // A brand-new SECRET-LESS session cannot take the held handle — it is parked pending.
    const b = ready('exp-name');
    expect(sessRow(b.sessionId).state, 'a dormant handle is not takeable without the secret').not.toBe('active');
    // The valid owner secret reactivates the ORIGINAL identity + its handle.
    const back = store.register({ sessionId: sid(), instanceId: 'i', connectionId: `c-back`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'exp-name', ownerSecret: a.ownerSecret! });
    expect(back.sessionId, 'valid secret reactivates the dormant identity').toBe(a.sessionId);
    expect(back.awardedSessionName).toBe('exp-name');
  });

  it('rejects new sends to an expired recipient with RECIPIENT_SESSION_EXPIRED (final)', () => {
    const sender = ready('snd');
    const rcv = ready('rcv-exp');
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    // Sender stays alive (it had activity at registration; advance is < 15d for it? No —
    // both advanced together). Re-register the sender so it is active again.
    const sender2 = store.register({ sessionId: sender.sessionId, instanceId: 'i2', connectionId: 'c-snd2', processId: 9, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', supersede: true, requestedSessionName: 'snd' });
    store.signalReadiness(sender2, { ackAvailable: true, versionOk: true });
    // Target the expired recipient by its (now-released) id.
    try {
      store.send(sender2, { to: rcv.sessionId, text: 'hello', kind: 'request', requiresAck: true, requiresReply: false });
      throw new Error('expected send to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(XBusError);
      expect((e as XBusError).code).toBe(XBusErrorCode.RECIPIENT_SESSION_EXPIRED);
    }
  });

  it('dead-letters pending deliveries to the expired recipient (recipient_inactive_15_days)', () => {
    const sender = ready('dl-snd');
    const rcv = ready('dl-rcv');
    const { messageId } = store.send(sender, { to: 'dl-rcv', text: 'q', kind: 'request', requiresAck: true, requiresReply: false });
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(messageId) as { state: string }).state).toBe('queued');
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    const d = db.prepare('SELECT state, failure_category AS fc FROM deliveries WHERE message_id=?').get(messageId) as { state: string; fc: string };
    expect(d.state).toBe('dead_letter');
    expect(d.fc).toBe('recipient_inactive_15_days');
  });

  it('does NOT resurrect old queued bodies after re-registration', () => {
    const sender = ready('rs-snd');
    const rcv = ready('rs-rcv');
    store.send(sender, { to: 'rs-rcv', text: 'old', kind: 'request', requiresAck: true, requiresReply: false });
    clock.advance(15 * DAY + 1000);
    reaper.sweep(); // expires rcv, dead-letters the message
    // Re-register the same workspace/session: fresh epoch.
    const rcv2 = store.register({ sessionId: rcv.sessionId, instanceId: 'i2', connectionId: 'c-rcv2', processId: 7, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', supersede: true, requestedSessionName: 'rs-rcv' });
    store.signalReadiness(rcv2, { ackAvailable: true, versionOk: true });
    expect(rcv2.epoch).toBeGreaterThan(rcv.epoch); // new epoch
    // The old dead-lettered body must NOT be injected to the new epoch.
    const got = delivery.checkpointPull({ ...rcv2, role: 'hook' as never }, 'cp-new', 10);
    expect(got).toHaveLength(0);
  });

  it('an expired session resuming via the NORMAL (non-supersede) reconnect recovers cleanly (no zombie)', () => {
    // The real `claude --resume` path: CLAUDE_CODE_SESSION_ID is stable, and the MCP
    // server re-registers WITHOUT supersede. A naive join would leave expired_at set
    // → a zombie (sends rejected, name stuck 'retired'). ADR 0012 D6 promises recovery.
    const sender = ready('zr-snd');
    const rcv = ready('zr-rcv');
    const { messageId } = store.send(sender, { to: 'zr-rcv', text: 'old', kind: 'request', requiresAck: true, requiresReply: false });
    clock.advance(15 * DAY + 1000);
    reaper.sweep(); // expires rcv + dead-letters the queued message
    expect(sessRow(rcv.sessionId).expired_at).not.toBeNull();
    // Resume: SAME sessionId, NO supersede flag (exactly what mcp-server.ts sends).
    const resumed = store.register({ sessionId: rcv.sessionId, instanceId: 'i2', connectionId: 'c-zr2', processId: 7, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'zr-rcv' });
    store.signalReadiness(resumed, { ackAvailable: true, versionOk: true });
    const row = sessRow(rcv.sessionId);
    // Recovered: tombstone cleared, name re-claimed active, NOT readiness-stuck.
    expect(row.expired_at).toBeNull();
    expect(row.reason).toBeNull();
    expect(row.state).toBe('active'); // name re-claimed (it was free)
    expect(resumed.epoch).toBeGreaterThan(rcv.epoch); // fresh epoch
    // Now routable again: a fresh send to it succeeds (not RECIPIENT_SESSION_EXPIRED).
    const ok = store.send(sender, { to: 'zr-rcv', text: 'new', kind: 'request', requiresAck: false, requiresReply: false });
    expect(ok.recipientSessionId).toBe(rcv.sessionId);
    // But the OLD dead-lettered body is NOT resurrected into the new epoch.
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(messageId) as { state: string }).state).toBe('dead_letter');
    const got = delivery.checkpointPull({ ...resumed, role: 'hook' as never }, 'cp-new', 10);
    expect(got.find((m) => m.messageId === messageId)).toBeUndefined(); // old body gone
    expect(got.find((m) => m.text === 'new')).toBeDefined(); // new body delivered
  });

  it('an expired session resuming WITHOUT a name is routable again by its automatic_alias', () => {
    // Cross-fix regression: the expiry sweep retires ALL alias rows (active=0),
    // including the broker-minted automatic_alias. A resume must reactivate it, else
    // a session that resumes with no requestedSessionName is unaddressable by alias.
    const sender = ready('aa-snd');
    const rcvId = sid();
    const rcv = store.register({ sessionId: rcvId, instanceId: 'i', connectionId: `c-${rcvId}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' }); // unnamed
    store.signalReadiness(rcv, { ackAvailable: true, versionOk: true });
    const autoAlias = (db.prepare('SELECT automatic_alias AS a FROM sessions WHERE session_id=?').get(rcvId) as { a: string }).a;
    clock.advance(15 * DAY + 1000);
    reaper.sweep(); // expires rcv, retires its automatic_alias (active=0)
    // Resume WITHOUT a requested name (the bite case).
    const resumed = store.register({ sessionId: rcvId, instanceId: 'i2', connectionId: `c2-${rcvId}`, processId: 7, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    store.signalReadiness(resumed, { ackAvailable: true, versionOk: true });
    expect(sessRow(rcvId).expired_at).toBeNull(); // recovered
    // Routable by the automatic_alias again (the sweep had deactivated it).
    const send = store.send(sender, { to: autoAlias, text: 'via-auto-alias', kind: 'request', requiresAck: false, requiresReply: false });
    expect(send.recipientSessionId).toBe(rcvId);
  });

  it('renameSession on an EXPIRED session resurrects it cleanly (no tombstone-locked name)', () => {
    // Cross-cycle regression: a session whose connection stays alive (heartbeats are
    // NOT meaningful activity) is expired by the reaper while its epoch is unchanged.
    // The model then calls xbus_rename. Before the fix this left expired_at set AND
    // session_name_state='active' — an unroutable row that permanently locked the name
    // in ux_session_name_active. The rename must RESURRECT (clear the tombstone).
    const sender = ready('rr-snd');
    const victim = ready('rr-victim');
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    expect(sessRow(victim.sessionId).expired_at).not.toBeNull();
    // BETA.10 WS1 (ADR 0033): expiry = dormancy, so the handle stays HELD ('active'), not 'retired'.
    // The dormancy flag is expired_at (asserted above). The rename-resurrection behavior this test
    // covers (clear the tombstone, become routable) is unchanged — asserted below.
    expect(sessRow(victim.sessionId).state).toBe('active');
    // The live connection's epoch is unchanged (expiry doesn't bump it), so rename's
    // epoch check passes — exactly the bite case.
    const autoAlias = (db.prepare('SELECT automatic_alias AS a FROM sessions WHERE session_id=?').get(victim.sessionId) as { a: string }).a;
    const out = store.renameSession(victim, 'rr-victim-renamed');
    expect(out.state).toBe('active');
    const row = sessRow(victim.sessionId);
    expect(row.expired_at).toBeNull();      // tombstone cleared (resurrected)
    expect(row.reason).toBeNull();
    expect(row.norm).toBe('rr-victim-renamed');
    // Routable again by the new name (would be UNROUTABLE if expired_at were still set).
    const send = store.send(sender, { to: 'rr-victim-renamed', text: 'back', kind: 'request', requiresAck: false, requiresReply: false });
    expect(send.recipientSessionId).toBe(victim.sessionId);
    // final-review R10 (major): rename-resurrect must also REACTIVATE the retired
    // automatic_alias — the expiry sweep set active=0 on ALL alias rows, and a resurrect
    // that only restores the user name leaves the session unroutable by its session-<hex>
    // fallback (asymmetric with the register-based expired-resume path).
    const viaAuto = store.send(sender, { to: autoAlias, text: 'via-auto', kind: 'request', requiresAck: false, requiresReply: false });
    expect(viaAuto.recipientSessionId).toBe(victim.sessionId);
    // final-review R10 (minor): readiness must be restored to a delivering-capable state
    // ('initializing', mirroring register-resume) — the reaper forced 'disconnected', and
    // if left there the revived session would never be injected queued messages.
    expect(sessRow(victim.sessionId).readiness).toBe('initializing');
    // And another session can NOT be blocked from a DIFFERENT name (no lock leak):
    const other = ready('rr-other');
    expect(sessRow(other.sessionId).state).toBe('active');
  });

  it('refreshMeaningfulActivity does NOT revive an expired (tombstoned) session', () => {
    const a = ready('rma-one');
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    const expiredAt = sessRow(a.sessionId).expired_at;
    expect(expiredAt).not.toBeNull();
    // A stray refresh on a still-expired row must be a no-op (guarded expired_at IS NULL).
    store.refreshMeaningfulActivity(a.sessionId);
    expect(sessRow(a.sessionId).expired_at).toBe(expiredAt); // unchanged — not revived
  });

  it('is idempotent — a second sweep does not double-expire', () => {
    ready('idem');
    clock.advance(15 * DAY + 1000);
    expect(reaper.sweep().sessionsExpired).toBe(1);
    expect(reaper.sweep().sessionsExpired).toBe(0);
  });

  it('an unnamed (legacy) session also expires by inactivity', () => {
    const s = sid();
    const auth = store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
    expect(sessRow(auth.sessionId).state).toBe('unnamed');
    clock.advance(15 * DAY + 1000);
    expect(reaper.sweep().sessionsExpired).toBe(1);
    expect(sessRow(auth.sessionId).expired_at).not.toBeNull();
  });
});

describe('expiry preserves the non-ACK invariant (I3)', () => {
  it('a non-ACK message to an expired recipient is dead-lettered as expired, NEVER ack-timeout-requeued', () => {
    const sender = ready('na-snd');
    const rcv = ready('na-rcv');
    // Fire-and-forget: requires_ack=0. Inject it so it is transport_written->completed.
    const { messageId } = store.send(sender, { to: 'na-rcv', text: 'f', kind: 'event', requiresAck: false, requiresReply: false });
    // It is queued (rcv hasn't pulled). Both sessions were last active at t0
    // (the send refreshed the SENDER at t0 too), so after 15d BOTH expire — that
    // is correct: the sender was also idle for 15 days. The point of THIS test is
    // the non-ACK invariant below, not the count.
    clock.advance(15 * DAY + 1000);
    const r = reaper.sweep();
    expect(r.sessionsExpired).toBe(2); // sender + recipient (both idle 15d)
    expect(r.ackTimedOut).toBe(0); // the non-ack message never entered the ack path
    const d = db.prepare('SELECT state, failure_category AS fc FROM deliveries WHERE message_id=?').get(messageId) as { state: string; fc: string };
    // dead-lettered by expiry (queued -> dead_letter), with the expiry category.
    expect(d.state).toBe('dead_letter');
    expect(d.fc).toBe('recipient_inactive_15_days');
  });

  it('final-review R7: an INJECTED reply-required/no-ack body is dead-lettered at expiry and NOT resurrected on resume', () => {
    // The stranded-transport_written defect: a message sent requiresAck=false +
    // requiresReply=true is injected (transport_written) but NOT completed
    // (completeIfNoResponseRequired only finishes fire-and-forget) and carries NO ack
    // lease, so no reaper pass used to terminate it. Left in transport_written it
    // survived the 15-day expiry and was RESURRECTED when store.register() re-homes
    // transport_written rows on an expired-resume — a stale-body re-presentation the
    // ADR 0012 no-resurrection/at-most-once invariant forbids. The reaper now
    // dead-letters transport_written rows for the tombstoned recipient too.
    const sender = ready('r7-snd');
    const rcv = ready('r7-rcv');
    const { messageId } = store.send(sender, { to: 'r7-rcv', text: 'reply-required-body', kind: 'request', requiresAck: false, requiresReply: true });
    // Inject it → transport_written. Because reply is required (and no ack), it is
    // NOT completed and holds no lease: it stays transport_written.
    const injected = delivery.checkpointPull({ ...rcv, role: 'hook' as never }, 'cp-r7', 10);
    expect(injected.find((m) => m.messageId === messageId)).toBeDefined();
    expect((db.prepare('SELECT state, lease_expires_at AS lea FROM deliveries WHERE message_id=?').get(messageId) as { state: string; lea: string | null }).state).toBe('transport_written');
    expect((db.prepare('SELECT lease_expires_at AS lea FROM deliveries WHERE message_id=?').get(messageId) as { lea: string | null }).lea).toBeNull();
    // 15-day idle expiry of the recipient.
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    expect(sessRow(rcv.sessionId).expired_at).not.toBeNull();
    // The stranded injected body MUST now be terminal (dead-lettered by expiry), NOT
    // left dangling in transport_written.
    const afterExpiry = db.prepare('SELECT state, failure_category AS fc FROM deliveries WHERE message_id=?').get(messageId) as { state: string; fc: string };
    expect(afterExpiry.state).toBe('dead_letter');
    expect(afterExpiry.fc).toBe('recipient_inactive_15_days');
    // Same-session resume (normal reconnect): re-home must be a genuine no-op — the old
    // body must NOT reappear as queued and must NOT be re-injected into the fresh epoch.
    const resumed = store.register({ sessionId: rcv.sessionId, instanceId: 'i2', connectionId: 'c-r7-2', processId: 7, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'r7-rcv' });
    store.signalReadiness(resumed, { ackAvailable: true, versionOk: true });
    expect(resumed.epoch).toBeGreaterThan(rcv.epoch);
    // Still dead_letter (not re-queued by the resume re-home).
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(messageId) as { state: string }).state).toBe('dead_letter');
    // And not re-presented at the new epoch's checkpoint.
    const got = delivery.checkpointPull({ ...resumed, role: 'hook' as never }, 'cp-r7-new', 10);
    expect(got.find((m) => m.messageId === messageId)).toBeUndefined();
  });

  it('reply() to an EXPIRED original-sender is rejected (no orphan), symmetric with send()', () => {
    // A sends a request to B; A then goes idle >15d and is expired; B replies. The
    // reply's recipient is A (expired) — it must be rejected, not queued into a dead
    // session where the sweep (CAS expired_at IS NULL) would never reclaim it.
    const a = ready('rx-a');
    const b = ready('rx-b');
    const { messageId } = store.send(a, { to: 'rx-b', text: 'q', kind: 'request', requiresAck: true, requiresReply: true });
    const v = delivery.inboxView(b, 'cp1', 10);
    delivery.ack(b, { messageId, status: 'accepted', injectionId: v[0]!.injectionId! });
    // Expire A (the original sender). Advance long enough that A (last active at the
    // send) crosses 15d; B was just active (ack) so it survives.
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    expect(sessRow(a.sessionId).expired_at).not.toBeNull();
    const allocSeq = (rid: string): number => { const row = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(rid) as { next_sequence: number } | undefined; const seq = row ? row.next_sequence : 1; db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?,?)').run(rid, seq + 1); return seq; };
    try {
      delivery.reply(b, { messageId, text: 'answer', outcome: 'completed' }, allocSeq);
      throw new Error('expected reply to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(XBusError);
      expect((e as XBusError).code).toBe(XBusErrorCode.RECIPIENT_SESSION_EXPIRED);
    }
    // No reply message/delivery was queued to the expired sender.
    const replies = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE recipient_session_id=? AND kind='reply'`).get(a.sessionId) as { n: number };
    expect(replies.n).toBe(0);
  });

  it('a stale pending_name reservation lapses back to unnamed after its TTL', () => {
    // Two sessions race for the same name → second goes pending with a ~5-min TTL.
    ready('p-owner');
    const pendingAuth = ready('p-owner'); // collision → pending
    expect(sessRow(pendingAuth.sessionId).state).toBe('pending');
    // Before the TTL: still pending.
    clock.advance(4 * 60_000);
    reaper.sweep();
    expect(sessRow(pendingAuth.sessionId).state).toBe('pending');
    // After the ~5-min TTL: the reservation lapses → unnamed (routable by alias).
    clock.advance(2 * 60_000);
    reaper.sweep();
    expect(sessRow(pendingAuth.sessionId).state).toBe('unnamed');
  });

  it('does not expire or dead-letter inside the 15-day window', () => {
    const sender = ready('win-snd');
    const rcv = ready('win-rcv');
    const { messageId } = store.send(sender, { to: 'win-rcv', text: 'q', kind: 'request', requiresAck: true, requiresReply: false });
    clock.advance(15 * DAY - 60_000);
    const r = reaper.sweep();
    expect(r.sessionsExpired).toBe(0);
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(messageId) as { state: string }).state).toBe('queued');
  });
});
