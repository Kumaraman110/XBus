/**
 * Split-brain prevention (ADR 0008): one writable (mcp) owner per session epoch.
 * A second concurrent mcp registration is rejected (SESSION_ALREADY_ACTIVE) until
 * the first closes or an explicit takeover (supersede) runs. Hooks coexist.
 * Real broker + IPC + SQLite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { clientHello } from '../../src/ipc/hello.js';

let dataDir: string;
let broker: RunningBroker;
const clients: IpcClient[] = [];

async function comp(sessionId: string, role: string, opts: { supersede?: boolean } = {}): Promise<{ c: IpcClient; ack: unknown }> {
  const c = new IpcClient(broker.endpoint, { requestTimeoutMs: 3000, rootSecret: broker.rootSecret });
  await c.connect();
  clients.push(c);
  await c.request('hello', clientHello(role as 'mcp'));
  const ack = await c.request('register_session', {
    sessionId, instanceId: `i-${Math.random().toString(36).slice(2)}`, processId: process.pid,
    projectId: 'p', cwd: process.cwd(), receiveMode: 'hook_checkpoint', capabilities: [], role,
    ...(opts.supersede ? { supersede: true } : {}),
  });
  return { c, ack };
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-sb-'));
  broker = await startBrokerHost({ dataDir });
});
afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const SID = '33330000-cccc-4ccc-8ccc-cccccccc3333';

describe('split-brain prevention (one writable owner per session)', () => {
  it('a SECOND concurrent mcp owner is rejected with SESSION_ALREADY_ACTIVE', async () => {
    const first = await comp(SID, 'mcp');
    expect((first.ack as { frameType: string }).frameType).toBe('register_session_ack');
    // second mcp on a different connection, first still live -> rejected
    const second = await comp(SID, 'mcp');
    expect((second.ack as { frameType: string }).frameType).toBe('error');
    expect((second.ack as { payload: { code: string } }).payload.code).toBe('XBUS_SESSION_ALREADY_ACTIVE');
  });

  it('a hook component CAN coexist with the live mcp owner (same epoch)', async () => {
    await comp(SID, 'mcp');
    const hook = await comp(SID, 'hook');
    expect((hook.ack as { frameType: string }).frameType).toBe('register_session_ack');
  });

  it('after the first owner disconnects, a new mcp owner is accepted (same epoch reuse)', async () => {
    const first = await comp(SID, 'mcp');
    first.c.close();
    await new Promise((r) => setTimeout(r, 150)); // let onConnClose mark it closed
    const second = await comp(SID, 'mcp');
    expect((second.ack as { frameType: string }).frameType).toBe('register_session_ack');
    const epoch = (broker.db.prepare('SELECT active_epoch FROM sessions WHERE session_id=?').get(SID) as { active_epoch: number }).active_epoch;
    expect(epoch).toBe(1); // reconnect after clean close reuses the epoch, no bump
  });

  it('explicit takeover (supersede) displaces a live owner and advances the epoch', async () => {
    await comp(SID, 'mcp'); // first owner stays live
    const taker = await comp(SID, 'mcp', { supersede: true });
    expect((taker.ack as { frameType: string }).frameType).toBe('register_session_ack');
    const epoch = (broker.db.prepare('SELECT active_epoch FROM sessions WHERE session_id=?').get(SID) as { active_epoch: number }).active_epoch;
    expect(epoch).toBe(2); // takeover advances the epoch; old components fenced
    // the old owner's components are no longer live
    const liveOld = broker.db.prepare(`SELECT COUNT(*) n FROM component_instances WHERE session_id=? AND epoch=1 AND state='live'`).get(SID) as { n: number };
    expect(liveOld.n).toBe(0);
  });
});
