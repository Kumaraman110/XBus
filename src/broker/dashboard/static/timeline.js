/* XBus dashboard — conversation timeline state derivation (beta.10, Train B). PURE, CSP-safe.
 *
 * Derives the SEVEN user-facing timeline states from fields the thread projection ALREADY
 * carries — no new broker data (WS3 dep #3 avoided where derivable):
 *   queued | injected | acknowledged | reply-pending | replied | failed | expired
 * and classifies "stalled/unanswered" operator work so the console can surface what needs
 * attention. Written as an ES module for unit-testability; also published on window.XBusTimeline.
 *
 * Field basis (DashboardThreadTurn): deliveryState {queued,delivered,acknowledged,replied,failed},
 * ackStatus {accepted,rejected,null}, requiresReply, expiresAt (ISO|null), authorType {operator,claude}.
 *
 * NOTE for WS3 (dep #3): the ONLY state we cannot always distinguish from current fields is a
 * server-side "dispatching" vs plain "queued" — both map to queued, which is correct for the
 * operator's mental model. If a future need arises to show "in-flight to transport" distinctly,
 * that would need the raw pre-map delivery state in the projection. Everything else is derivable.
 */
'use strict';

export const TIMELINE_STATES = ['queued', 'injected', 'acknowledged', 'reply-pending', 'replied', 'failed', 'expired'];

/** Default: an operator turn with no progress for this many ms is "stalled" (needs attention). */
export const STALL_THRESHOLD_MS = 10 * 60_000;

const LABELS = {
  queued: 'Queued — waiting for recipient checkpoint',
  injected: 'Injected — delivered to the recipient',
  acknowledged: 'Acknowledged',
  'reply-pending': 'Acknowledged — awaiting reply',
  replied: 'Replied',
  failed: 'Failed',
  expired: 'Expired — deadline passed before completion',
};

/** Human label for a derived timeline state. */
export function turnStateLabel(state) { return LABELS[state] || String(state); }

function isPast(iso, nowMs) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= nowMs;
}

/**
 * Derive one turn's timeline state (first-match-wins, top-down):
 *  1. replied  — terminal success (beats a passed deadline)
 *  2. failed   — raw failed OR the ack was rejected
 *  3. expired  — a passed deadline on a not-yet-terminal turn
 *  4. reply-pending / acknowledged — acked; split on whether a reply is still expected
 *  5. injected — delivered/transport-written, not yet acked
 *  6. queued   — still awaiting a checkpoint
 */
export function deriveTurnState(turn, nowMs) {
  const t = turn || {};
  const ds = t.deliveryState;
  if (ds === 'replied') return 'replied';
  if (ds === 'failed' || t.ackStatus === 'rejected') return 'failed';
  if (isPast(t.expiresAt, nowMs)) return 'expired';
  if (ds === 'acknowledged') return t.requiresReply ? 'reply-pending' : 'acknowledged';
  if (ds === 'delivered') return 'injected';
  return 'queued';
}

/**
 * Is this OPERATOR turn stalled/unanswered (needs attention)? True when it is failed or expired
 * (always), or it has been queued/injected/reply-pending with no terminal progress for longer
 * than STALL_THRESHOLD_MS. A claude (recipient) turn is never operator-stalled work. A replied or
 * terminal-acknowledged (no reply expected) turn is never stalled.
 */
export function isStalled(turn, nowMs, thresholdMs = STALL_THRESHOLD_MS) {
  const t = turn || {};
  if (t.authorType === 'claude') return false;
  const state = deriveTurnState(t, nowMs);
  if (state === 'failed' || state === 'expired') return true;
  if (state === 'replied' || state === 'acknowledged') return false;
  // queued | injected | reply-pending: stalled once it has aged past the threshold.
  const created = t.createdAt ? Date.parse(t.createdAt) : NaN;
  if (!Number.isFinite(created)) return false;
  return (nowMs - created) >= thresholdMs;
}

/**
 * Roll a thread's turns up into a work summary for the stalled/unanswered surface.
 * Counts failed + expired + stalled operator turns; needsAttention when any exist.
 */
export function summarizeThreadWork(turns, nowMs, thresholdMs = STALL_THRESHOLD_MS) {
  const list = Array.isArray(turns) ? turns : [];
  let failed = 0, expired = 0, stalled = 0;
  for (const t of list) {
    const state = deriveTurnState(t, nowMs);
    if (state === 'failed') failed += 1;
    if (state === 'expired') expired += 1;
    if (isStalled(t, nowMs, thresholdMs)) stalled += 1;
  }
  return { failed, expired, stalled, needsAttention: stalled > 0 || failed > 0 || expired > 0 };
}

/**
 * Lightweight per-thread attention signal for the thread LIST, computed from the SUMMARY fields
 * only (lastTurnState + lastMessageAt) — NO per-thread turn fetch, so the list stays a single
 * read (no N+1). Returns { needsAttention, reason }. A thread needs attention when its last turn
 * is failed/expired, or it is unreplied (lastTurnState not 'replied') and has been idle past the
 * stall threshold. The full per-turn rollup (summarizeThreadWork) runs only for the OPEN thread.
 */
export function threadListAttention(summary, nowMs, thresholdMs = STALL_THRESHOLD_MS) {
  const s = summary || {};
  const last = s.lastTurnState;
  if (last === 'failed') return { needsAttention: true, reason: 'failed' };
  if (last === 'expired') return { needsAttention: true, reason: 'expired' };
  if (last && last !== 'replied') {
    const t = s.lastMessageAt ? Date.parse(s.lastMessageAt) : NaN;
    if (Number.isFinite(t) && (nowMs - t) >= thresholdMs) return { needsAttention: true, reason: 'stalled' };
  }
  return { needsAttention: false, reason: null };
}

if (typeof window !== 'undefined') {
  window.XBusTimeline = {
    TIMELINE_STATES, STALL_THRESHOLD_MS, turnStateLabel, deriveTurnState, isStalled,
    summarizeThreadWork, threadListAttention,
  };
}
