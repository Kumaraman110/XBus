/**
 * BETA.10 Phase B — the eager-register TEST BARRIER (XBUS_TEST_EAGER_REGISTER_DELAY_MS).
 *
 * WHY: the deferred eager-register fire-and-forget race (ADR 0036) is NOT reproducible by a
 * real-latency cold-start dogfood run — the Stop hook fails-closed while the broker is starting
 * (checkpoint-hook.ts:62-67), so the only false-emission window is the ~ms tail AFTER the broker is
 * up but BEFORE register_session commits the mcp component row. To adjudicate the race
 * DETERMINISTICALLY (rather than from a false-negative clean run), this test-only, env-gated barrier
 * holds the eager register_session commit for a controlled interval so a forced Stop is guaranteed to
 * land while mcpEver=false. It is a NO-OP unless the env var is set, and it applies ONLY on the eager
 * (notifications/initialized) path — never on the tool-call path, which must stay fast.
 *
 * Pure + deterministic: sleep is injected; no timers, no broker, no socket.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  EAGER_REGISTER_DELAY_ENV,
  eagerRegisterDelayMs,
  applyEagerRegisterBarrier,
} from '../../src/channel/eager-register-barrier.js';

describe('eagerRegisterDelayMs — env parsing (test-only seam, safe by default)', () => {
  it('is 0 when the env var is unset (production default — no behavior change)', () => {
    expect(eagerRegisterDelayMs({})).toBe(0);
  });
  it('parses a positive integer ms value', () => {
    expect(eagerRegisterDelayMs({ [EAGER_REGISTER_DELAY_ENV]: '150' })).toBe(150);
  });
  it('is 0 for zero / negative / non-numeric / empty (never a negative or NaN sleep)', () => {
    expect(eagerRegisterDelayMs({ [EAGER_REGISTER_DELAY_ENV]: '0' })).toBe(0);
    expect(eagerRegisterDelayMs({ [EAGER_REGISTER_DELAY_ENV]: '-50' })).toBe(0);
    expect(eagerRegisterDelayMs({ [EAGER_REGISTER_DELAY_ENV]: 'abc' })).toBe(0);
    expect(eagerRegisterDelayMs({ [EAGER_REGISTER_DELAY_ENV]: '' })).toBe(0);
  });
  it('floors a fractional value to an integer ms', () => {
    expect(eagerRegisterDelayMs({ [EAGER_REGISTER_DELAY_ENV]: '99.9' })).toBe(99);
  });
  it('clamps an absurd value to a bounded ceiling (never hang a test broker forever)', () => {
    // A test seam should not be weaponizable into an unbounded hold.
    expect(eagerRegisterDelayMs({ [EAGER_REGISTER_DELAY_ENV]: '99999999' })).toBeLessThanOrEqual(60_000);
  });
});

describe('applyEagerRegisterBarrier — applies ONLY on the eager path, only when configured', () => {
  it('sleeps for the configured ms when eager=true and the env is set', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await applyEagerRegisterBarrier({ eager: true, sleep, env: { [EAGER_REGISTER_DELAY_ENV]: '120' } });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(120);
  });
  it('does NOT sleep on the tool-call path (eager=false) even when the env is set', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await applyEagerRegisterBarrier({ eager: false, sleep, env: { [EAGER_REGISTER_DELAY_ENV]: '120' } });
    expect(sleep).not.toHaveBeenCalled();
  });
  it('does NOT sleep when the env is unset even on the eager path (production no-op)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await applyEagerRegisterBarrier({ eager: true, sleep, env: {} });
    expect(sleep).not.toHaveBeenCalled();
  });
});
