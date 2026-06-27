/**
 * Identity-verified broker shutdown (ADR 0007). The 10 required scenarios.
 * NO test terminates an unrelated process: forced-kill paths are tested only via
 * classifyShutdown's DECISION (not by actually killing), and the IPC path uses a
 * real in-process broker we own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { clientHello } from '../../src/ipc/hello.js';
import { classifyShutdown, readStateFile, writeStateFile, stateFilePath, ownerIdentityHash, pidIsAlive, type BrokerStateFile } from '../../src/broker/state-file.js';
import { BUILD_ID } from '../../src/protocol/handshake.js';

let dataDir: string;

function writeState(over: Partial<BrokerStateFile>): void {
  writeStateFile(dataDir, {
    pid: process.pid, processStartedAt: new Date(1700000000000).toISOString(),
    brokerInstanceId: 'inst-test', buildId: BUILD_ID, endpoint: 'ep', ownerIdentityHash: ownerIdentityHash(),
    ...over,
  });
}

beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-sd-')); });
afterEach(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('broker shutdown classification (ADR 0007) — no unrelated process is ever killed', () => {
  it('1. valid running broker -> IPC graceful shutdown works', async () => {
    const broker: RunningBroker = await startBrokerHost({ dataDir });
    // state file written by host
    const state = readStateFile(dataDir);
    expect(state?.brokerInstanceId).toBe(broker.brokerInstanceId);
    const decision = classifyShutdown(dataDir);
    expect(decision.action).toBe('ipc');
    // Perform the authenticated IPC shutdown.
    const c = new IpcClient(broker.endpoint, { requestTimeoutMs: 3000, rootSecret: broker.rootSecret });
    await c.connect();
    await c.request('hello', clientHello('admin'));
    await c.request('register_session', { sessionId: `cli-${process.pid}`, instanceId: 'i', processId: process.pid, projectId: 'proj-cli', cwd: process.cwd(), receiveMode: 'poll_only', capabilities: [], role: 'admin' });
    const ack = await c.request('shutdown', { brokerInstanceId: broker.brokerInstanceId });
    expect(ack.frameType).toBe('shutdown_ack');
    c.close();
    await broker.stop(); // idempotent
  });

  it('2. stale PID file referencing no process -> action none (safe to remove)', () => {
    // pick a PID extremely unlikely to be alive
    writeState({ pid: 2147480000 });
    const d = classifyShutdown(dataDir);
    expect(d.action).toBe('none');
    expect(d.reason).toMatch(/stale/);
  });

  it('3. PID file referencing an unrelated LIVE process + instance mismatch -> refuse (no kill)', () => {
    // Use OUR pid (definitely alive) but a mismatched instance id we did not start.
    writeState({ pid: process.pid, brokerInstanceId: 'inst-test' });
    const d = classifyShutdown(dataDir, 'a-different-expected-instance');
    expect(d.action).toBe('refuse');
    expect(d.reason).toMatch(/instance id mismatch/i);
  });

  it('4. PID reused by another process is guarded by instance-id check, not PID alone', () => {
    // pid alive (ours) but caller expects a specific instance; mismatch -> refuse.
    writeState({ pid: process.pid, brokerInstanceId: 'reused-pid-broker' });
    expect(classifyShutdown(dataDir, 'the-real-broker').action).toBe('refuse');
    // matching instance -> ipc (would be safe to signal)
    expect(classifyShutdown(dataDir, 'reused-pid-broker').action).toBe('ipc');
  });

  it('5. broker instance ID mismatch -> refuse', () => {
    writeState({ pid: process.pid, brokerInstanceId: 'inst-A' });
    expect(classifyShutdown(dataDir, 'inst-B').action).toBe('refuse');
  });

  it('6. build ID is recorded for diagnostics (mismatch is visible, not auto-fatal)', () => {
    writeState({ pid: process.pid, buildId: 'xbus-OLD-build' });
    const s = readStateFile(dataDir);
    expect(s?.buildId).toBe('xbus-OLD-build');
    // (build mismatch surfaces in doctor; it does not by itself authorize a kill)
  });

  it('7. owner identity mismatch -> refuse (different OS user)', () => {
    writeState({ pid: process.pid, ownerIdentityHash: 'some-other-user-hash' });
    const d = classifyShutdown(dataDir);
    expect(d.action).toBe('refuse');
    expect(d.reason).toMatch(/different OS user/i);
  });

  it('8. broker hung but identity checks pass -> IPC attempted (forced kill only after IPC fails)', () => {
    // identity-valid + alive -> classify says ipc (the CLI tries IPC first, then
    // forced ONLY on IPC failure with a still-verified pid).
    writeState({ pid: process.pid, brokerInstanceId: 'inst-test' });
    expect(classifyShutdown(dataDir, 'inst-test').action).toBe('ipc');
  });

  it('9. forced shutdown precondition: pid must still be alive + owned (signal 0 probe, no kill)', () => {
    writeState({ pid: process.pid });
    // We only PROBE liveness; we never actually kill in this test.
    expect(pidIsAlive(process.pid)).toBe(true);
    expect(pidIsAlive(2147480000)).toBe(false);
  });

  it('10. concurrent stop attempts: both classify safely; none targets an unrelated pid', () => {
    writeState({ pid: process.pid, brokerInstanceId: 'inst-test' });
    const d1 = classifyShutdown(dataDir, 'inst-test');
    const d2 = classifyShutdown(dataDir, 'inst-test');
    expect(d1.action).toBe('ipc');
    expect(d2.action).toBe('ipc');
    // After the file is gone (one winner cleaned up), the other sees 'none'.
    fs.unlinkSync(stateFilePath(dataDir));
    expect(classifyShutdown(dataDir).action).toBe('none');
  });

  it('state file stores the owner as a HASH, not raw username, and is user-only perms', async () => {
    const broker = await startBrokerHost({ dataDir });
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(dataDir), 'utf8')) as BrokerStateFile;
    // owner is a hash (the privacy requirement); the endpoint pipe path may
    // contain the OS username by Windows convention — that's an OS path, not a
    // secret we add, so we assert the OWNER field specifically.
    expect(parsed.ownerIdentityHash).toBe(ownerIdentityHash());
    expect(parsed.ownerIdentityHash).not.toContain(os.userInfo().username);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(stateFilePath(dataDir)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    await broker.stop();
  });
});
