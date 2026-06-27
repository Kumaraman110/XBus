/**
 * Integration: the broker's version handshake fails closed BEFORE register, and
 * unknown frames get a typed error (the stale-broker incident, formalized).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { clientHello } from '../../src/ipc/hello.js';
import { SCHEMA_VERSION } from '../../src/protocol/handshake.js';

let dataDir: string;
let broker: RunningBroker;
const clients: IpcClient[] = [];

async function conn(): Promise<IpcClient> {
  const c = new IpcClient(broker.endpoint, { requestTimeoutMs: 3000, rootSecret: broker.rootSecret });
  await c.connect();
  clients.push(c);
  return c;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-vh-'));
  broker = await startBrokerHost({ dataDir });
});
afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('version handshake (fail closed before register)', () => {
  it('a compatible full hello is accepted and reports the broker build', async () => {
    const c = await conn();
    const ack = await c.request('hello', clientHello('mcp'));
    expect(ack.frameType).toBe('hello_ack');
    const p = ack.payload as { ok: boolean; broker: { schemaVersion: number; buildId: string } };
    expect(p.ok).toBe(true);
    expect(p.broker.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('schema-too-new hello (newer plugin, older broker) -> error restart_broker, register blocked', async () => {
    const c = await conn();
    const hello = { ...clientHello('mcp'), schemaVersion: SCHEMA_VERSION + 1 };
    const ack = await c.request('hello', hello);
    expect(ack.frameType).toBe('error');
    expect((ack.payload as { code: string }).code).toBe('XBUS_VERSION_INCOMPATIBLE');
    expect((ack.payload as { detail?: { result?: string } }).detail?.result).toBe('restart_broker');
    // register must be blocked (connection never entered the hello'd set)
    const reg = await c.request('register_session', { sessionId: 'x', instanceId: 'i', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });
    expect(reg.frameType).toBe('error');
    expect((reg.payload as { code: string }).code).toBe('XBUS_AUTH_FAILED'); // "hello required before register"
  });

  it('no-protocol-overlap (client too old) -> error upgrade_component', async () => {
    const c = await conn();
    const hello = { ...clientHello('mcp'), minimumProtocolVersion: 0, maximumProtocolVersion: 0 };
    const ack = await c.request('hello', hello);
    expect(ack.frameType).toBe('error');
    expect((ack.payload as { detail?: { result?: string } }).detail?.result).toBe('upgrade_component');
  });

  it('an unknown frame type gets a typed PROTOCOL_VIOLATION error (not silently ignored)', async () => {
    const c = await conn();
    await c.request('hello', clientHello('mcp'));
    const r = await c.request('totally_unknown_frame' as never, {});
    expect(r.frameType).toBe('error');
    expect((r.payload as { code: string }).code).toBe('XBUS_PROTOCOL_VIOLATION');
  });

  it('register without hello is rejected', async () => {
    const c = await conn();
    const reg = await c.request('register_session', { sessionId: 'x', instanceId: 'i', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });
    expect(reg.frameType).toBe('error');
  });
});
