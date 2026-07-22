/**
 * BETA.11 (ADR 0038) — bounded MCP self-heal PLANNER.
 *
 * WHAT self-heal can and cannot do on the Claude Code platform (the honest boundary):
 *  - The MCP server is a stdio SUBPROCESS of an interactive `claude`. AgenTel cannot resurrect a
 *    process that Claude has not spawned, and cannot inject a turn into a cold-idle interactive
 *    session (that wake is unproven — ADR 0038). So self-heal is NOT "make any degraded session
 *    live from the outside."
 *  - What it CAN do, safely, on a path that IS executing (the eager-register path / any tool call):
 *    detect that the MCP↔broker channel is missing/stale, attempt a BOUNDED reconnect, and let the
 *    EXISTING register()/resolveReclaim gate re-establish identity + readiness. This module is the
 *    pure DECISION layer (should we attempt now? how long to back off? have we exhausted?), kept
 *    injectable so it is deterministic and hosted-safe; the actual reconnect is ensureBroker +
 *    register (unchanged, still fully gated — owner-secret + proven-liveness + epoch).
 *
 * SECURITY (review M1/M3): this planner NEVER forces readiness, never follows a map edge, never
 * caches authority. It only decides WHETHER to call the normal gated reconnect. On exhaustion it
 * yields `degrade` — routing stops treating the session as autonomously routable — it never
 * escalates to a spawn or a reroute (those are forbidden here; see ADR 0038 routing policy).
 */

/** The channel condition self-heal reacts to (derived from the activation signals). */
export type ChannelCondition =
  | 'connected'        // MCP↔broker channel is live — nothing to heal
  | 'disconnected'     // was connected, channel dropped — reconnect is appropriate
  | 'never_registered' // no mcp component this session yet (may be mid eager-register race)
  | 'broker_unreachable'; // no broker answering — ensureBroker will try to (re)start it

/** What the planner tells the caller to do next. */
export type SelfHealAction =
  | 'noop'          // already connected — do nothing
  | 'attempt'       // attempt a bounded reconnect NOW (via the normal gated register path)
  | 'backoff'       // too soon since the last attempt — wait
  | 'degrade';      // bounded attempts exhausted — stop routing, surface to operator/logs

export interface SelfHealState {
  /** Attempts made so far in the current degraded episode. */
  attempts: number;
  /** Monotonic ms of the last attempt (0 if none). */
  lastAttemptAt: number;
}

export interface SelfHealPolicy {
  /** Max bounded reconnect attempts before degrading (default 5). */
  maxAttempts: number;
  /** Base backoff (ms) — grows exponentially, capped (default 500ms base, 8s cap). */
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_SELF_HEAL_POLICY: SelfHealPolicy = { maxAttempts: 5, baseBackoffMs: 500, maxBackoffMs: 8000 };

/** The backoff (ms) required before the Nth attempt (0-indexed): base * 2^n, capped. Pure. */
export function backoffForAttempt(attempt: number, policy: SelfHealPolicy = DEFAULT_SELF_HEAL_POLICY): number {
  const grown = policy.baseBackoffMs * Math.pow(2, Math.max(0, attempt));
  return Math.min(grown, policy.maxBackoffMs);
}

/**
 * Decide the next self-heal action. Pure — no I/O, no timers; the caller supplies `now`. Bounded:
 * once `attempts >= maxAttempts` the episode is exhausted → `degrade` (never an unbounded retry
 * storm, never a spawn). A `connected` channel is always `noop` (and the caller should reset state).
 */
export function planSelfHeal(
  condition: ChannelCondition,
  state: SelfHealState,
  now: number,
  policy: SelfHealPolicy = DEFAULT_SELF_HEAL_POLICY,
): SelfHealAction {
  if (condition === 'connected') return 'noop';
  // Exhausted → degrade (stop autonomous routing; operator/logs surface it — never user narration).
  if (state.attempts >= policy.maxAttempts) return 'degrade';
  // Respect exponential backoff between attempts (a fresh episode with lastAttemptAt=0 attempts now).
  if (state.lastAttemptAt > 0) {
    const wait = backoffForAttempt(state.attempts, policy);
    if (now - state.lastAttemptAt < wait) return 'backoff';
  }
  return 'attempt';
}

/** Advance state after an attempt was made (caller records the try). Pure; returns fresh state. */
export function recordAttempt(state: SelfHealState, now: number): SelfHealState {
  return { attempts: state.attempts + 1, lastAttemptAt: now };
}

/** Reset the episode once the channel is healthy again. Pure. */
export function resetSelfHeal(): SelfHealState {
  return { attempts: 0, lastAttemptAt: 0 };
}
