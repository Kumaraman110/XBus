/**
 * Beta.7 (ADR 0025) — the scheduler: exactly-once execution across a duplicate tick AND a
 * broker restart mid-fire, quiet-hours/wake-limit/max-fires gating, and loop guards.
 *
 * Driven with a FakeClock (deterministic; no real timers). The scheduler ENQUEUES via
 * store.operatorSend (the durable FLOOR) — it never pushes to a session. Exactly-once rests on
 * schedule_runs UNIQUE(schedule_id, scheduled_for) + ux_idem(sender, idempotency_key).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { Scheduler, inQuietHours, computeNextRun } from '../../src/broker/scheduler.js';
import { Reaper } from '../../src/broker/reaper.js';
import { ensureOperatorSession } from '../../src/broker/operator.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock; let ids: SeqIdGen; let scheduler: Scheduler;
const TARGET = 'tttt7777-0000-4000-8000-0000000000e7';

function setup(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-sched-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  ids = new SeqIdGen('sch');
  runMigrations(db, clock.nowIso());
  ensureOperatorSession(db, clock);
  store = new BrokerStore(db, clock, ids, 'b');
  scheduler = new Scheduler(db, clock, ids, store);
  // A routable target the schedule can address by name.
  const auth = store.register({ sessionId: TARGET, instanceId: 'iT', connectionId: 'cT', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'target-svc' }) as SessionAuthority;
  store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
}
beforeEach(() => setup());
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function msgCount(): number { return (db.prepare(`SELECT COUNT(*) n FROM messages WHERE sender_session_id='local-operator'`).get() as { n: number }).n; }
function runCount(scheduleId: string): number { return (db.prepare('SELECT COUNT(*) n FROM schedule_runs WHERE schedule_id=?').get(scheduleId) as { n: number }).n; }

describe('scheduler pure helpers', () => {
  it('computeNextRun: once→null, interval→after+interval (floored)', () => {
    expect(computeNextRun('once', null, 1000, 60000)).toBeNull();
    expect(computeNextRun('interval', '300000', 1000, 60000)).toBe(301000);
    expect(computeNextRun('interval', '5000', 1000, 60000)).toBe(61000); // floored to min_interval
  });
  it('inQuietHours: inside/outside + wrap-past-midnight', () => {
    expect(inQuietHours('2026-01-01T23:30:00.000Z', JSON.stringify({ windows: [{ start: '22:00', end: '06:00' }] }))).toBe(true);
    expect(inQuietHours('2026-01-01T12:00:00.000Z', JSON.stringify({ windows: [{ start: '22:00', end: '06:00' }] }))).toBe(false);
    expect(inQuietHours('2026-01-01T03:00:00.000Z', JSON.stringify({ windows: [{ start: '22:00', end: '06:00' }] }))).toBe(true); // wrap
    expect(inQuietHours('2026-01-01T12:00:00.000Z', null)).toBe(false);
  });
});

describe('scheduler exactly-once', () => {
  it('a due "once" schedule fires exactly one message; a duplicate tick at the same clock creates NO duplicate', () => {
    const { scheduleId } = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'do it', kind: 'once', requiresAck: true, requiresReply: true, nextRunAtIso: clock.nowIso() });
    const r1 = scheduler.tick();
    expect(r1.fired).toBe(1);
    expect(msgCount()).toBe(1);
    // Duplicate tick at the SAME clock: the schedule is now exhausted (next_run NULL) AND the
    // claim UNIQUE + ux_idem would both block a re-fire — no second message.
    const r2 = scheduler.tick();
    expect(r2.fired).toBe(0);
    expect(msgCount()).toBe(1);
    expect(runCount(scheduleId)).toBe(1);
    expect((db.prepare('SELECT state FROM schedules WHERE schedule_id=?').get(scheduleId) as { state: string }).state).toBe('exhausted');
  });

  it('survives a broker restart mid-fire: a fresh Scheduler over the same DB does not re-fire', () => {
    const { scheduleId } = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'once', kind: 'once', requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    scheduler.tick();
    expect(msgCount()).toBe(1);
    // Simulate a restart: brand-new Scheduler + Store instances over the SAME durable DB.
    const store2 = new BrokerStore(db, clock, ids, 'b2');
    const scheduler2 = new Scheduler(db, clock, ids, store2);
    const r = scheduler2.tick();
    expect(r.fired).toBe(0); // exhausted + claim already owns the slot
    expect(msgCount()).toBe(1);
    expect(runCount(scheduleId)).toBe(1);
  });

  it('an interval schedule fires once per due slot as the clock advances; each slot is exactly-once', () => {
    const { scheduleId } = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'tick', kind: 'interval', scheduleExpr: '60000', minIntervalMs: 60000, requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    scheduler.tick(); // fire slot 1
    expect(msgCount()).toBe(1);
    scheduler.tick(); // not yet due again (next_run = now+60s)
    expect(msgCount()).toBe(1);
    clock.advance(60_000);
    scheduler.tick(); // slot 2 due
    expect(msgCount()).toBe(2);
    expect(runCount(scheduleId)).toBe(2);
    // Distinct fire-slots → distinct idempotency keys → distinct messages, one each.
    const keys = (db.prepare(`SELECT DISTINCT idempotency_key FROM messages WHERE sender_session_id='local-operator'`).all() as Array<{ idempotency_key: string }>).map((x) => x.idempotency_key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('scheduler gates', () => {
  it('quiet-hours skips the fire + advances next_run PAST the window (no busy-loop)', () => {
    // Clock at 23:30 UTC; quiet 22:00-06:00 → skip.
    clock.set(Date.parse('2026-01-01T23:30:00.000Z'));
    const { scheduleId } = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'q', kind: 'interval', scheduleExpr: '60000', minIntervalMs: 60000, quietHoursJson: JSON.stringify({ windows: [{ start: '22:00', end: '06:00' }] }), requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    const r = scheduler.tick();
    expect(r.fired).toBe(0);
    expect(msgCount()).toBe(0); // suppressed
    // next_run advanced PAST the quiet window (a run row records the skip).
    const runs = db.prepare('SELECT state, skip_reason FROM schedule_runs WHERE schedule_id=?').all(scheduleId) as Array<{ state: string; skip_reason: string | null }>;
    expect(runs.some((x) => x.state === 'skipped' && x.skip_reason === 'quiet_hours')).toBe(true);
    const next = (db.prepare('SELECT next_run FROM schedules WHERE schedule_id=?').get(scheduleId) as { next_run: string }).next_run;
    expect(inQuietHours(next, JSON.stringify({ windows: [{ start: '22:00', end: '06:00' }] }))).toBe(false); // advanced OUT of quiet hours
  });

  it('max_fires exhausts the schedule after N fires', () => {
    const { scheduleId } = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'x', kind: 'interval', scheduleExpr: '60000', minIntervalMs: 60000, maxFires: 2, requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    scheduler.tick(); clock.advance(60_000);
    scheduler.tick(); clock.advance(60_000);
    scheduler.tick(); // 3rd would exceed max_fires=2
    expect(msgCount()).toBe(2);
    expect((db.prepare('SELECT state FROM schedules WHERE schedule_id=?').get(scheduleId) as { state: string }).state).toBe('exhausted');
  });

  it('a paused schedule does not fire; cancel is terminal', () => {
    const { scheduleId } = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'p', kind: 'interval', scheduleExpr: '60000', minIntervalMs: 60000, requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    store.setScheduleState(scheduleId, 'paused');
    scheduler.tick();
    expect(msgCount()).toBe(0);
    store.setScheduleState(scheduleId, 'active');
    scheduler.tick();
    expect(msgCount()).toBe(1);
    store.setScheduleState(scheduleId, 'cancelled');
    clock.advance(60_000);
    scheduler.tick();
    expect(msgCount()).toBe(1); // cancelled → never fires again
  });

  it('a schedule to an UNKNOWN recipient records a failed run + advances, never crashing the tick', () => {
    const { scheduleId } = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'no-such-target', payloadText: 'x', kind: 'once', requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    expect(() => scheduler.tick()).not.toThrow();
    expect(msgCount()).toBe(0);
    const run = db.prepare('SELECT state, skip_reason FROM schedule_runs WHERE schedule_id=?').get(scheduleId) as { state: string; skip_reason: string | null };
    expect(run.state).toBe('failed');
    expect(run.skip_reason).toBe('recipient_error');
  });

  it('a "once" schedule blocked by quiet-hours is DEFERRED past the window (not dropped) and later fires exactly once', () => {
    // Regression: a one-time schedule whose only slot is inside a quiet window must be
    // retried past the window, never silently exhausted (message loss). Clock 23:30, quiet
    // 22:00-06:00 → the fire is blocked.
    clock.set(Date.parse('2026-01-01T23:30:00.000Z'));
    const quiet = JSON.stringify({ windows: [{ start: '22:00', end: '06:00' }] });
    const { scheduleId } = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'q-once', kind: 'once', quietHoursJson: quiet, requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    const r1 = scheduler.tick();
    expect(r1.fired).toBe(0);
    expect(msgCount()).toBe(0); // suppressed, NOT dropped
    // Still ALIVE (active), with next_run pushed OUT of the quiet window — never exhausted.
    const sched = db.prepare('SELECT state, next_run FROM schedules WHERE schedule_id=?').get(scheduleId) as { state: string; next_run: string | null };
    expect(sched.state).toBe('active');
    expect(sched.next_run).not.toBeNull();
    expect(inQuietHours(sched.next_run!, quiet)).toBe(false);
    // Advance to the deferred slot (past 06:00) and tick: the once schedule fires exactly one
    // message, then exhausts.
    clock.set(Date.parse(sched.next_run!));
    const r2 = scheduler.tick();
    expect(r2.fired).toBe(1);
    expect(msgCount()).toBe(1);
    expect((db.prepare('SELECT state FROM schedules WHERE schedule_id=?').get(scheduleId) as { state: string }).state).toBe('exhausted');
  });

  it('the reaper prunes OLD terminal schedule_runs (retention) but keeps recent + in-flight rows (exactly-once safe)', () => {
    // A long-lived interval schedule accumulates run rows; the reaper must prune terminal rows
    // whose fire-slot is past the retention horizon (they can never be re-selected) without
    // touching recent rows or the exactly-once CAS. Use a short 1h retention for the test.
    const reaper = new Reaper(db, clock, ids, { scheduleRunRetentionMs: 60 * 60_000 });
    // OLD schedule: fire 3 slots (all near t0), then never tick it again.
    const oldSched = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'old', kind: 'interval', scheduleExpr: '60000', minIntervalMs: 60000, requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    scheduler.tick(); clock.advance(60_000);
    scheduler.tick(); clock.advance(60_000);
    scheduler.tick();
    expect(runCount(oldSched.scheduleId)).toBe(3); // 3 old terminal 'sent' rows near t0
    // Cancel it so the post-jump tick doesn't fire its (now-overdue) backlog slot — we want
    // exactly its 3 old rows frozen in the run ledger.
    store.setScheduleState(oldSched.scheduleId, 'cancelled');
    // Jump 2h forward so those 3 fire-slots are now past the 1h retention horizon.
    clock.advance(2 * 60 * 60_000);
    // RECENT schedule: created + fired AFTER the jump → its run row is well within retention.
    const newSched = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'new', kind: 'once', requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    scheduler.tick();
    expect(runCount(newSched.scheduleId)).toBe(1); // 1 recent terminal row
    const r = reaper.sweep();
    expect(r.scheduleRunsPruned).toBe(3);                    // the 3 OLD rows pruned
    expect(runCount(oldSched.scheduleId)).toBe(0);           // old run ledger reclaimed
    expect(runCount(newSched.scheduleId)).toBe(1);           // recent run survived (exactly-once safe)
    // Exactly-once intact: re-ticking at the same clock creates no duplicate for the recent slot.
    const msgsBefore = msgCount();
    scheduler.tick();
    expect(msgCount()).toBe(msgsBefore);
  });

  it('a concurrency_key schedule keeps firing across slots (the terminal "sent" run never wedges it as in-flight)', () => {
    // Regression: the in-flight guard must count only 'claimed' (not the terminal 'sent'), else
    // a keyed schedule fires once then is skipped forever. createSchedule accepts concurrencyKey.
    const { scheduleId } = store.createSchedule({ createdByActor: 'local-operator', targetAddress: 'target-svc', payloadText: 'c', kind: 'interval', scheduleExpr: '60000', minIntervalMs: 60000, concurrencyKey: 'k1', requiresAck: false, requiresReply: false, nextRunAtIso: clock.nowIso() });
    scheduler.tick(); // slot 1 fires
    expect(msgCount()).toBe(1);
    clock.advance(60_000);
    scheduler.tick(); // slot 2 must ALSO fire (prior 'sent' run does not count as in-flight)
    expect(msgCount()).toBe(2);
    clock.advance(60_000);
    scheduler.tick(); // slot 3
    expect(msgCount()).toBe(3);
    expect(runCount(scheduleId)).toBe(3);
  });
});
