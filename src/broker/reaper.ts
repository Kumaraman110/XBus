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
}

export interface ReaperOptions {
  backoff?: BackoffConfig;
  /** Max deliveries one recipient session may have reaped in a single sweep
   *  (anti-starvation). 0 = unbounded. Default 256. */
  perSessionCap?: number;
  /** Jitter RNG for backoff (injected for deterministic tests). Default Math.random
   *  is NOT used (it's unavailable in workflow scripts) — production passes a real
   *  source; if omitted, jitter is disabled (full backoff, no randomization). */
  rng?: () => number;
}

export class Reaper {
  private readonly backoff: BackoffConfig;
  private readonly perSessionCap: number;
  private readonly rng: () => number;
  constructor(
    private readonly db: SqliteDriver,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    opts: ReaperOptions = {},
  ) {
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.perSessionCap = opts.perSessionCap ?? 256;
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
   *   3. Dead-letter the recipient's pending deliveries (queued/retry_wait ONLY)
   *      with failure_category='recipient_inactive_15_days'. This NEVER touches the
   *      ack-timeout path or transport_written rows — the non-ACK invariant (I3) is
   *      preserved by construction (non-ack messages are already terminal-completed
   *      at injection; we only sweep not-yet-injected deliveries).
   * The expired sessions row itself is the body-free tombstone (no separate table,
   * no tombstone message) — it durably carries name, id, last activity, expiry
   * time, and reason. session_id is NOT deleted (audit trail).
   */
  private reapExpiredSessions(): number {
    const now = this.clock.nowIso();
    const due = this.db.prepare(
      `SELECT session_id FROM sessions WHERE expired_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at ASC`,
    ).all(now) as Array<{ session_id: string }>;
    let sessionsExpired = 0;
    for (const s of due) {
      // CAS on expired_at IS NULL → idempotent (a second sweep sees expired_at set).
      const res = this.db.prepare(
        `UPDATE sessions SET expired_at=?, expiration_reason='recipient_inactive_15_days', readiness='disconnected', session_name_state='retired', normalized_session_name=NULL, pending_name_expires_at=NULL, updated_at=? WHERE session_id=? AND expired_at IS NULL`,
      ).run(now, now, s.session_id);
      if (res.changes === 0) continue; // already expired by a concurrent/earlier pass
      // Release any live alias rows (name returns to the pool for reuse).
      this.db.prepare(`UPDATE aliases SET active=0, retired_at=? WHERE session_id=? AND active=1`).run(now, s.session_id);
      // Dead-letter ONLY not-yet-injected deliveries; never the ack-timeout path.
      this.db.prepare(
        `UPDATE deliveries SET state='${DeliveryState.DEAD_LETTER}', failure_category='recipient_inactive_15_days', next_attempt_at=NULL, updated_at=? WHERE recipient_session_id=? AND state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}')`,
      ).run(now, s.session_id);
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
}
