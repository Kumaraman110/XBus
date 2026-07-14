/**
 * Opt-in managed execution — the SCHEDULER (beta.7 Phase 3, ADR 0025).
 *
 * Mirrors the Reaper exactly: `tick()` is a PURE function of (DB, now) wrapped in the caller's
 * transaction machinery, idempotent at a fixed clock, driven by an unref'd daemon setInterval
 * (0 disables; tests call runSchedulerTick directly with a FakeClock). It never pushes to a
 * session (delivery stays pull-only) — a due schedule ENQUEUES via store.operatorSend and the
 * message drains at the target's next checkpoint (the durable FLOOR). A resident SessionStart
 * rewaker hook (channel/rewaker.ts) only accelerates that.
 *
 * EXACTLY-ONCE across a duplicate tick AND a broker restart mid-fire:
 *   - CLAIM: `INSERT OR IGNORE schedule_runs (schedule_id, scheduled_for)` — UNIQUE makes a
 *     duplicate tick's loser a no-op (changes===0 → skip).
 *   - SEND: store.operatorSend with idempotencyKey='sched:<id>:<scheduled_for>' — ux_idem makes
 *     a restart re-fire a no-op returning the same message id.
 *   - ADVANCE: next_run/last_run/fires_used in the SAME transaction, so a crash before commit
 *     rolls back the whole fire (message included) and a crash after commit cannot re-fire
 *     (next_run advanced + both UNIQUEs). No claim_expires_at lease is needed.
 */
import type { SqliteDriver } from '../database/connection.js';
import type { Clock, IdGen } from '../shared/clock.js';
import type { BrokerStore } from './store.js';
import { isXBusError } from '../protocol/errors.js';

export interface SchedulerTickResult {
  fired: number;
  skipped: number;
  failed: number;
}

/** A quiet-hours window in the schedule's timezone: [start,end) as "HH:MM" (24h). A window
 *  where start > end wraps past midnight. */
interface QuietWindow { start: string; end: string; }
interface QuietHours { windows?: QuietWindow[]; }

/** Minutes-since-midnight of an ISO instant, in UTC (schedules default to UTC; a real tz db is
 *  out of scope for beta.7 — timezone is stored + honored as an offset-free UTC label). */
function utcMinutes(iso: string): number {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}
function hhmmToMin(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Is `nowIso` inside any quiet window? Pure. A wrap-past-midnight window (start>end) matches
 *  minutes >= start OR < end. */
export function inQuietHours(nowIso: string, quietHoursJson: string | null): boolean {
  if (!quietHoursJson) return false;
  let qh: QuietHours;
  try { qh = JSON.parse(quietHoursJson) as QuietHours; } catch { return false; }
  const cur = utcMinutes(nowIso);
  for (const w of qh.windows ?? []) {
    const s = hhmmToMin(w.start); const e = hhmmToMin(w.end);
    if (s < 0 || e < 0) continue;
    if (s <= e) { if (cur >= s && cur < e) return true; }
    else { if (cur >= s || cur < e) return true; } // wraps midnight
  }
  return false;
}

/**
 * Compute the next run instant AT OR AFTER `afterMs` for a schedule. Deterministic + RNG-free.
 * 'once' → null (fires once, already claimed). 'interval' → afterMs + interval (schedule_expr
 * is the interval ms). 'cron' is intentionally minimal for beta.7: schedule_expr may be an
 * ISO instant (treated as 'once') or an interval-ms string; a full cron parser is deferred.
 */
export function computeNextRun(kind: string, scheduleExpr: string | null, afterMs: number, minIntervalMs: number): number | null {
  if (kind === 'once') return null;
  if (kind === 'interval') {
    const raw = Number(scheduleExpr ?? '');
    const interval = Number.isFinite(raw) && raw > 0 ? Math.max(raw, minIntervalMs) : minIntervalMs;
    return afterMs + interval;
  }
  // 'cron' minimal: an interval-ms fallback (a real cron grammar is a future ADR).
  const raw = Number(scheduleExpr ?? '');
  if (Number.isFinite(raw) && raw > 0) return afterMs + Math.max(raw, minIntervalMs);
  return null;
}

interface DueSchedule {
  schedule_id: string; target_address: string; payload_text: string; payload_kind: string;
  requires_ack: number; requires_reply: number; kind: string; schedule_expr: string | null;
  quiet_hours_json: string | null; delivery_mode: string; min_interval_ms: number;
  wake_limit_per_day: number | null; wakes_today: number; wakes_today_date: string | null;
  next_run: string | null; max_fires: number | null; fires_used: number; concurrency_key: string | null;
}

export class Scheduler {
  constructor(
    private readonly db: SqliteDriver,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    private readonly store: BrokerStore,
    /** Per-session cross-schedule wake cap per UTC day (loop-storm guard). 0 = unlimited. */
    private readonly perSessionWakeCapPerDay = 200,
  ) {}

  private audit(type: string, fields: Record<string, unknown>): void {
    try {
      this.db.prepare('INSERT INTO audit_events (audit_id, event_type, safe_metadata_json, created_at) VALUES (?,?,?,?)')
        .run(this.ids.next(), type, JSON.stringify(fields), this.clock.nowIso());
    } catch { /* audit best-effort */ }
  }

  /**
   * Run one scheduler pass: fire every schedule whose next_run <= now. Idempotent at a fixed
   * clock (a second call with no time advance re-selects nothing new — the claim UNIQUE + the
   * advanced next_run absorb it). Each schedule fires in its OWN transaction so one failure
   * can't roll back another's claim.
   */
  tick(): SchedulerTickResult {
    const now = this.clock.nowIso();
    const due = this.db.prepare(
      `SELECT schedule_id, target_address, payload_text, payload_kind, requires_ack, requires_reply,
              kind, schedule_expr, quiet_hours_json, delivery_mode, min_interval_ms,
              wake_limit_per_day, wakes_today, wakes_today_date, next_run, max_fires, fires_used, concurrency_key
         FROM schedules
        WHERE state='active' AND next_run IS NOT NULL AND next_run <= ?
        ORDER BY next_run ASC`,
    ).all(now) as DueSchedule[];

    const r: SchedulerTickResult = { fired: 0, skipped: 0, failed: 0 };
    for (const s of due) {
      try {
        const outcome = this.fireOne(s, now);
        if (outcome === 'fired') r.fired++;
        else if (outcome === 'skipped') r.skipped++;
      } catch (e) {
        r.failed++;
        this.audit('SCHEDULE_TICK_ERROR', { scheduleId: s.schedule_id, error: isXBusError(e) ? e.code : (e as Error).message });
      }
    }
    return r;
  }

  /** Fire (or skip) ONE due schedule inside a single transaction. Returns the outcome. */
  private fireOne(s: DueSchedule, now: string): 'fired' | 'skipped' {
    return this.db.transaction(() => {
      const scheduledFor = s.next_run!; // the fire-slot instant
      const idemKey = `sched:${s.schedule_id}:${scheduledFor}`;
      // STEP 1 — CLAIM (the exactly-once CAS). A duplicate tick / crash-replay loses here.
      const claim = this.db.prepare(
        `INSERT OR IGNORE INTO schedule_runs (run_id, schedule_id, scheduled_for, idempotency_key, state, claimed_at, created_at, updated_at)
         VALUES (?,?,?,?, 'claimed', ?,?,?)`,
      ).run(this.ids.next(), s.schedule_id, scheduledFor, idemKey, now, now, now);
      if (claim.changes === 0) {
        // Already claimed by a prior/concurrent tick — advance next_run so we stop re-selecting
        // this slot, then no-op. (The winning claim owns the send.) 'terminal': the winner has
        // handled this slot; a 'once' whose slot was already claimed is done.
        this.advance(s, now, 'terminal');
        return 'skipped';
      }

      const setRun = (state: string, extra: Record<string, string | number | null> = {}): void => {
        const cols = Object.keys(extra);
        const sets = ['state=?', 'updated_at=?', ...cols.map((c) => `${c}=?`)].join(', ');
        this.db.prepare(`UPDATE schedule_runs SET ${sets} WHERE schedule_id=? AND scheduled_for=?`)
          .run(state, now, ...cols.map((c) => extra[c] ?? null), s.schedule_id, scheduledFor);
      };

      // STEP 2 — GATES. A blocked fire records a skip + DEFERS past the block so the tick
      // doesn't busy-loop re-selecting the same due slot. Deferral (mode 'deferred') keeps a
      // 'once' schedule ALIVE with a new future next_run — a transiently-blocked one-time task
      // must be retried, never dropped (a fired=false advance would exhaust it → message loss).
      if (inQuietHours(now, s.quiet_hours_json)) {
        setRun('skipped', { skip_reason: 'quiet_hours' });
        this.advance(s, now, 'deferred');
        this.audit('SCHEDULE_SKIPPED_QUIET_HOURS', { scheduleId: s.schedule_id });
        return 'skipped';
      }
      // Per-schedule daily wake limit.
      const today = now.slice(0, 10);
      const wakesToday = s.wakes_today_date === today ? s.wakes_today : 0;
      if (s.wake_limit_per_day !== null && wakesToday >= s.wake_limit_per_day) {
        setRun('skipped', { skip_reason: 'wake_limit' });
        this.advance(s, now, 'deferred');
        this.audit('SCHEDULE_SKIPPED_WAKE_LIMIT', { scheduleId: s.schedule_id });
        return 'skipped';
      }
      // Per-session cross-schedule wake cap (loop-storm guard): count TODAY's fires to any
      // schedule targeting the same address. A run is "counted" once it is enqueued ('sent') —
      // that is the schedule_runs terminal success state (setRun only ever writes
      // skipped/sent/failed), so we count 'sent' alone here (see the concurrency guard note).
      if (this.perSessionWakeCapPerDay > 0) {
        const perSession = (this.db.prepare(
          `SELECT COUNT(*) n FROM schedule_runs sr JOIN schedules sc ON sc.schedule_id=sr.schedule_id
            WHERE sc.target_address=? AND sr.state='sent' AND substr(sr.scheduled_for,1,10)=?`,
        ).get(s.target_address, today) as { n: number }).n;
        if (perSession >= this.perSessionWakeCapPerDay) {
          setRun('skipped', { skip_reason: 'session_wake_cap' });
          this.advance(s, now, 'deferred');
          this.audit('SCHEDULE_SKIPPED_SESSION_CAP', { scheduleId: s.schedule_id });
          return 'skipped';
        }
      }
      // Concurrency: at most one OUTSTANDING (not-yet-enqueued) run per concurrency_key. Only
      // 'claimed' counts as in-flight — 'sent' is the terminal success state for a run (nothing
      // ever advances a run from 'sent' to delivered/completed), so counting 'sent' would wedge
      // every keyed schedule after its first fire (the stale 'sent' row would look perpetually
      // in-flight). Our own just-claimed row is the 1 we allow.
      if (s.concurrency_key) {
        const inflight = (this.db.prepare(
          `SELECT COUNT(*) n FROM schedule_runs sr JOIN schedules sc ON sc.schedule_id=sr.schedule_id
            WHERE sc.concurrency_key=? AND sr.state='claimed'`,
        ).get(s.concurrency_key) as { n: number }).n;
        if (inflight > 1) { // >1 because our own just-claimed row counts
          setRun('skipped', { skip_reason: 'concurrency' });
          this.advance(s, now, 'deferred');
          this.audit('SCHEDULE_SKIPPED_CONCURRENCY', { scheduleId: s.schedule_id });
          return 'skipped';
        }
      }

      // STEP 3 — SEND via the operator (ux_idem makes a restart re-fire a no-op). operatorSend
      // is savepoint-reentrant, so it composes inside this transaction. A refused recipient
      // (expired/unknown/self) → record a skip + advance, never crash the tick.
      try {
        const sent = this.store.operatorSend({
          to: s.target_address, text: s.payload_text, kind: (s.payload_kind === 'event' ? 'event' : 'request'),
          requiresAck: s.requires_ack === 1, requiresReply: s.requires_reply === 1, idempotencyKey: idemKey,
          metadata: { xbus_scheduled: '1', xbus_schedule_id: s.schedule_id },
        });
        setRun('sent', { message_id: sent.messageId });
        // wake counters
        this.db.prepare('UPDATE schedules SET wakes_today=?, wakes_today_date=? WHERE schedule_id=?')
          .run(wakesToday + 1, today, s.schedule_id);
      } catch (e) {
        const code = isXBusError(e) ? e.code : 'internal';
        setRun('failed', { skip_reason: 'recipient_error', error_code: code });
        // A hard recipient error (expired/unknown/self) is terminal for THIS slot — advance
        // normally (a 'once' exhausts; an interval moves to its next slot). We don't infinitely
        // retry a permanently-bad address.
        this.advance(s, now, 'terminal');
        this.audit('SCHEDULE_FIRE_FAILED', { scheduleId: s.schedule_id, code });
        return 'skipped';
      }

      // STEP 4 — ADVANCE (fires_used++, next_run, exhausted).
      this.advance(s, now, 'fired');
      this.audit('SCHEDULE_FIRED', { scheduleId: s.schedule_id, scheduledFor });
      return 'fired';
    });
  }

  /**
   * Advance a schedule's next_run/last_run after handling one due slot. `mode`:
   *   - 'fired'    — a message was enqueued: fires_used++, advance to the next slot, exhaust a
   *                  'once' or a max_fires-reached schedule.
   *   - 'terminal' — this slot is permanently handled without a live retry (claim-loser, hard
   *                  recipient error): advance/exhaust exactly like a fire but WITHOUT fires_used++.
   *   - 'deferred' — a transient GATE blocked this slot (quiet-hours / wake-limit / concurrency):
   *                  keep the schedule ALIVE with a future next_run, even for 'once'. A one-time
   *                  task blocked by quiet-hours MUST be retried past the window, never dropped.
   * Deterministic; RNG-free.
   */
  private advance(s: DueSchedule, now: string, mode: 'fired' | 'terminal' | 'deferred'): void {
    const nowMs = Date.parse(now);
    const fired = mode === 'fired';
    const firesUsed = s.fires_used + (fired ? 1 : 0);

    const step = Math.max(s.min_interval_ms, 15 * 60_000);
    // The next candidate instant. A recurrence kind ('interval'/'cron') yields a strictly-future
    // slot from computeNextRun. A 'once' yields null; when we're DEFERRING a 'once' (transient
    // gate) it must still be retried, so seed the candidate one step past `now` (strictly after
    // the current, blocked instant) and let the quiet-hours push-loop move it out of the window.
    let nextRunMs = computeNextRun(s.kind, s.schedule_expr, nowMs, s.min_interval_ms);
    if (mode === 'deferred' && nextRunMs === null) nextRunMs = nowMs + step;
    // If quiet-hours would still block the candidate next_run, keep pushing by a bounded number
    // of steps so we never schedule INTO a quiet window (advance PAST it).
    if (nextRunMs !== null && s.quiet_hours_json) {
      for (let i = 0; i < 96 && inQuietHours(new Date(nextRunMs).toISOString(), s.quiet_hours_json); i++) {
        nextRunMs += step;
      }
    }

    // A deferral NEVER exhausts (the task still owes a delivery). A fire/terminal exhausts a
    // 'once' or a max_fires-reached schedule as before.
    const exhausted = mode !== 'deferred' && ((s.max_fires !== null && firesUsed >= s.max_fires) || s.kind === 'once');
    const nextRun = exhausted ? null : (nextRunMs !== null ? new Date(nextRunMs).toISOString() : null);
    this.db.prepare(
      `UPDATE schedules SET fires_used=?, last_run=?, next_run=?, state=CASE WHEN ? THEN 'exhausted' ELSE state END, updated_at=? WHERE schedule_id=?`,
    ).run(firesUsed, fired ? now : s.next_run, nextRun, exhausted ? 1 : 0, now, s.schedule_id);
  }
}
