/**
 * Beta.5 Phase 1 — store.announceSession() unit behavior (ADR 0013 D2/D4/D5, ADR 0020
 * Q1/Q3), driven directly against a real migrated SQLite DB with a FakeClock so the
 * 15-day expiry + resume path is exercised deterministically:
 *
 *   - the visibility columns + exactly ONE ledger event per genuine lifecycle signal,
 *   - duplicate `startup` deduped (no second SESSION_STARTED), resume/clear/compact each
 *     append their own event,
 *   - an EXPIRED session's `resume` announce rides the register() fresh-epoch path
 *     (new epoch, tombstone cleared) and does NOT resurrect the dead-lettered queue,
 *   - dormant → active promotion on a real SessionStart signal.
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
import { verifyLedger } from '../../src/broker/ledger.js';
import { DeliveryState } from '../../src/protocol/states.js';

let dir: string; let db: SqliteDriver; let clock: FakeClock; let ids: SeqIdGen; let store: BrokerStore;
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-announce-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  ids = new SeqIdGen('a');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'broker-1');
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function regHook(sessionId: string): SessionAuthority {
  return store.register({ sessionId, instanceId: 'i-' + sessionId, connectionId: 'c-' + sessionId, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: 'hook' });
}
function ledgerTypes(sid: string): string[] {
  return (db.prepare(`SELECT event_type FROM ledger_events WHERE subject_json LIKE ? ORDER BY seq`).all(`%${sid}%`) as Array<{ event_type: string }>).map((r) => r.event_type);
}

describe('announceSession — lifecycle + ledger coupling', () => {
  it('one ledger event per genuine signal; duplicate startup deduped', () => {
    const sid = 'aaaa0001-0000-4000-8000-000000000001';
    const auth = regHook(sid);
    expect(store.announceSession(auth, { source: 'startup' }).appended).toBe(true);
    expect(store.announceSession(auth, { source: 'startup' }).appended).toBe(false); // dup birth
    expect(store.announceSession(auth, { source: 'resume' }).appended).toBe(true);
    expect(store.announceSession(auth, { source: 'clear' }).appended).toBe(true);
    expect(store.announceSession(auth, { source: 'compact' }).appended).toBe(true);
    expect(ledgerTypes(sid)).toEqual(['SESSION_STARTED', 'SESSION_RESUMED', 'SESSION_CLEARED', 'SESSION_COMPACTED']);
    expect(verifyLedger(db).ok).toBe(true);
  });

  it('unknown/continue source normalizes to resume (never throws)', () => {
    const sid = 'aaaa0002-0000-4000-8000-000000000002';
    const auth = regHook(sid);
    store.announceSession(auth, { source: 'startup' });
    expect(store.announceSession(auth, { source: 'continue' }).lifecycleEvent).toBe('SESSION_RESUMED');
    expect(store.announceSession(auth, { source: 'some-future-source' }).lifecycleEvent).toBe('SESSION_RESUMED');
  });

  it('promotes a dormant row to active on a real signal', () => {
    const sid = 'aaaa0003-0000-4000-8000-000000000003';
    const auth = regHook(sid);
    // Simulate an imported dormant row (management_state set by import, not a signal).
    db.prepare(`UPDATE sessions SET management_state='dormant', identify_confidence='listing_only', first_seen_at=? WHERE session_id=?`).run(clock.nowIso(), sid);
    const r = store.announceSession(auth, { source: 'resume' });
    expect(r.priorManagementState).toBe('dormant');
    expect(r.managementState).toBe('active');
    const row = db.prepare('SELECT management_state, identify_confidence FROM sessions WHERE session_id=?').get(sid) as { management_state: string; identify_confidence: string };
    expect(row.management_state).toBe('active');
    expect(row.identify_confidence).toBe('signal'); // upgraded from listing_only by the live signal
  });

  it('EXPIRED session resume announce → fresh epoch, tombstone cleared, NO message resurrection', () => {
    const recipient = 'aaaa0004-0000-4000-8000-000000000004';
    const sender = 'aaaa0005-0000-4000-8000-000000000005';
    // Recipient registers (mcp) + becomes ready; sender sends a queued message to it.
    const rAuth = store.register({ sessionId: recipient, instanceId: 'i-r', connectionId: 'c-r', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    store.signalReadiness(rAuth, { ackAvailable: true, versionOk: true });
    store.registerAlias(rAuth, 'recipient');
    const sAuth = store.register({ sessionId: sender, instanceId: 'i-s', connectionId: 'c-s', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    store.signalReadiness(sAuth, { ackAvailable: true, versionOk: true });
    const send = store.send(sAuth, { to: 'recipient', text: 'pre-expiry', kind: 'request', requiresAck: true, requiresReply: false });
    const oldEpoch = rAuth.epoch;
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(send.messageId) as { state: string }).state).toBe(DeliveryState.QUEUED);

    // Advance 15 days + a second → the reaper expires the recipient and dead-letters its queue.
    clock.advance(15 * DAY + 1000);
    const reaper = new Reaper(db, clock, ids);
    expect(reaper.sweep().sessionsExpired).toBeGreaterThanOrEqual(1);
    expect((db.prepare('SELECT expired_at FROM sessions WHERE session_id=?').get(recipient) as { expired_at: string | null }).expired_at).not.toBeNull();
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(send.messageId) as { state: string }).state).toBe(DeliveryState.DEAD_LETTER);

    // The SessionStart hook for the resumed session registers (hook role → but expired-resume
    // fresh lifecycle is driven by the MCP register with supersede/expired detection). Here the
    // resumed OWNER re-registers (mcp) — register() detects the expired row and advances epoch.
    const resumedAuth = store.register({ sessionId: recipient, instanceId: 'i-r2', connectionId: 'c-r2', processId: 3, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    expect(resumedAuth.epoch).toBeGreaterThan(oldEpoch); // fresh epoch
    // Now the SessionStart announce records the resume as a lifecycle event.
    const ann = store.announceSession(resumedAuth, { source: 'resume' });
    expect(ann.managementState).toBe('active');
    // Tombstone cleared by the fresh lifecycle; NO resurrection of the dead-lettered message.
    expect((db.prepare('SELECT expired_at FROM sessions WHERE session_id=?').get(recipient) as { expired_at: string | null }).expired_at).toBeNull();
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(send.messageId) as { state: string }).state).toBe(DeliveryState.DEAD_LETTER); // still dead — not requeued
    const queued = (db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND state='${DeliveryState.QUEUED}'`).get(recipient) as { n: number }).n;
    expect(queued).toBe(0); // nothing resurrected
    expect(ledgerTypes(recipient)).toContain('SESSION_RESUMED');
    expect(verifyLedger(db).ok).toBe(true);
  });

  it('rejects an announce for an unregistered session (identity must exist)', () => {
    const fake: SessionAuthority = { sessionId: 'nope', instanceId: 'i', componentInstanceId: 'i', role: 'hook', epoch: 1, generation: 1, fencingToken: 1, connectionId: 'c' };
    expect(() => store.announceSession(fake, { source: 'startup' })).toThrow(/not registered/);
  });

  it('INVARIANT #6: a forced ledger failure rolls back the WHOLE announce (state + audit) — exactly one event or NEITHER', async () => {
    const { XBusErrorCode, isXBusError } = await import('../../src/protocol/errors.js');
    const sid = 'aaaa0006-0000-4000-8000-000000000006';
    const auth = regHook(sid);
    // Inject a ledger-SPECIFIC failure: a temporary trigger that aborts the ledger_events
    // INSERT for a SESSION_STARTED event — exactly the "ledger-only constraint fires inside
    // the shared txn" case ADR 0020 Q3 names. ledgerAppend catches it → AUDIT_PERSISTENCE_FAILED
    // → the whole announce transaction (visibility UPDATE + audit + ledger) rolls back.
    db.exec("CREATE TRIGGER inject_ledger_fail BEFORE INSERT ON ledger_events WHEN NEW.event_type='SESSION_STARTED' BEGIN SELECT RAISE(ABORT,'injected ledger fault'); END");
    const before = db.prepare('SELECT management_state, first_seen_at, source_last FROM sessions WHERE session_id=?').get(sid) as { management_state: string; first_seen_at: string | null; source_last: string | null };
    let code: string | undefined;
    try { store.announceSession(auth, { source: 'startup' }); }
    catch (e) { if (isXBusError(e)) code = e.code; }
    expect(code).toBe(XBusErrorCode.AUDIT_PERSISTENCE_FAILED);
    // State is UNCHANGED — the visibility UPDATE rolled back with the failed ledger append.
    const after = db.prepare('SELECT management_state, first_seen_at, source_last FROM sessions WHERE session_id=?').get(sid) as { management_state: string; first_seen_at: string | null; source_last: string | null };
    expect(after.first_seen_at).toBe(before.first_seen_at); // not stamped
    expect(after.source_last).toBe(before.source_last);     // not stamped
    // NO ledger event committed (neither), and NO audit row for the aborted announce.
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger_events').get()).toEqual({ n: 0 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type='SESSION_ANNOUNCED'").get() as { n: number }).n).toBe(0);

    // Remove the fault → a retry now succeeds with exactly one event (the "or exactly one" arm).
    db.exec('DROP TRIGGER inject_ledger_fail');
    const ok = store.announceSession(auth, { source: 'startup' });
    expect(ok.appended).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ledger_events WHERE event_type='SESSION_STARTED'").get() as { n: number }).n).toBe(1);
  });
});
