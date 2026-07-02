/**
 * Final-review #5 regression: the MCP `checkpoint_pull` handler (daemon.onCheckpointPull)
 * must refresh the recipient's 15-day meaningful-activity clock when it INJECTS a body —
 * not only the hook path (checkpoint_pull_hook). Otherwise an MCP client that receives
 * bodies via checkpoint_pull silently expires mid-use (ADR 0012 Decision 5).
 *
 * Uses a real BrokerDaemon with an injected FakeClock so the timestamp delta is
 * deterministic; drives the real `checkpoint_pull` IPC frame.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerDaemon } from '../../src/broker/daemon.js';
import { IpcClient } from '../../src/ipc/client.js';
import { defaultEndpoint, ensureDataDir } from '../../src/ipc/transport.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dataDir: string; let db: SqliteDriver; let daemon: BrokerDaemon; let endpoint: string; let clock: FakeClock;
const clients: IpcClient[] = [];

async function conn(): Promise<IpcClient> {
  const c = new IpcClient(endpoint, { idGen: () => `req-${Math.random().toString(36).slice(2)}` });
  await c.connect();
  clients.push(c);
  await c.request('hello', { protocolVersion: 1 });
  return c;
}
function activityAt(sessionId: string): string | null {
  return (db.prepare('SELECT last_meaningful_activity_at AS a FROM sessions WHERE session_id=?').get(sessionId) as { a: string | null }).a;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-mcpact-'));
  ensureDataDir(dataDir);
  endpoint = defaultEndpoint(dataDir);
  db = openDatabase(path.join(dataDir, 'xbus.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  daemon = new BrokerDaemon(db, endpoint, clock, new SeqIdGen('m'), 'broker-mcpact', {});
  await daemon.start();
});
afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await daemon.stop();
  db.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('MCP checkpoint_pull refreshes meaningful activity (final-review #5)', () => {
  it('a checkpoint_pull that INJECTS a body advances last_meaningful_activity_at', async () => {
    const A = 'aaaa0000-0000-4000-8000-0000000000a5';
    const B = 'bbbb0000-0000-4000-8000-0000000000b5';
    const sender = await conn();
    await sender.request('register_session', { sessionId: A, instanceId: 'iA', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'act-sender' });
    const recv = await conn();
    await recv.request('register_session', { sessionId: B, instanceId: 'iB', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'act-receiver' });
    await recv.request('signal_readiness', { ackAvailable: true, versionOk: true });
    // Send A -> B, then let time pass so a refresh is observable.
    await sender.request('send_message', { to: 'act-receiver', text: 'body-for-activity', kind: 'request', requiresAck: true, requiresReply: false });
    const before = activityAt(B);
    clock.advance(60_000); // 1 minute later
    // B pulls via the MCP checkpoint_pull frame — this INJECTS the body.
    const pull = await recv.request('checkpoint_pull', { limit: 10 });
    const msgs = (pull.payload as { messages: Array<{ metadata?: Record<string, string> }> }).messages ?? [];
    expect(msgs.length).toBe(1);
    // The body-injecting MCP pull is meaningful recipient activity → clock advanced.
    const after = activityAt(B);
    expect(after).not.toBe(before);
    expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime());
    expect(after).toBe(clock.nowIso());
  });

  it('an EMPTY checkpoint_pull (nothing to inject) does NOT refresh activity', async () => {
    const B = 'cccc0000-0000-4000-8000-0000000000c5';
    const recv = await conn();
    await recv.request('register_session', { sessionId: B, instanceId: 'iB', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'empty-recv' });
    await recv.request('signal_readiness', { ackAvailable: true, versionOk: true });
    const before = activityAt(B);
    clock.advance(60_000);
    const pull = await recv.request('checkpoint_pull', { limit: 10 }); // nothing pending
    expect(((pull.payload as { messages: unknown[] }).messages ?? []).length).toBe(0);
    // No body injected ⇒ not meaningful ⇒ activity unchanged (passive read must not extend).
    expect(activityAt(B)).toBe(before);
  });

  it('re-review #3: an intentional set_control (pause/DND) refreshes meaningful activity (ADR 0012 D5)', async () => {
    const B = 'dddd0000-0000-4000-8000-0000000000d5';
    const c = await conn();
    await c.request('register_session', { sessionId: B, instanceId: 'iB', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', requestedSessionName: 'ctrl-recv' });
    await c.request('signal_readiness', { ackAvailable: true, versionOk: true });
    const before = activityAt(B);
    clock.advance(60_000);
    // An intentional pause is a meaningful control change — must refresh the idle timer.
    await c.request('set_control', { mode: 'paused' });
    const afterPause = activityAt(B);
    expect(afterPause).not.toBe(before);
    expect(new Date(afterPause!).getTime()).toBeGreaterThan(new Date(before!).getTime());
    // Resume is also meaningful.
    clock.advance(60_000);
    await c.request('set_control', { mode: 'active' });
    expect(new Date(activityAt(B)!).getTime()).toBeGreaterThan(new Date(afterPause!).getTime());
  });
});
