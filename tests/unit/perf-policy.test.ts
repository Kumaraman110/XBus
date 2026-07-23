/**
 * Regression tests for the environment-aware performance qualification policy
 * (src/tools/perf-policy.ts, beta.12 qualification-correctness).
 *
 * Proves the policy distinguishes a genuine product/perf defect from shared-hosted-runner load
 * variance WITHOUT weakening the product objectives, and that the lenient (hosted) lane cannot be
 * selected by untrusted product-controllable input.
 */
import { describe, it, expect } from 'vitest';
import {
  resolvePerfLane,
  evaluatePerf,
  measurementFailures,
  STRICT_THRESHOLDS,
  PATHOLOGICAL_BOUNDS,
  type PerfLane,
} from '../../src/tools/perf-policy.js';
import type { BenchReport } from '../../src/tools/secure-transport-bench.js';

const EXPECTED = { handshakes: 15, roundTrips: 200 };

/** A complete, healthy bench report; override fields per-case. */
function report(over: Partial<{
  handshakeP95: number; sendP95: number; inboxP95: number; throughput: number;
  handshakeN: number; sendN: number; inboxN: number; secureTransport: boolean;
}> = {}): BenchReport {
  const stat = (p95: number, n: number) => ({ n, min: 0, max: p95, mean: p95 / 2, p50: p95 / 2, p95, p99: p95 });
  return {
    node: 'v22.13.1', platform: 'win32', cpus: 4, xbusVersion: '0.1.0-beta.12', protocolVersion: 1,
    secureTransport: (over.secureTransport ?? true) as true,
    methodology: { warmup: 50, handshakes: EXPECTED.handshakes, roundTrips: EXPECTED.roundTrips, throughputMsgs: 500, concurrency: '1 client', percentile: 'p95' },
    handshakeMs: stat(over.handshakeP95 ?? 40, over.handshakeN ?? EXPECTED.handshakes),
    sendRoundTripMs: stat(over.sendP95 ?? 8, over.sendN ?? EXPECTED.roundTrips),
    inboxRoundTripMs: stat(over.inboxP95 ?? 8, over.inboxN ?? EXPECTED.roundTrips),
    sendThroughputPerSec: over.throughput ?? 400,
  };
}

describe('resolvePerfLane — trusted-env only, fail-closed to strict', () => {
  it('defaults to DEDICATED (strict) with an empty environment', () => {
    expect(resolvePerfLane({})).toBe('dedicated');
  });
  it('honors an explicit XBUS_PERF_LANE=hosted from the trusted release env', () => {
    expect(resolvePerfLane({ XBUS_PERF_LANE: 'hosted' })).toBe('hosted');
    expect(resolvePerfLane({ XBUS_PERF_LANE: 'HOSTED' })).toBe('hosted');
    expect(resolvePerfLane({ XBUS_PERF_LANE: ' dedicated ' })).toBe('dedicated');
  });
  it('auto-detects a hosted shared CI runner (GITHUB_ACTIONS / CI)', () => {
    expect(resolvePerfLane({ GITHUB_ACTIONS: 'true' })).toBe('hosted');
    expect(resolvePerfLane({ CI: 'true' })).toBe('hosted');
    expect(resolvePerfLane({ CI: '1' })).toBe('hosted');
  });
  it('FAILS CLOSED to dedicated on an UNRECOGNISED lane value (cannot be abused to weaken the gate)', () => {
    expect(resolvePerfLane({ XBUS_PERF_LANE: 'lenient' })).toBe('dedicated');
    expect(resolvePerfLane({ XBUS_PERF_LANE: 'skip' })).toBe('dedicated');
    expect(resolvePerfLane({ XBUS_PERF_LANE: 'garbage' })).toBe('dedicated');
  });
  it('an explicit dedicated overrides CI auto-detect (release lane on a CI box stays strict)', () => {
    expect(resolvePerfLane({ XBUS_PERF_LANE: 'dedicated', GITHUB_ACTIONS: 'true' })).toBe('dedicated');
  });
});

describe('the lenient (hosted) lane cannot be selected by untrusted PRODUCT code', () => {
  it('a BenchReport / product payload has NO channel to set the lane — lane comes only from env', () => {
    // Even a maximally hostile report cannot pick its own lane: evaluatePerf takes the lane as a
    // separate arg resolved from the trusted env, and resolvePerfLane reads ONLY process-env keys
    // that product code does not control inside the gated run. Simulate product data trying to sneak
    // a lane in — it is ignored; the resolved lane governs.
    const hostile = report({ throughput: 1 }) as unknown as Record<string, unknown>;
    hostile.perfLane = 'hosted';           // product-controlled field — must be IGNORED
    hostile.XBUS_PERF_LANE = 'hosted';     // ditto
    const lane = resolvePerfLane({});      // trusted env is empty → dedicated
    const ev = evaluatePerf(hostile as unknown as BenchReport, EXPECTED, lane);
    expect(ev.lane).toBe('dedicated');     // product data did NOT flip the lane
    expect(ev.ok).toBe(false);             // near-zero throughput still fails
  });
  it('resolvePerfLane ignores non-env argument shapes (only reads known env keys)', () => {
    // Passing a report-like object as "env" resolves via its (absent) env keys → dedicated.
    expect(resolvePerfLane({ sendThroughputPerSec: '1', perfLane: 'hosted' } as unknown as NodeJS.ProcessEnv)).toBe('dedicated');
  });
});

describe('DEDICATED lane — strict thresholds remain BLOCKING', () => {
  it('passes a healthy report', () => {
    const ev = evaluatePerf(report(), EXPECTED, 'dedicated');
    expect(ev.ok).toBe(true);
    expect(ev.failures).toEqual([]);
  });
  it('FAILS when throughput is below the strict floor (regression-guard floor is blocking)', () => {
    const ev = evaluatePerf(report({ throughput: STRICT_THRESHOLDS.throughputPerSecMin - 1 }), EXPECTED, 'dedicated');
    expect(ev.ok).toBe(false);
    expect(ev.failures.join(' ')).toMatch(/throughput.*strict floor/);
  });
  it('FAILS when handshake p95 exceeds the strict ceiling', () => {
    const ev = evaluatePerf(report({ handshakeP95: STRICT_THRESHOLDS.handshakeP95MsMax + 1 }), EXPECTED, 'dedicated');
    expect(ev.ok).toBe(false);
    expect(ev.failures.join(' ')).toMatch(/handshake p95.*strict/);
  });
  it('FAILS when send round-trip p95 exceeds the strict ceiling', () => {
    const ev = evaluatePerf(report({ sendP95: STRICT_THRESHOLDS.sendRtP95MsMax + 1 }), EXPECTED, 'dedicated');
    expect(ev.ok).toBe(false);
    expect(ev.failures.join(' ')).toMatch(/send-rt p95.*strict/);
  });
});

describe('HOSTED lane — tolerates realistic contention, REJECTS pathological', () => {
  it('TOLERATES a throughput dip below the strict floor but above pathological (the false-failure case)', () => {
    // This is exactly the beta.12 clean-Windows failure: ~46/s and ~29/s, below the 50 strict floor
    // but well above the pathological 5/s floor. Dedicated would fail; hosted classifies as variance.
    for (const tput of [46, 29, STRICT_THRESHOLDS.throughputPerSecMin - 1, PATHOLOGICAL_BOUNDS.throughputPerSecMin + 1]) {
      const ev = evaluatePerf(report({ throughput: tput }), EXPECTED, 'hosted');
      expect(ev.ok, `throughput ${tput}/s should pass hosted`).toBe(true);
      expect(ev.failures).toEqual([]);
      expect(ev.variance.join(' '), `throughput ${tput}/s should be recorded as variance`).toMatch(/throughput.*host-load variance/);
    }
  });
  it('TOLERATES a latency p95 above strict but below pathological, recording variance', () => {
    const ev = evaluatePerf(report({ sendP95: STRICT_THRESHOLDS.sendRtP95MsMax + 100 }), EXPECTED, 'hosted');
    expect(ev.ok).toBe(true);
    expect(ev.variance.join(' ')).toMatch(/send-rt p95.*host-load variance/);
  });
  it('REJECTS near-zero throughput (transport/broker broken — a real defect, not load)', () => {
    const ev = evaluatePerf(report({ throughput: PATHOLOGICAL_BOUNDS.throughputPerSecMin }), EXPECTED, 'hosted');
    expect(ev.ok).toBe(false);
    expect(ev.failures.join(' ')).toMatch(/pathological floor/);
  });
  it('REJECTS multi-second handshake p95 (encrypted path broken, not slow)', () => {
    const ev = evaluatePerf(report({ handshakeP95: PATHOLOGICAL_BOUNDS.handshakeP95MsMax + 1 }), EXPECTED, 'hosted');
    expect(ev.ok).toBe(false);
    expect(ev.failures.join(' ')).toMatch(/handshake p95.*pathological/);
  });
});

describe('measurement integrity — BOTH lanes, always blocking, never a silent skip', () => {
  it('FAILS on a non-finite throughput (malformed/empty benchmark) in hosted lane', () => {
    const ev = evaluatePerf(report({ throughput: NaN }), EXPECTED, 'hosted');
    expect(ev.ok).toBe(false);
    expect(ev.failures.join(' ')).toMatch(/throughput is not finite|malformed\/empty/);
  });
  it('FAILS on a short/partial sample count (transport failure / partial run) in hosted lane', () => {
    const ev = evaluatePerf(report({ sendN: EXPECTED.roundTrips - 50 }), EXPECTED, 'hosted');
    expect(ev.ok).toBe(false);
    expect(ev.failures.join(' ')).toMatch(/send-rt samples.*< requested/);
  });
  it('FAILS when the encrypted transport was not exercised (secureTransport !== true)', () => {
    const ev = evaluatePerf(report({ secureTransport: false }), EXPECTED, 'hosted');
    expect(ev.ok).toBe(false);
    expect(ev.failures.join(' ')).toMatch(/encrypted transport/);
  });
  it('measurementFailures is empty for a complete report', () => {
    expect(measurementFailures(report(), EXPECTED)).toEqual([]);
  });
  it('the benchmark result is always evaluated — evaluatePerf returns metrics even on failure (never skipped)', () => {
    const ev = evaluatePerf(report({ throughput: 1 }), EXPECTED, 'hosted' as PerfLane);
    expect(ev.metrics.throughputPerSec).toBe(1); // measured + recorded, not skipped
    expect(ev.ok).toBe(false);
  });
});
