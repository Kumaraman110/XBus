/**
 * §5 — XBus performance benchmark over the encrypted transport (XBUS-STP).
 *
 * Standalone, repeatable harness: starts a REAL secure broker, connects real
 * encrypted clients, and measures the operations that matter for the product's
 * stated objectives:
 *
 *   - handshake latency        (connect + full XBUS-STP mutual auth)
 *   - send round-trip          (send_message -> send_message_ack, encrypted)
 *   - inbox round-trip         (inbox -> inbox_ack, encrypted)
 *   - sustained send throughput (messages/sec, single client)
 *
 * Run (after `npm run build`): `node dist/tools/secure-transport-bench.js [--json]`
 * or via npm: `npm run bench` (builds, then runs the compiled entry).
 *
 * This is a LOCAL same-machine bus; the objective is "imperceptible to an
 * interactive Claude Code session", not network-grade throughput. The numbers
 * are recorded to docs/evidence/benchmarks.md; the regression GUARD lives in
 * tests/integration/perf-objectives.test.ts with generous CI-safe ceilings.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { startBrokerHost, type RunningBroker } from '../broker/host.js';
import { IpcClient } from '../ipc/client.js';
import { doHello } from '../ipc/hello.js';
import { ComponentRole } from '../identity/components.js';
import { XBUS_VERSION, PROTOCOL_VERSION } from '../protocol/version.js';

interface Stats { n: number; min: number; max: number; mean: number; p50: number; p95: number; p99: number; }

function summarize(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, min: s[0]!, max: s[s.length - 1]!, mean: sum / s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

async function makeClient(broker: RunningBroker, sessionId: string): Promise<IpcClient> {
  const c = new IpcClient(broker.endpoint, { rootSecret: broker.rootSecret!, helloIdentity: { claimedRole: 'mcp', claimedSessionId: sessionId } });
  await c.connect();
  await doHello(c, ComponentRole.MCP);
  await c.request('register_session', { sessionId, instanceId: `inst-${sessionId}`, processId: process.pid, projectId: 'p', cwd: process.cwd(), receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: ComponentRole.MCP });
  await c.request('signal_readiness', { ackAvailable: true, versionOk: true });
  return c;
}

export interface BenchReport {
  node: string;
  platform: string;
  cpus: number;
  xbusVersion: string;
  protocolVersion: number;
  secureTransport: true;
  methodology: { warmup: number; handshakes: number; roundTrips: number; throughputMsgs: number; concurrency: string; percentile: string };
  handshakeMs: Stats;
  sendRoundTripMs: Stats;
  inboxRoundTripMs: Stats;
  sendThroughputPerSec: number;
}

export async function runBench(opts: { handshakes?: number; roundTrips?: number; throughputMsgs?: number; warmup?: number } = {}): Promise<BenchReport> {
  const handshakes = opts.handshakes ?? 30;
  const roundTrips = opts.roundTrips ?? 500;
  const throughputMsgs = opts.throughputMsgs ?? 2000;
  const warmup = opts.warmup ?? 50;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-bench-'));
  const broker = await startBrokerHost({ dataDir, maxConnections: 256, connectRatePerSec: 10_000, reaperIntervalMs: 0 });
  try {
    // 0) WARM-UP (F-warmup): exercise the encrypted path before timing so JIT /
    // cold-cache cost is excluded from the measured samples. Warm-up results are
    // discarded.
    {
      const w = await makeClient(broker, 'wwwwwwww-0000-4000-8000-00000000000w');
      await w.request('register_alias', { alias: 'warmup' });
      for (let i = 0; i < warmup; i++) await w.request('send_message', { to: 'warmup', text: `warm-${i}`, requiresAck: false });
      for (let i = 0; i < Math.min(warmup, 20); i++) await w.request('inbox', { limit: 1 });
      w.close();
    }
    // 1) handshake latency: connect + full mutual auth, fresh client each time.
    const hs: number[] = [];
    for (let i = 0; i < handshakes; i++) {
      const t0 = performance.now();
      const c = new IpcClient(broker.endpoint, { rootSecret: broker.rootSecret!, helloIdentity: { claimedRole: 'mcp', claimedSessionId: `hsx-${i}-0000-4000-8000-00000000000${(i % 10)}` } });
      await c.connect();
      await doHello(c, ComponentRole.MCP);
      hs.push(performance.now() - t0);
      c.close();
    }

    // Two long-lived clients for the round-trip + throughput measurements.
    const a = await makeClient(broker, 'aaaabbbb-0000-4000-8000-0000000000a1');
    const b = await makeClient(broker, 'bbbbcccc-0000-4000-8000-0000000000b1');
    await a.request('register_alias', { alias: 'benchA' });
    await b.request('register_alias', { alias: 'benchB' });

    // 2) send round-trip (encrypted send_message -> ack).
    const srt: number[] = [];
    for (let i = 0; i < roundTrips; i++) {
      const t0 = performance.now();
      await a.request('send_message', { to: 'benchB', text: `rt-${i}`, requiresAck: false });
      srt.push(performance.now() - t0);
    }

    // 3) inbox round-trip (encrypted inbox pull).
    const irt: number[] = [];
    for (let i = 0; i < Math.min(roundTrips, 200); i++) {
      const t0 = performance.now();
      await b.request('inbox', { limit: 1 });
      irt.push(performance.now() - t0);
    }

    // 4) sustained send throughput (single client, sequential).
    const tT0 = performance.now();
    for (let i = 0; i < throughputMsgs; i++) {
      await a.request('send_message', { to: 'benchB', text: `tp-${i}`, requiresAck: false });
    }
    const elapsedSec = (performance.now() - tT0) / 1000;
    const sendThroughputPerSec = throughputMsgs / elapsedSec;

    a.close(); b.close();
    return {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpus: os.cpus().length,
      xbusVersion: XBUS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      secureTransport: true,
      methodology: { warmup, handshakes, roundTrips, throughputMsgs, concurrency: 'single client, sequential', percentile: 'nearest-rank (sorted[floor(q*n)])' },
      handshakeMs: summarize(hs),
      sendRoundTripMs: summarize(srt),
      inboxRoundTripMs: summarize(irt),
      sendThroughputPerSec,
    };
  } finally {
    await broker.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Stated objectives (local, secure transport). Used as a fail-nonzero gate. */
const OBJECTIVES = { handshakeP95Ms: 150, sendRtP95Ms: 50, inboxRtP95Ms: 50, throughputPerSec: 200 };

export function objectiveFailures(r: BenchReport): string[] {
  const f: string[] = [];
  if (r.handshakeMs.p95 >= OBJECTIVES.handshakeP95Ms) f.push(`handshake p95 ${r.handshakeMs.p95.toFixed(2)}ms >= ${OBJECTIVES.handshakeP95Ms}`);
  if (r.sendRoundTripMs.p95 >= OBJECTIVES.sendRtP95Ms) f.push(`send-rt p95 ${r.sendRoundTripMs.p95.toFixed(2)}ms >= ${OBJECTIVES.sendRtP95Ms}`);
  if (r.inboxRoundTripMs.p95 >= OBJECTIVES.inboxRtP95Ms) f.push(`inbox-rt p95 ${r.inboxRoundTripMs.p95.toFixed(2)}ms >= ${OBJECTIVES.inboxRtP95Ms}`);
  if (r.sendThroughputPerSec <= OBJECTIVES.throughputPerSec) f.push(`throughput ${r.sendThroughputPerSec.toFixed(0)}/s <= ${OBJECTIVES.throughputPerSec}`);
  return f;
}

// CLI entry — run via `node dist/tools/secure-transport-bench.js [--json]`.
// argv[1] is the compiled script path (NOT a loader), so this guard is reliable.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/secure-transport-bench.js')) {
  runBench().then((r) => {
    const valid = Number.isFinite(r.sendThroughputPerSec) && r.handshakeMs.n > 0 && r.sendRoundTripMs.n > 0;
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else {
      const f = (s: Stats) => `n=${s.n} mean=${s.mean.toFixed(3)}ms p50=${s.p50.toFixed(3)} p95=${s.p95.toFixed(3)} p99=${s.p99.toFixed(3)} max=${s.max.toFixed(3)}`;
      process.stdout.write(
        `XBus secure-transport benchmark (XBUS-STP encrypted)\n` +
        `  env: ${r.platform}, Node ${r.node}, ${r.cpus} CPUs · xbus ${r.xbusVersion} proto v${r.protocolVersion}\n` +
        `  methodology: warmup=${r.methodology.warmup}, ${r.methodology.concurrency}, percentile=${r.methodology.percentile}\n` +
        `  handshake:        ${f(r.handshakeMs)}\n` +
        `  send round-trip:  ${f(r.sendRoundTripMs)}\n` +
        `  inbox round-trip: ${f(r.inboxRoundTripMs)}\n` +
        `  send throughput:  ${r.sendThroughputPerSec.toFixed(0)} msg/sec (${r.methodology.concurrency})\n`,
      );
    }
    if (!valid) { process.stderr.write('bench produced malformed/empty output\n'); process.exit(2); }
    const fails = objectiveFailures(r);
    if (fails.length > 0) { process.stderr.write(`OBJECTIVE FAILURES:\n  ${fails.join('\n  ')}\n`); process.exit(3); }
    process.stdout.write('All objectives met.\n');
    process.exit(0);
  }).catch((e) => { process.stderr.write(`bench failed: ${(e as Error).message}\n`); process.exit(1); });
}
