/**
 * §1 counter-correctness (Phase 2 groundwork §1 "Counter-correctness").
 *
 * Two claims, both load-bearing for the observability surface being TRUSTWORTHY
 * (a metric nobody can trust is worse than no metric):
 *
 *  (1) transport.handshakes.authFailed increments on a bad-secret connect — and
 *      it lands in the SINGLE uniform auth_failed bucket (no which-check oracle).
 *  (2) reaper.totals equals the SUM of the SweepResults driven under a FakeClock —
 *      the daemon folds each sweep on the SAME path the periodic timer uses, and
 *      sweep() itself stays pure (we assert the fold matches the returned results).
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { doHello } from '../../src/ipc/hello.js';
import { ComponentRole } from '../../src/identity/components.js';
import { startClientHandshake, type HelloIdentity } from '../../src/ipc/secure-channel.js';
import { encodeFrame, FrameDecoder } from '../../src/ipc/framing.js';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerDaemon } from '../../src/broker/daemon.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let broker: RunningBroker;
let db: SqliteDriver;
const dirs: string[] = [];
function freshDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-mc-')); dirs.push(d); return d; }

afterEach(async () => {
  try { await broker?.stop(); } catch { /* ignore */ }
  try { db?.close(); } catch { /* ignore */ }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

let adminSeq = 0;
async function admin(b: RunningBroker): Promise<IpcClient> {
  const c = new IpcClient(b.endpoint, { requestTimeoutMs: 4000, rootSecret: b.rootSecret!, helloIdentity: { claimedRole: 'admin' } });
  await c.connect();
  await doHello(c, ComponentRole.ADMIN);
  const n = ++adminSeq;
  const reg = await c.request('register_session', { sessionId: `admin-${n}-${Date.now()}`, instanceId: `i-admin-${n}`, processId: process.pid, projectId: 'proj-admin', cwd: '/', receiveMode: 'poll_only', capabilities: ['cli'], role: ComponentRole.ADMIN });
  expect(reg.frameType).toBe('register_session_ack');
  return c;
}

interface MetricsPayload {
  transport: { handshakes: { ok: number; authFailed: number; protoMismatch: number; timedOut: number } };
  reaper: { sweepsTotal: number; totals: { ackTimedOut: number; deadLettered: number; expired: number; leasesReclaimed: number; sessionsExpired: number } };
}

/**
 * Drive a handshake with a VALID client_hello but a FORGED client_finish proof
 * over a raw socket. The server's onClientHello derives keys from its OWN root
 * secret (it does not check the client's secret at hello), returns server_hello,
 * then serverVerifyFinish rejects the bad proof -> server-side AuthFailed. This
 * is the realistic server-OBSERVABLE auth failure (a wrong-secret client detects
 * the mismatch client-side at server-proof verification and never sends a cf, so
 * THAT path is server-invisible — the honest server bucket is the bad-cf path).
 */
function forgedFinish(endpoint: string, waitMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    const id: HelloIdentity = { buildId: 'b', appProtoRange: '1-1', claimedRole: 'mcp', claimedSessionId: '', claimedEpoch: 0, capabilities: '' };
    const ch = startClientHandshake(1, id);
    const sock = net.createConnection(endpoint);
    const dec = new FrameDecoder();
    const done = () => { try { sock.destroy(); } catch { /* ignore */ } resolve(); };
    const t = setTimeout(done, waitMs);
    sock.on('connect', () => sock.write(encodeFrame({ h: 'ch', d: ch.clientHelloBytes.toString('base64') })));
    sock.on('data', (c: Buffer) => {
      try {
        const r = dec.push(c);
        for (const fr of r.frames) {
          if ((fr as { h?: string }).h === 'sh') {
            // server_hello received -> reply with a deliberately WRONG client proof.
            sock.write(encodeFrame({ h: 'cf', d: Buffer.alloc(32, 7).toString('base64') }));
            clearTimeout(t); setTimeout(done, 200);
          }
        }
      } catch { /* ignore */ }
    });
    sock.on('error', () => { clearTimeout(t); done(); });
    sock.on('close', () => { clearTimeout(t); resolve(); });
  });
}

describe('§1 counter-correctness', () => {
  it('transport.handshakes.authFailed increments on a bad client_finish (uniform bucket, no oracle)', async () => {
    broker = await startBrokerHost({ dataDir: freshDir() });

    // Baseline: read metrics over a GOOD admin connection first.
    const a0 = await admin(broker);
    const before = ((await a0.request('get_metrics', {})).payload as { metrics: MetricsPayload }).metrics;
    a0.close();

    // A client that completes the hello but sends a forged client_finish proof
    // is rejected server-side as AuthFailed.
    await forgedFinish(broker.endpoint);

    // Re-read metrics: authFailed went up; proto/timeout did NOT (uniform bucket).
    const a1 = await admin(broker);
    const after = ((await a1.request('get_metrics', {})).payload as { metrics: MetricsPayload }).metrics;
    a1.close();

    expect(after.transport.handshakes.authFailed).toBeGreaterThan(before.transport.handshakes.authFailed);
    // The failure did NOT leak into a finer bucket — no which-check oracle.
    expect(after.transport.handshakes.protoMismatch).toBe(before.transport.handshakes.protoMismatch);
    expect(after.transport.handshakes.timedOut).toBe(before.transport.handshakes.timedOut);
    // And the successful admin handshakes were counted as ok.
    expect(after.transport.handshakes.ok).toBeGreaterThan(before.transport.handshakes.ok);
  });

  it('reaper.totals equals the SUM of SweepResults driven under a FakeClock', () => {
    const dir = freshDir();
    db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
    const clock = new FakeClock();
    const ids = new SeqIdGen('m');
    runMigrations(db, clock.nowIso());

    // A daemon WITHOUT starting IPC (we drive the reaper fold path directly via
    // runReaperSweep — the same fold the periodic timer uses). reaperIntervalMs:0
    // disables the timer so the only folds are the explicit ones we count.
    const daemon = new BrokerDaemon(db, path.join(dir, 'ep'), clock, ids, 'broker-mc', { reaperIntervalMs: 0, requireReceipt: false });

    // Stand up a sender + receiver and an injected-but-unacked delivery so the
    // reaper has real ack-timeout work to do across sweeps.
    const store = new BrokerStore(db, clock, ids, 'broker-mc');
    const delivery = new DeliveryOps(db, clock, ids, 5 * 60_000);
    const A: SessionAuthority = store.register({ sessionId: 'aaaa1111-0000-4000-8000-00000000000a', instanceId: 'iA', connectionId: 'cA', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
    store.registerAlias(A, 'architect');
    const B: SessionAuthority = store.register({ sessionId: 'bbbb1111-0000-4000-8000-00000000000b', instanceId: 'iB', connectionId: 'cB', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
    store.registerAlias(B, 'implementer');
    store.signalReadiness(A, { ackAvailable: true, versionOk: true });
    store.signalReadiness(B, { ackAvailable: true, versionOk: true });
    const messageId = store.send(A, { to: 'implementer', text: 'REQ', kind: 'request', requiresAck: true, requiresReply: true }).messageId;
    delivery.checkpointPull({ ...B, role: 'hook' as never }, 'cp1', 10);
    void messageId;

    // Drive several sweeps across time, summing the RETURNED SweepResults.
    const sum = { ackTimedOut: 0, deadLettered: 0, expired: 0, leasesReclaimed: 0, sessionsExpired: 0 };
    for (let i = 0; i < 4; i++) {
      clock.advance(5 * 60_000 + 1000); // past the ack deadline (and any backoff after)
      const r = daemon.runReaperSweep();
      sum.ackTimedOut += r.ackTimedOut;
      sum.deadLettered += r.deadLettered;
      sum.expired += r.expired;
      sum.leasesReclaimed += r.leasesReclaimed;
      sum.sessionsExpired += r.sessionsExpired;
      // re-inject between sweeps so the next sweep has work (until dead-lettered).
      delivery.checkpointPull({ ...B, role: 'hook' as never }, `cp-${i + 2}`, 10);
    }

    const snap = daemon.metricsSnapshot();
    expect(snap.reaper.totals).toEqual(sum);
    expect(snap.reaper.sweepsTotal).toBe(4);
    // The drive actually exercised the reaper (not a vacuous 0===0 pass).
    expect(sum.ackTimedOut + sum.deadLettered).toBeGreaterThan(0);
  });
});
