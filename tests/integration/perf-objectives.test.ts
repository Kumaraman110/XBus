/**
 * §5 — performance objectives, asserted as a regression guard over the ENCRYPTED
 * transport (XBUS-STP). XBus is a LOCAL same-machine bus; the objective is
 * "imperceptible to an interactive Claude Code session", not network throughput.
 *
 * Stated objectives (local, single machine, secure transport):
 *   O1 handshake (connect + full mutual auth)  p95 < 150 ms
 *   O2 send round-trip (encrypted)             p95 < 50 ms
 *   O3 inbox round-trip (encrypted)            p95 < 50 ms
 *   O4 sustained send throughput               > 200 msg/sec (single client)
 *
 * ENVIRONMENT-AWARE GATING (beta.12 qualification-correctness — see src/tools/perf-policy.ts):
 * the SAME benchmark runs in every environment. The gate's STRICTNESS is chosen by the TRUSTED
 * process environment (XBUS_PERF_LANE / CI auto-detect), NOT by any product-controllable input:
 *   - DEDICATED lane (default; developer box / release machine): the strict, generous CI-safe
 *     ceilings (≈3-10x the dev-machine numbers in docs/evidence/benchmarks.md) remain BLOCKING.
 *   - HOSTED lane (shared CI runner, CPU-oversubscribed): run the SAME bench, prove functional
 *     correctness + reject pathological results (near-zero throughput, multi-second p95, malformed
 *     or partial measurements, transport failure), record the metrics, and classify strict-threshold
 *     misses within the non-pathological band as honest host-load variance rather than a false
 *     product failure. The benchmark is NEVER silently skipped, and the product thresholds are NOT
 *     reduced — only the shared-runner FALSE-NEGATIVE is removed.
 */
import { describe, it, expect } from 'vitest';
import { runBench } from '../../src/tools/secure-transport-bench.js';
import { evaluatePerf, resolvePerfLane } from '../../src/tools/perf-policy.js';

describe('§5 performance objectives over XBUS-STP (regression guard)', () => {
  it('meets the stated latency + throughput objectives under the resolved perf lane', async () => {
    // Smaller sample counts than the full bench so CI stays fast but still meaningful.
    const expected = { handshakes: 15, roundTrips: 200 };
    const r = await runBench({ handshakes: expected.handshakes, roundTrips: expected.roundTrips, throughputMsgs: 500 });

    const lane = resolvePerfLane();
    const evalResult = evaluatePerf(r, expected, lane);

    // Always surface the measured metrics + honest variance classification for the record.
    const report =
      `lane=${evalResult.lane} ` +
      `handshake.p95=${evalResult.metrics.handshakeP95Ms.toFixed(1)}ms ` +
      `send.p95=${evalResult.metrics.sendRtP95Ms.toFixed(1)}ms ` +
      `inbox.p95=${evalResult.metrics.inboxRtP95Ms.toFixed(1)}ms ` +
      `throughput=${evalResult.metrics.throughputPerSec.toFixed(0)}/s` +
      (evalResult.variance.length ? ` | variance: ${evalResult.variance.join('; ')}` : '');
    // eslint-disable-next-line no-console
    console.log(`[perf-objectives] ${report}`);

    // BOTH lanes: fail on any blocking failure (malformed/partial/transport/pathological, plus
    // strict-threshold misses on the dedicated lane). Never a silent skip; never a weakened floor.
    expect(evalResult.failures, `perf gate failures (${evalResult.lane} lane): ${evalResult.failures.join('; ')}`).toEqual([]);
    expect(evalResult.ok, report).toBe(true);

    // Sanity: the harness actually exercised the encrypted path with the requested sample counts.
    expect(r.handshakeMs.n).toBe(expected.handshakes);
    expect(r.sendRoundTripMs.n).toBe(expected.roundTrips);
    expect(r.secureTransport).toBe(true);
  }, 60_000);
});
