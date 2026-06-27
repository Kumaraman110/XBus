/**
 * Three distinct time domains (reliability contract §5). Do NOT collapse to one TTL.
 *
 *  1. acceptanceTtl   — how long a message may stay queued before FIRST context
 *                       injection. Expiry here = "expired_before_injection", which
 *                       is NOT a delivery failure.
 *  2. responseDeadline — how long AFTER context injection the receiver may ack/
 *                        complete. Once injected, ordinary queue TTL must not erase
 *                        the receiver's authority mid-turn — this deadline governs.
 *  3. retention       — how long terminal records/receipts/audit/dead-letters
 *                       remain queryable.
 *
 * Audit uses wall-clock timestamps; in-process elapsed decisions should use a
 * monotonic source. Deadlines are stored as absolute wall-clock ISO strings and
 * recomputed deterministically on restart from (anchor + duration).
 */
export interface TimeDomains {
  acceptanceTtlMs: number;
  responseDeadlineMs: number;
  retentionMs: number;
  /** Whether paused/DND/manual waiting counts toward acceptanceTtl (explicit,
   *  user-visible policy). Default false: waiting does NOT burn acceptance TTL. */
  waitingCountsTowardAcceptance: boolean;
}

export const DEFAULT_TIME_DOMAINS: TimeDomains = {
  acceptanceTtlMs: 24 * 60 * 60_000, // 24h to reach a checkpoint
  responseDeadlineMs: 10 * 60_000, // 10m to ack after injection
  retentionMs: 7 * 24 * 60 * 60_000, // 7d terminal-record retention
  waitingCountsTowardAcceptance: false,
};

/**
 * Acceptance expiry anchor. The message's createdAt is the anchor; if waiting
 * does NOT count, the broker must add accumulated waiting time back (tracked as
 * `pausedAccumMs`) so a long pause doesn't expire a message before it was ever
 * eligible. Returns the absolute expiry instant (ms).
 */
export function acceptanceExpiryMs(createdAtMs: number, pausedAccumMs: number, d: TimeDomains): number {
  const effective = d.waitingCountsTowardAcceptance ? createdAtMs : createdAtMs + pausedAccumMs;
  return effective + d.acceptanceTtlMs;
}

/** Response deadline anchored at the verified context-injection instant. */
export function responseDeadlineMs(injectedAtMs: number, d: TimeDomains): number {
  return injectedAtMs + d.responseDeadlineMs;
}

/** Retention cutoff: terminal records older than this are pruneable. */
export function retentionCutoffMs(nowMs: number, d: TimeDomains): number {
  return nowMs - d.retentionMs;
}

/**
 * Clock-safety: deadline comparisons must be monotonic-ordering-safe. We compare
 * absolute instants; a backward wall-clock jump cannot make an already-passed
 * deadline "un-pass" because we also record a monotonic checkpoint. This helper
 * decides expiry using BOTH: expired iff wall-clock passed AND monotonic elapsed
 * passed (when a monotonic anchor is available).
 */
export function isExpired(deadlineMs: number, nowWallMs: number, opts?: { monoElapsedMs?: number; monoBudgetMs?: number }): boolean {
  const wallPassed = nowWallMs >= deadlineMs;
  if (opts?.monoElapsedMs !== undefined && opts.monoBudgetMs !== undefined) {
    return wallPassed && opts.monoElapsedMs >= opts.monoBudgetMs;
  }
  return wallPassed;
}
