import { describe, it, expect } from 'vitest';
import {
  DeliveryState,
  EDGES,
  Trigger,
  resolveTransition,
  isLegalTransition,
  isTerminal,
  TERMINAL_STATES,
} from '../../src/protocol/states.js';

describe('delivery state machine', () => {
  it('every declared edge resolves to its target', () => {
    for (const e of EDGES) {
      const r = resolveTransition(e.from, e.trigger);
      expect(r.ok).toBe(true);
      expect(r.to).toBe(e.to);
    }
  });

  it('rejects illegal (from,trigger) pairs', () => {
    // queued cannot be completed directly
    expect(resolveTransition(DeliveryState.QUEUED, Trigger.COMPLETE).ok).toBe(false);
    // a terminal state has no outgoing transitions
    expect(resolveTransition(DeliveryState.COMPLETED, Trigger.PICKUP).ok).toBe(false);
    expect(resolveTransition(DeliveryState.CANCELLED, Trigger.ACK_ACCEPT).ok).toBe(false);
  });

  it('rejected is REACHABLE (SM1) from transport_written and accepted', () => {
    expect(isLegalTransition(DeliveryState.TRANSPORT_WRITTEN, DeliveryState.REJECTED)).toBe(true);
    expect(isLegalTransition(DeliveryState.ACCEPTED, DeliveryState.REJECTED)).toBe(true);
    // and it is terminal
    expect(isTerminal(DeliveryState.REJECTED)).toBe(true);
  });

  it('only retry_wait->dispatching increments attempt (I23)', () => {
    const incrementing = EDGES.filter((e) => e.incrementsAttempt);
    expect(incrementing).toHaveLength(1);
    expect(incrementing[0]!.from).toBe(DeliveryState.RETRY_WAIT);
    expect(incrementing[0]!.to).toBe(DeliveryState.DISPATCHING);
  });

  it('transport_written->completed is guarded requiresAck=0 (SM3/I25)', () => {
    const edge = EDGES.find(
      (e) => e.from === DeliveryState.TRANSPORT_WRITTEN && e.to === DeliveryState.COMPLETED,
    );
    expect(edge).toBeDefined();
    expect(edge!.guard).toBe('requiresAck=0');
  });

  it('queued cannot skip directly to accepted/transport_written', () => {
    expect(isLegalTransition(DeliveryState.QUEUED, DeliveryState.ACCEPTED)).toBe(false);
    expect(isLegalTransition(DeliveryState.QUEUED, DeliveryState.TRANSPORT_WRITTEN)).toBe(false);
    expect(isLegalTransition(DeliveryState.QUEUED, DeliveryState.COMPLETED)).toBe(false);
  });

  it('all states except terminals have at least one outgoing edge (no dead non-terminal)', () => {
    const allStates = Object.values(DeliveryState);
    for (const s of allStates) {
      if (TERMINAL_STATES.has(s)) continue;
      const hasOut = EDGES.some((e) => e.from === s);
      expect(hasOut, `state ${s} should have an outgoing edge`).toBe(true);
    }
  });

  it('all non-terminal states are reachable from queued (BFS)', () => {
    const adj = new Map<string, string[]>();
    for (const e of EDGES) {
      const arr = adj.get(e.from) ?? [];
      arr.push(e.to);
      adj.set(e.from, arr);
    }
    const seen = new Set<string>([DeliveryState.QUEUED]);
    const q = [DeliveryState.QUEUED as string];
    while (q.length) {
      const cur = q.shift()!;
      for (const nxt of adj.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          q.push(nxt);
        }
      }
    }
    // every state, including rejected + dead_letter, must be reachable
    for (const s of Object.values(DeliveryState)) {
      expect(seen.has(s), `state ${s} unreachable from queued`).toBe(true);
    }
  });
});
