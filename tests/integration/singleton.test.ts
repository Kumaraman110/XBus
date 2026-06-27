/**
 * Broker singleton hardening (reliability contract §14). Exactly one broker is
 * authoritative per data dir; others get a typed actionable result. Includes a
 * concurrent-startup race (10 simultaneous attempts) and stale-state handling.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { checkSingleton } from '../../src/broker/singleton.js';
import { defaultEndpoint } from '../../src/ipc/transport.js';
import { writeStateFile, ownerIdentityHash } from '../../src/broker/state-file.js';
import { isXBusError } from '../../src/protocol/errors.js';

const running: RunningBroker[] = [];
const dirs: string[] = [];
function freshDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-sng-')); dirs.push(d); return d; }

afterEach(async () => {
  for (const b of running) { try { await b.stop(); } catch { /* ignore */ } }
  running.length = 0;
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

describe('broker singleton (§14)', () => {
  it('a second start on the same data dir is rejected with a typed BROKER_ALREADY_RUNNING', async () => {
    const dir = freshDir();
    const b1 = await startBrokerHost({ dataDir: dir });
    running.push(b1);
    await expect(startBrokerHost({ dataDir: dir })).rejects.toMatchObject({ code: 'XBUS_BROKER_ALREADY_RUNNING' });
  });

  it('10 simultaneous startup attempts: exactly ONE acquires, the rest get typed results', async () => {
    const dir = freshDir();
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => startBrokerHost({ dataDir: dir })));
    const acquired = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(acquired).toHaveLength(1); // exactly one authoritative broker
    expect(rejected).toHaveLength(9);
    // every rejection is a TYPED XBus error (already-running or contended), not a raw OS error
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(isXBusError(r.reason), `reason: ${r.reason}`).toBe(true);
      expect(['XBUS_BROKER_ALREADY_RUNNING', 'XBUS_BROKER_CONTENDED']).toContain((r.reason as { code: string }).code);
    }
    for (const a of acquired as PromiseFulfilledResult<RunningBroker>[]) running.push(a.value);
  });

  it('stale state file (dead pid) does not block acquisition', async () => {
    const dir = freshDir();
    const endpoint = defaultEndpoint(dir);
    // seed a stale state file pointing at a dead pid
    writeStateFile(dir, { pid: 2147480000, processStartedAt: 't', brokerInstanceId: 'stale', buildId: 'b', endpoint, ownerIdentityHash: ownerIdentityHash() });
    const probe = await checkSingleton(dir, endpoint);
    expect(probe.outcome).toBe('stale_cleared');
    // and a real broker can start over the stale file
    const b = await startBrokerHost({ dataDir: dir });
    running.push(b);
    expect(b.brokerInstanceId).toBeTruthy();
  });

  it('a reachable broker is detected by the probe (already_running)', async () => {
    const dir = freshDir();
    const b = await startBrokerHost({ dataDir: dir });
    running.push(b);
    const probe = await checkSingleton(dir, b.endpoint);
    expect(probe.outcome).toBe('already_running');
    expect(probe.endpoint).toBe(b.endpoint);
  });

  it('different data dirs get different endpoints and both start', async () => {
    const d1 = freshDir();
    const d2 = freshDir();
    const b1 = await startBrokerHost({ dataDir: d1 });
    const b2 = await startBrokerHost({ dataDir: d2 });
    running.push(b1, b2);
    expect(b1.endpoint).not.toBe(b2.endpoint);
  });
});
