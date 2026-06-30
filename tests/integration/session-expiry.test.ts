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
    expect(row.state).toBe('retired'); // name released
    expect(row.readiness).toBe('disconnected');
    expect(row.norm).toBeNull(); // name no longer held
  });

  it('exactly 15 days is the boundary (expires_at == now is due)', () => {
    const a = ready('exp-boundary');
    // last_meaningful_activity_at + 15d == now exactly.
    clock.advance(MEANINGFUL_ACTIVITY_RETENTION_MS);
    expect(reaper.sweep().sessionsExpired).toBe(1);
    expect(sessRow(a.sessionId).expired_at).not.toBeNull();
  });

  it('drops the session from discovery and frees its name for reuse', () => {
    const a = ready('exp-name');
    clock.advance(15 * DAY + 1000);
    reaper.sweep();
    expect(store.listActiveNamedSessions().map((s) => s.sessionId)).not.toContain(a.sessionId);
    // The freed name can be claimed by a brand-new session.
    const b = ready('exp-name');
    expect(sessRow(b.sessionId).state).toBe('active');
    expect(sessRow(b.sessionId).norm).toBe('exp-name');
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
