/**
 * BETA.11 (ADR 0038) — RED-first unit tests for the bounded MCP self-heal PLANNER.
 *   #6 bounded self-repair attempts a reconnect (on a path that can run) with backoff;
 *   #7 self-repair failure is BOUNDED → degrade (stop autonomous routing), never a retry storm,
 *      never a spawn/reroute escalation.
 *
 * Pure decision layer (no I/O, injected `now`); the actual reconnect is the existing gated
 * register()/resolveReclaim path, unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  planSelfHeal, recordAttempt, resetSelfHeal, backoffForAttempt,
  DEFAULT_SELF_HEAL_POLICY, type SelfHealState,
} from '../../src/channel/self-heal.js';

const P = DEFAULT_SELF_HEAL_POLICY;

describe('self-heal planner — bounded reconnect with backoff (#6)', () => {
  it('a connected channel is always noop', () => {
    expect(planSelfHeal('connected', resetSelfHeal(), 1000)).toBe('noop');
  });

  it('a fresh degraded episode attempts immediately', () => {
    expect(planSelfHeal('disconnected', resetSelfHeal(), 0)).toBe('attempt');
    expect(planSelfHeal('never_registered', resetSelfHeal(), 0)).toBe('attempt');
    expect(planSelfHeal('broker_unreachable', resetSelfHeal(), 0)).toBe('attempt');
  });

  it('after an attempt, it BACKS OFF until the (exponential) wait elapses, then attempts again', () => {
    let s: SelfHealState = resetSelfHeal();
    // Attempt #0 at t=1000.
    expect(planSelfHeal('disconnected', s, 1000)).toBe('attempt');
    s = recordAttempt(s, 1000); // attempts now = 1 → the wait before the NEXT attempt is keyed on 1.
    const wait = backoffForAttempt(s.attempts, P); // backoffForAttempt(1) = 1000ms
    // Too soon → backoff.
    expect(planSelfHeal('disconnected', s, 1000 + wait - 1)).toBe('backoff');
    // Wait elapsed → attempt again.
    expect(planSelfHeal('disconnected', s, 1000 + wait)).toBe('attempt');
  });

  it('backoff grows exponentially and is capped at maxBackoffMs', () => {
    expect(backoffForAttempt(0, P)).toBe(500);
    expect(backoffForAttempt(1, P)).toBe(1000);
    expect(backoffForAttempt(2, P)).toBe(2000);
    expect(backoffForAttempt(3, P)).toBe(4000);
    expect(backoffForAttempt(4, P)).toBe(8000);
    expect(backoffForAttempt(10, P)).toBe(8000); // capped, never unbounded
  });
});

describe('self-heal planner — exhaustion degrades, never storms/escalates (#7)', () => {
  it('after maxAttempts the episode is exhausted → degrade (not attempt, not backoff)', () => {
    let s: SelfHealState = resetSelfHeal();
    for (let i = 0; i < P.maxAttempts; i++) {
      // Each attempt is preceded by enough elapsed time to not be a backoff.
      const t = i * P.maxBackoffMs * 2;
      const action = planSelfHeal('disconnected', s, t);
      // Until exhausted, it either attempts (enough time) — assert it's never a spawn/reroute word.
      expect(['attempt', 'backoff']).toContain(action);
      s = recordAttempt(s, t);
    }
    // Now attempts === maxAttempts → degrade, regardless of how much time passed.
    expect(s.attempts).toBe(P.maxAttempts);
    expect(planSelfHeal('disconnected', s, 10_000_000)).toBe('degrade');
    // Degrade is terminal for the episode — it never flips back to attempt on its own.
    expect(planSelfHeal('broker_unreachable', s, 99_000_000)).toBe('degrade');
  });

  it('a successful reconnect (channel connected) RESETS the episode so future drops heal again', () => {
    let s: SelfHealState = recordAttempt(recordAttempt(resetSelfHeal(), 0), 1000);
    expect(s.attempts).toBe(2);
    // Channel came back → noop, and the caller resets.
    expect(planSelfHeal('connected', s, 2000)).toBe('noop');
    s = resetSelfHeal();
    expect(s.attempts).toBe(0);
    // A later drop starts a fresh bounded episode.
    expect(planSelfHeal('disconnected', s, 3000)).toBe('attempt');
  });
});
