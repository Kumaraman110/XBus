/**
 * Beta.10 (Train B) — conversation timeline state derivation (dashboard-side, PURE).
 *
 * The thread projection already carries deliveryState (queued/delivered/acknowledged/replied/
 * failed), ackStatus, requiresReply, expiresAt, authorType. From THOSE fields we derive the
 * seven user-facing timeline states — queued / injected / acknowledged / reply-pending /
 * replied / failed / expired — with NO new broker data (WS3 dep #3 avoided). We also classify
 * "stalled/unanswered" work so the operator sees what needs attention.
 *
 * These tests pin the pure logic in the inert static asset src/broker/dashboard/static/timeline.js.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveTurnState, TIMELINE_STATES, turnStateLabel, isStalled, summarizeThreadWork, threadListAttention,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain JS static asset, intentionally untyped
} from '../../src/broker/dashboard/static/timeline.js';

const NOW = Date.parse('2026-07-19T12:00:00.000Z');
const past = (min: number) => new Date(NOW - min * 60_000).toISOString();
const future = (min: number) => new Date(NOW + min * 60_000).toISOString();

/** Minimal turn shape (subset the derivation reads). */
function turn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { deliveryState: 'queued', ackStatus: null, requiresReply: false, expiresAt: null, authorType: 'operator', createdAt: past(1), ...over };
}

describe('deriveTurnState — seven distinct states from existing projection fields', () => {
  it('replied wins over everything', () => {
    expect(deriveTurnState(turn({ deliveryState: 'replied' }), NOW)).toBe('replied');
    // Even if an expiry has passed, a completed reply is terminal-success.
    expect(deriveTurnState(turn({ deliveryState: 'replied', expiresAt: past(5) }), NOW)).toBe('replied');
  });

  it('failed: raw failed OR ack rejected', () => {
    expect(deriveTurnState(turn({ deliveryState: 'failed' }), NOW)).toBe('failed');
    expect(deriveTurnState(turn({ deliveryState: 'acknowledged', ackStatus: 'rejected' }), NOW)).toBe('failed');
  });

  it('expired: a passed deadline on a not-yet-terminal turn (never overrides replied/failed)', () => {
    expect(deriveTurnState(turn({ deliveryState: 'queued', expiresAt: past(1) }), NOW)).toBe('expired');
    expect(deriveTurnState(turn({ deliveryState: 'delivered', expiresAt: past(1) }), NOW)).toBe('expired');
    // A future deadline does not expire.
    expect(deriveTurnState(turn({ deliveryState: 'queued', expiresAt: future(10) }), NOW)).toBe('queued');
  });

  it('reply-pending vs acknowledged depends on requiresReply', () => {
    // Acked and a reply is still expected → reply-pending.
    expect(deriveTurnState(turn({ deliveryState: 'acknowledged', ackStatus: 'accepted', requiresReply: true }), NOW)).toBe('reply-pending');
    // Acked and no reply expected → acknowledged is terminal-enough.
    expect(deriveTurnState(turn({ deliveryState: 'acknowledged', ackStatus: 'accepted', requiresReply: false }), NOW)).toBe('acknowledged');
  });

  it('injected: delivered/transport-written but not yet acked', () => {
    expect(deriveTurnState(turn({ deliveryState: 'delivered' }), NOW)).toBe('injected');
  });

  it('queued: still awaiting a checkpoint', () => {
    expect(deriveTurnState(turn({ deliveryState: 'queued' }), NOW)).toBe('queued');
  });

  it('every derived state is a member of TIMELINE_STATES + has a human label', () => {
    for (const s of TIMELINE_STATES) expect(typeof turnStateLabel(s)).toBe('string');
    expect(TIMELINE_STATES).toEqual(
      expect.arrayContaining(['queued', 'injected', 'acknowledged', 'reply-pending', 'replied', 'failed', 'expired']),
    );
  });
});

describe('isStalled — work needing operator attention', () => {
  it('an operator turn awaiting a reply past the stall threshold is stalled', () => {
    // reply-pending for > 10 min (default threshold) → stalled.
    expect(isStalled(turn({ deliveryState: 'acknowledged', requiresReply: true, createdAt: past(15) }), NOW)).toBe(true);
    // reply-pending but recent → not yet stalled.
    expect(isStalled(turn({ deliveryState: 'acknowledged', requiresReply: true, createdAt: past(2) }), NOW)).toBe(false);
  });

  it('a queued operator turn sitting past the threshold (recipient never checkpointed) is stalled', () => {
    expect(isStalled(turn({ deliveryState: 'queued', createdAt: past(20) }), NOW)).toBe(true);
  });

  it('failed + expired always count as stalled/unanswered regardless of age', () => {
    expect(isStalled(turn({ deliveryState: 'failed', createdAt: past(1) }), NOW)).toBe(true);
    expect(isStalled(turn({ deliveryState: 'queued', expiresAt: past(1), createdAt: past(1) }), NOW)).toBe(true);
  });

  it('replied / acknowledged-terminal are never stalled', () => {
    expect(isStalled(turn({ deliveryState: 'replied', createdAt: past(60) }), NOW)).toBe(false);
    expect(isStalled(turn({ deliveryState: 'acknowledged', requiresReply: false, createdAt: past(60) }), NOW)).toBe(false);
  });

  it('a claude (recipient) turn is never counted as operator-stalled work', () => {
    expect(isStalled(turn({ authorType: 'claude', deliveryState: 'queued', createdAt: past(60) }), NOW)).toBe(false);
  });
});

describe('summarizeThreadWork — per-thread rollup for the stalled surface', () => {
  it('counts stalled + failed + expired turns and flags needsAttention', () => {
    const turns = [
      turn({ deliveryState: 'replied', createdAt: past(30) }),
      turn({ deliveryState: 'acknowledged', requiresReply: true, createdAt: past(20) }), // stalled reply-pending
      turn({ deliveryState: 'failed', createdAt: past(5) }),
      turn({ deliveryState: 'queued', expiresAt: past(1), createdAt: past(2) }),          // expired
    ];
    const s = summarizeThreadWork(turns, NOW);
    expect(s.failed).toBe(1);
    expect(s.expired).toBe(1);
    expect(s.stalled).toBeGreaterThanOrEqual(2); // reply-pending-stalled + failed + expired all count as needing attention
    expect(s.needsAttention).toBe(true);
  });

  it('a healthy thread (all replied) needs no attention', () => {
    const turns = [turn({ deliveryState: 'replied' }), turn({ authorType: 'claude', deliveryState: 'replied' })];
    const s = summarizeThreadWork(turns, NOW);
    expect(s.needsAttention).toBe(false);
    expect(s.stalled).toBe(0);
  });

  it('tolerates an empty / missing turn list', () => {
    expect(summarizeThreadWork([], NOW).needsAttention).toBe(false);
    expect(summarizeThreadWork(undefined as unknown as [], NOW).needsAttention).toBe(false);
  });
});

describe('threadListAttention — summary-only signal (no per-thread turn fetch, no N+1)', () => {
  it('last turn failed/expired always needs attention', () => {
    expect(threadListAttention({ lastTurnState: 'failed', lastMessageAt: past(1) }, NOW).needsAttention).toBe(true);
    expect(threadListAttention({ lastTurnState: 'expired', lastMessageAt: past(1) }, NOW).reason).toBe('expired');
  });
  it('unreplied + idle past the threshold is stalled', () => {
    expect(threadListAttention({ lastTurnState: 'queued', lastMessageAt: past(20) }, NOW)).toEqual({ needsAttention: true, reason: 'stalled' });
    // recent unreplied → not yet stalled
    expect(threadListAttention({ lastTurnState: 'queued', lastMessageAt: past(2) }, NOW).needsAttention).toBe(false);
  });
  it('a replied last turn never needs attention', () => {
    expect(threadListAttention({ lastTurnState: 'replied', lastMessageAt: past(120) }, NOW).needsAttention).toBe(false);
  });
});
