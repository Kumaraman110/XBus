/**
 * Beta.7 (ADR 0025) — the idle-wake accelerator, end to end over a real broker + secure IPC.
 *
 * Proves the HONEST wake: a durable QUEUED delivery to a ready session makes wake_poll report
 * eligible, and the resident rewaker (runRewaker) fires the documented asyncRewake (exit 2)
 * carrying ONLY a body-free reminder — never the message body. With no eligible delivery it
 * does not fire. The body itself still drains on the pull path (the floor), which this test
 * also confirms: after the wake signal, a checkpoint pull delivers exactly one body.
 *
 * The wake is an ACCELERATOR: correctness never depends on it (the queued delivery drains at
 * the next checkpoint regardless). This test asserts the wake SIGNAL fires when it should.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { defaultEndpoint } from '../../src/ipc/transport.js';
import { doHello } from '../../src/ipc/hello.js';
import { ComponentRole } from '../../src/identity/components.js';
import { runRewaker, WAKE_REMINDER } from '../../src/channel/rewaker.js';

let dataDir: string; let broker: RunningBroker; let endpoint: string; let rootSecret: Buffer;
const S = 'wake0001-0000-4000-8000-000000000001';

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-wake-'));
  endpoint = defaultEndpoint(dataDir);
  broker = await startBrokerHost({ dataDir, dashboard: false, enforceSingleton: false, schedulerIntervalMs: 0, reaperIntervalMs: 0 });
  rootSecret = broker.rootSecret!;
});
afterEach(async () => { await broker.stop(); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function session(): Promise<{ hook: IpcClient; mcp: IpcClient; close: () => void }> {
  const hook = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'hook', claimedSessionId: S } });
  await hook.connect(); await doHello(hook, ComponentRole.HOOK);
  await hook.request('register_session', { sessionId: S, instanceId: 'h', processId: process.pid, projectId: 'p', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK });
  const mcp = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'mcp', claimedSessionId: S } });
  await mcp.connect(); await doHello(mcp, ComponentRole.MCP);
  await mcp.request('register_session', { sessionId: S, instanceId: 'm', processId: process.pid, projectId: 'p', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: ComponentRole.MCP, requestedSessionName: 'wake-target' });
  await mcp.request('signal_readiness', { ackAvailable: true, hookAvailable: true, versionOk: true });
  return { hook, mcp, close: () => { try { hook.close(); } catch {} try { mcp.close(); } catch {} } };
}
async function operatorSend(): Promise<string> {
  // Register an admin/cli sender + send a message TO the target (peer send is fine here — the
  // point is a durable QUEUED delivery to S, which is what wake_poll keys on).
  const c = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'mcp', claimedSessionId: 'sndr0001-0000-4000-8000-0000000000s1' } });
  await c.connect(); await doHello(c, ComponentRole.MCP);
  await c.request('register_session', { sessionId: 'sndr0001-0000-4000-8000-0000000000s1', instanceId: 'is', processId: process.pid, projectId: 'p', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: ComponentRole.MCP });
  const r = await c.request('send_message', { to: 'wake-target', text: 'wake me', requiresAck: true, requiresReply: false });
  const mid = (r.payload as { messageId: string }).messageId;
  c.close();
  return mid;
}

describe('idle-wake accelerator (ADR 0025)', () => {
  it('with NO pending delivery the rewaker does NOT fire (times out, exit 0)', async () => {
    const s = await session();
    // Short lifetime so the test doesn't wait 30 min; no message enqueued → never eligible.
    const r = await runRewaker({ session_id: S }, { endpoint, rootSecret, pollIntervalMs: 5, maxLifetimeMs: 40 });
    expect(r.exitCode).toBe(0);
    expect(r.reason).toBe('timeout');
    s.close();
  }, 30_000);

  it('a queued delivery makes wake_poll eligible → the rewaker fires exit 2 with a BODY-FREE reminder', async () => {
    const s = await session();
    const mid = await operatorSend();
    expect(mid).toBeTruthy();
    // The rewaker sees eligibility on its first poll and fires the documented asyncRewake.
    const r = await runRewaker({ session_id: S }, { endpoint, rootSecret, pollIntervalMs: 5, maxLifetimeMs: 5000 });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toBe('eligible');
    // The reminder is body-free — it must NOT contain the message text.
    expect(r.reminder).toBe(WAKE_REMINDER);
    expect(r.reminder).not.toContain('wake me');

    // FLOOR: the body still drains on the pull path — exactly one delivery at the checkpoint.
    const pulled = await s.hook.request('checkpoint_pull_hook', { checkpointId: 'cp1', limit: 10 });
    const msgs = (pulled.payload as { messages: Array<{ messageId: string; text: string }> }).messages;
    expect(msgs.filter((m) => m.messageId === mid)).toHaveLength(1);
    expect(msgs.find((m) => m.messageId === mid)!.text).toBe('wake me');
    // After draining, wake_poll is no longer eligible (delivery left the queued state).
    const r2 = await runRewaker({ session_id: S }, { endpoint, rootSecret, pollIntervalMs: 5, maxLifetimeMs: 40 });
    expect(r2.exitCode).toBe(0);
    s.close();
  }, 30_000);

  it('a PAUSED session is not eligible even with a queued delivery (auto-delivery gate)', async () => {
    const s = await session();
    await operatorSend();
    // Pause this session's delivery → wake must NOT fire (the checkpoint wouldn't inject either).
    await s.mcp.request('set_control', { mode: 'paused' });
    const r = await runRewaker({ session_id: S }, { endpoint, rootSecret, pollIntervalMs: 5, maxLifetimeMs: 40 });
    expect(r.exitCode).toBe(0);
    expect(r.reason).toBe('timeout');
    s.close();
  }, 30_000);
});
