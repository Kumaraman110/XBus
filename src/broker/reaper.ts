/**
 * Reliability reaper (reliability contract §4/§8). The deadline, retry, lease and
 * dead-letter MACHINERY lives in deadlines.ts / retry.ts / deadletter.ts, but
 * something has to RUN it: a `transport_written` delivery whose ack deadline
 * passes must move to `retry_wait`; an exhausted `retry_wait` must move to
 * `dead_letter`; a queued message past its acceptance TTL must `expire`; an
 * abandoned lease must be reclaimed. That is this module.
 *
 * The sweep is a PURE function of (DB state, now): calling it twice with no time
 * advance is idempotent. It is driven by a periodic timer in the daemon, but every
 * unit of work is exposed as an explicit `sweep()` so tests drive it with a
 * FakeClock — no real timers, no flakiness.
 *
 * Fairness / anti-starvation: within a sweep, due work is processed oldest-first
 * (by `updated_at`), and a per-session cap bounds how many items one busy session
 * can consume in a single sweep so a flood to one recipient cannot starve the
 * reaper's attention to others.
 */
import type { SqliteDriver } from '../database/connection.js';
import type { Clock, IdGen } from '../shared/clock.js';
import { DeliveryState } from '../protocol/states.js';
import { DEFAULT_BACKOFF, nextBackoffMs, type BackoffConfig } from './retry.js';
import { OPERATOR_SESSION_ID } from './operator.js';

export interface SweepResult {
  /** transport_written deliveries whose ack deadline passed -> retry_wait. */
  ackTimedOut: number;
  /** retry_wait deliveries with exhausted attempts -> dead_letter. */
  deadLettered: number;
  /** queued/retry_wait messages past their acceptance TTL -> expired. */
  expired: number;
  /** delivery_leases rows past expiry that were reclaimed (state held->expired). */
  leasesReclaimed: number;
  /** sessions with no meaningful activity for >15 days -> expired (beta.4). */
  sessionsExpired: number;
  /** terminal schedule_runs rows past the retention horizon that were pruned (beta.7). */
  scheduleRunsPruned: number;
}

export interface ReaperOptions {
  backoff?: BackoffConfig;
  /** Max deliveries one recipient session may have reaped in a single sweep
   *  (anti-starvation). 0 = unbounded. Default 256. */
  perSessionCap?: number;
  /** Beta.7 (ADR 0025): retention horizon (ms) for TERMINAL schedule_runs rows. A run row
   *  whose scheduled_for is older than (now - this) and whose state is terminal is pruned — its
   *  fire-slot can never be re-selected (next_run only advances forward), so deleting it is
   *  exactly-once-safe and stops the run ledger growing without bound. 0 disables pruning.
   *  Default 7 days (well past any restart/replay window). */
  scheduleRunRetentionMs?: number;
  /** Jitter RNG for backoff (injected for deterministic tests). Default Math.random
   *  is NOT used (it's unavailable in workflow scripts) — production passes a real
   *  source; if omitted, jitter is disabled (full backoff, no randomization). */
  rng?: () => number;
}

export class Reaper {
  private readonly backoff: BackoffConfig;
  private readonly perSessionCap: number;
  private readonly scheduleRunRetentionMs: number;
  private readonly rng: () => number;
  constructor(
    private readonly db: SqliteDriver,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    opts: ReaperOptions = {},
  ) {
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.perSessionCap = opts.perSessionCap ?? 256;
    this.scheduleRunRetentionMs = opts.scheduleRunRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
    // Default: deterministic full-backoff ceiling (rng()=1 ⇒ delay = ceil). A
    // caller that wants jitter injects an rng; tests inject a fixed value.
    this.rng = opts.rng ?? (() => 1);
  }

  private audit(type: string, messageId: string | null, fields: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO audit_events (audit_id, event_type, message_id, safe_metadata_json, created_at) VALUES (?,?,?,?,?)')
      .run(this.ids.next(), type, messageId, JSON.stringify(fields), this.clock.nowIso());
  }

  /** Run one full reaper pass. Idempotent given a fixed clock. */
  sweep(): SweepResult {
    return this.db.transaction(() => {
      const r = {
        ...this.reapAckTimeouts(),
        expired: this.reapAcceptanceTtl(),
        leasesReclaimed: this.reclaimLeases(),
        sessionsExpired: this.reapExpiredSessions(),
        scheduleRunsPruned: this.reapOldScheduleRuns(),
      };
      this.reapStalePendingNames();
      return r;
    });
  }

  /**
   * Beta.4 (ADR 0012 Decision 4): release a pending_name reservation whose TTL
   * (pending_name_expires_at, ~5 min) has lapsed — the session reverts to 'unnamed'
   * (still routable by its automatic_alias) so a long-abandoned name request does not
   * sit reserved forever. Idempotent (acts only on still-pending rows past the TTL).
   * Not counted in SweepResult (a maintenance detail, not a delivery outcome).
   */
  private reapStalePendingNames(): void {
    const now = this.clock.nowIso();
    const res = this.db.prepare(
      `UPDATE sessions SET session_name_state='unnamed', session_name=NULL, normalized_session_name=NULL, pending_name_expires_at=NULL, updated_at=? WHERE session_name_state='pending' AND pending_name_expires_at IS NOT NULL AND pending_name_expires_at <= ?`,
    ).run(now, now);
    if (res.changes > 0) this.audit('PENDING_NAME_RESERVATION_LAPSED', null, { count: res.changes });
  }

  /**
   * Beta.4 (ADR 0012 Decision 6): expire sessions with no MEANINGFUL activity for
   * >15 days. expires_at = last_meaningful_activity_at + 15d is maintained by the
   * meaningful-activity refresh; this pass acts when now >= expires_at. Per due
   * session, atomically (this whole sweep is one transaction):
   *   1. CAS expired_at (guards idempotence) + reason + readiness='disconnected'
   *      + release the name (session_name_state -> 'retired').
   *   2. Retire any live alias rows the session held (name returns to the pool).
   *   3. Dead-letter EVERY non-terminal delivery to this now-tombstoned recipient —
   *      queued, retry_wait, AND transport_written — with
   *      failure_category='recipient_inactive_15_days'. Including transport_written is
   *      REQUIRED for correctness: a message sent requiresAck=false + requiresReply=true
   *      is injected (transport_written) but NOT completed (completeIfNoResponseRequired
   *      only completes fire-and-forget), and carries no ack lease, so NO other reaper
   *      pass terminates it (reapAckTimeouts requires requires_ack=1 + a lease). Left in
   *      transport_written it would survive the 15-day expiry and then be RESURRECTED
   *      when store.register() re-homes transport_written rows on an expired-resume —
   *      violating the ADR 0012 no-resurrection / at-most-once invariant. Ack-required
   *      rows hold a lease and ack-time-out to retry_wait within minutes, so at 15-day
   *      expiry the transport_written rows are exactly the stranded reply-required
   *      bodies; dead-lettering them (and clearing any lease) completes the tombstone
   *      and makes the expired-resume re-home a genuine no-op.
   * The expired sessions row itself is the body-free tombstone (no separate table,
   * no tombstone message) — it durably carries name, id, last activity, expiry
   * time, and reason. session_id is NOT deleted (audit trail).
   */
  private reapExpiredSessions(): number {
    const now = this.clock.nowIso();
    // The reserved `local-operator` principal (ADR 0021) is NEVER expired: it keeps
    // expires_at NULL (so it should not appear here), but guard by id too so no path can
    // tombstone it — an expired operator would bounce every peer reply
    // (RECIPIENT_SESSION_EXPIRED) and dead-letter its inbound.
    const due = this.db.prepare(
      `SELECT session_id FROM sessions WHERE expired_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ? AND session_id <> ? ORDER BY expires_at ASC`,
    ).all(now, OPERATOR_SESSION_ID) as Array<{ session_id: string }>;
    let sessionsExpired = 0;
    for (const s of due) {
      // CAS on expired_at IS NULL → idempotent (a second sweep sees expired_at set).
      const res = this.db.prepare(
        `UPDATE sessions SET expired_at=?, expiration_reason='recipient_inactive_15_days', readiness='disconnected', session_name_state='retired', normalized_session_name=NULL, pending_name_expires_at=NULL, updated_at=? WHERE session_id=? AND expired_at IS NULL`,
      ).run(now, now, s.session_id);
      if (res.changes === 0) continue; // already expired by a concurrent/earlier pass
      // Release any live alias rows (name returns to the pool for reuse).
      this.db.prepare(`UPDATE aliases SET active=0, retired_at=? WHERE session_id=? AND active=1`).run(now, s.session_id);
      // Beta.8 (ADR 0027): release the durable name-ownership row in the SAME sweep so the two
      // name representations never diverge (no orphan 'active' name_ownership blocking reuse).
      // The owner_secret_hash is preserved (a released identity keeps its secret) — only the
      // routing (normalized_name/state) is cleared, matching the sessions-row retire above.
      this.db.prepare(`UPDATE name_ownership SET name_state='released', normalized_name=NULL, updated_at=? WHERE current_session_id=? AND name_state IN ('active','pending')`).run(now, s.session_id);
      // Dead-letter EVERY non-terminal delivery to this tombstoned recipient —
      // queued, retry_wait AND transport_written (see the transport_written rationale
      // in the doc-comment). Clearing lease_expires_at makes the terminal rows
      // reaper-inert; the terminal states (completed/dead_letter/rejected/expired) are
      // untouched (this only advances non-terminal rows to dead_letter).
      this.db.prepare(
        `UPDATE deliveries SET state='${DeliveryState.DEAD_LETTER}', failure_category='recipient_inactive_15_days', next_attempt_at=NULL, lease_expires_at=NULL, updated_at=? WHERE recipient_session_id=? AND state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}','${DeliveryState.TRANSPORT_WRITTEN}')`,
      ).run(now, s.session_id);
      // Release any held leases for this recipient's now-dead-lettered deliveries.
      this.db.prepare(`UPDATE delivery_leases SET state='expired', released_at=? WHERE state='held' AND message_id IN (SELECT message_id FROM deliveries WHERE recipient_session_id=? AND state='${DeliveryState.DEAD_LETTER}' AND failure_category='recipient_inactive_15_days')`).run(now, s.session_id);
      this.audit('SESSION_EXPIRED', null, { sessionId: s.session_id, reason: 'recipient_inactive_15_days' });
      sessionsExpired++;
    }
    return sessionsExpired;
  }

  /**
   * transport_written deliveries whose lease_expires_at (the ack deadline anchor)
   * has passed and which were never acked. They go to retry_wait (++ack-timeout
   * attempt) with a backoff next_attempt_at, OR to dead_letter if the ack-timeout
   * budget is exhausted. Processed oldest-first with a per-session cap.
   */
  private reapAckTimeouts(): { ackTimedOut: number; deadLettered: number } {
    const now = this.clock.nowIso();
    // ELIGIBILITY: only ACK-REQUIRED messages may enter the ack-timeout path. A
    // message with requires_ack=0 (fire-and-forget, or no-ack-reply-required) is
    // NOT awaiting an acknowledgement, so its lease_expires_at must never trigger
    // a requeue/dead-letter — doing so redelivers a message that was already
    // terminal-by-contract. The JOIN + `m.requires_ack=1` filter is the fix; the
    // per-statement guarded UPDATE (with the same requires_ack subquery) backstops
    // it against a race where a message's eligibility changed between SELECT and
    // UPDATE.
    const rows = this.db.prepare(
      `SELECT d.message_id AS message_id, d.recipient_session_id AS recipient_session_id, d.attempt_ack_timeout AS attempt_ack_timeout
       FROM deliveries d JOIN messages m ON m.message_id=d.message_id
       WHERE d.state='${DeliveryState.TRANSPORT_WRITTEN}'
         AND m.requires_ack=1
         AND d.lease_expires_at IS NOT NULL AND d.lease_expires_at <= ?
       ORDER BY d.updated_at ASC`,
    ).all(now) as Array<{ message_id: string; recipient_session_id: string; attempt_ack_timeout: number }>;

    // Reusable guard fragment: the UPDATE only fires if the delivery is still
    // transport_written AND its message still requires ack. A non-ack message can
    // never be requeued/dead-lettered even if it raced into this loop.
    const ackGuard = `AND (SELECT m.requires_ack FROM messages m WHERE m.message_id=deliveries.message_id)=1`;

    let ackTimedOut = 0;
    let deadLettered = 0;
    const perSession = new Map<string, number>();
    for (const r of rows) {
      const used = perSession.get(r.recipient_session_id) ?? 0;
      if (this.perSessionCap > 0 && used >= this.perSessionCap) continue; // fairness cap
      perSession.set(r.recipient_session_id, used + 1);

      const nextAttempt = r.attempt_ack_timeout + 1;
      if (nextAttempt >= this.backoff.maxAttempts) {
        // Exhausted: dead-letter (the receiver never acknowledged within budget).
        const res = this.db.prepare(
          `UPDATE deliveries SET state='${DeliveryState.DEAD_LETTER}', attempt_ack_timeout=?, failure_category='ack_timeout_exhausted', lease_expires_at=NULL, updated_at=? WHERE message_id=? AND state='${DeliveryState.TRANSPORT_WRITTEN}' ${ackGuard}`,
        ).run(nextAttempt, now, r.message_id);
        if (res.changes > 0) { deadLettered++; this.audit('ACK_TIMEOUT_DEAD_LETTER', r.message_id, { attempt: nextAttempt }); }
      } else {
        // Re-queue for another delivery attempt. transport_written -> retry_wait.
        // Arm next_attempt_at with bounded exponential backoff (jitter via
        // injected rng) so a recipient that keeps failing to ack is NOT
        // re-injected on a tight loop — the injection-selection queries gate on
        // next_attempt_at <= now (see delivery.ts).
        const delayMs = nextBackoffMs(nextAttempt - 1, this.backoff, this.rng);
        const nextAttemptAt = new Date(this.clock.nowMs() + delayMs).toISOString();
        const res = this.db.prepare(
          `UPDATE deliveries SET state='${DeliveryState.RETRY_WAIT}', attempt_ack_timeout=?, failure_category='ack_timeout', transport_written_at=NULL, lease_expires_at=NULL, target_instance_id=NULL, next_attempt_at=?, updated_at=? WHERE message_id=? AND state='${DeliveryState.TRANSPORT_WRITTEN}' ${ackGuard}`,
        ).run(nextAttempt, nextAttemptAt, now, r.message_id);
        if (res.changes > 0) {
          // Release any held lease for this delivery so a retry can re-acquire.
          this.db.prepare(`UPDATE delivery_leases SET state='expired', released_at=? WHERE message_id=? AND state='held'`).run(now, r.message_id);
          ackTimedOut++;
          this.audit('ACK_TIMEOUT_REQUEUE', r.message_id, { attempt: nextAttempt, nextAttemptAt, delayMs });
        }
      }
    }
    return { ackTimedOut, deadLettered };
  }

  /**
   * queued / retry_wait messages whose acceptance TTL (messages.expires_at) has
   * passed before EVER being injected -> expired. This is NOT a delivery failure
   * (the receiver simply never reached a checkpoint in time).
   */
  private reapAcceptanceTtl(): number {
    const now = this.clock.nowIso();
    const rows = this.db.prepare(
      `SELECT d.message_id
       FROM deliveries d JOIN messages m ON m.message_id=d.message_id
       WHERE d.state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}')
         AND m.expires_at IS NOT NULL AND m.expires_at <= ?
       ORDER BY d.updated_at ASC`,
    ).all(now) as Array<{ message_id: string }>;
    let expired = 0;
    for (const r of rows) {
      const res = this.db.prepare(
        `UPDATE deliveries SET state='${DeliveryState.EXPIRED}', failure_category='expired_before_injection', updated_at=? WHERE message_id=? AND state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}')`,
      ).run(now, r.message_id);
      if (res.changes > 0) { expired++; this.audit('EXPIRED_BEFORE_INJECTION', r.message_id, {}); }
    }
    return expired;
  }

  /**
   * Reclaim leases whose holder is gone: any `held` lease past its expiry is
   * marked `expired` and released. (The deliveries it guarded are handled by the
   * ack-timeout pass; this keeps the lease table from accumulating dead holds and
   * frees the unique active-lease slot for a re-acquire.)
   */
  private reclaimLeases(): number {
    const now = this.clock.nowIso();
    const res = this.db.prepare(
      `UPDATE delivery_leases SET state='expired', released_at=? WHERE state='held' AND expires_at <= ?`,
    ).run(now, now);
    if (res.changes > 0) this.audit('LEASES_RECLAIMED', null, { count: res.changes });
    return res.changes;
  }

  /**
   * Beta.7 (ADR 0025): prune TERMINAL schedule_runs rows older than the retention horizon so the
   * exactly-once run ledger doesn't grow without bound (an interval schedule at the floor makes
   * ~1440 rows/day forever). Only terminal states are pruned (sent/skipped/failed) and only rows
   * whose scheduled_for is older than (now - retention) — such a fire-slot can NEVER be
   * re-selected, because a schedule's next_run only advances forward, so the claim-UNIQUE it
   * anchored is no longer needed. Never touches a 'claimed' (in-flight) row. Idempotent.
   */
  private reapOldScheduleRuns(): number {
    if (this.scheduleRunRetentionMs <= 0) return 0;
    const cutoff = new Date(this.clock.nowMs() - this.scheduleRunRetentionMs).toISOString();
    try {
      const res = this.db.prepare(
        `DELETE FROM schedule_runs WHERE state IN ('sent','skipped','failed') AND scheduled_for < ?`,
      ).run(cutoff);
      if (res.changes > 0) this.audit('SCHEDULE_RUNS_PRUNED', null, { count: res.changes, cutoff });
      return res.changes;
    } catch { return 0; } // schedule_runs absent on a pre-v9 DB (shouldn't happen post-migration)
  }
}
