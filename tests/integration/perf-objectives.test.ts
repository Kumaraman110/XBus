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
 * Ceilings here are deliberately GENEROUS (≈3-10x the numbers seen on the dev
 * machine, recorded in docs/evidence/benchmarks.md) so the guard catches a real
 * regression / accidental O(n) blowup without flaking on a slow/loaded CI box.
 */
import { describe, it, expect } from 'vitest';
import { runBench } from '../../src/tools/secure-transport-bench.js';

describe('§5 performance objectives over XBUS-STP (regression guard)', () => {
  it('meets the stated latency + throughput objectives with generous CI-safe ceilings', async () => {
    // Smaller sample counts than the full bench so CI stays fast but still meaningful.
    const r = await runBench({ handshakes: 15, roundTrips: 200, throughputMsgs: 500 });

    // O1 handshake — generous 600ms p95 ceiling (objective is 150ms).
    expect(r.handshakeMs.p95, `handshake p95=${r.handshakeMs.p95.toFixed(1)}ms`).toBeLessThan(600);
    // O2 send round-trip — generous 250ms p95 ceiling (objective is 50ms).
    expect(r.sendRoundTripMs.p95, `send rt p95=${r.sendRoundTripMs.p95.toFixed(1)}ms`).toBeLessThan(250);
    // O3 inbox round-trip — generous 250ms p95 ceiling (objective is 50ms).
    expect(r.inboxRoundTripMs.p95, `inbox rt p95=${r.inboxRoundTripMs.p95.toFixed(1)}ms`).toBeLessThan(250);
    // O4 throughput — floor of 50 msg/sec (objective is 200; floor is regression guard).
    expect(r.sendThroughputPerSec, `throughput=${r.sendThroughputPerSec.toFixed(0)}/s`).toBeGreaterThan(50);

    // Sanity: the harness actually exercised the encrypted path.
    expect(r.handshakeMs.n).toBe(15);
    expect(r.sendRoundTripMs.n).toBe(200);
  }, 60_000);
});
