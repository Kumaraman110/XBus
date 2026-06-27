/**
 * §3 — secure resource-pressure testing over XBUS-STP.
 *
 * Adversarial clients (slow-loris, connect flood, oversized frame, pre-handshake
 * garbage, replay/tag-fail) are run against a REAL broker host with the secure
 * transport enabled, alongside legitimate encrypted clients. The broker must:
 *   - stay alive and keep serving legitimate traffic throughout;
 *   - bound its connection table, buffered bytes, and resident memory;
 *   - close abusive connections uniformly (no oracle, no crash);
 *   - survive a root-secret rotation and a restart with encrypted clients in flight.
 *
 * These are coarse, deterministic-enough resource assertions (not microbenchmarks):
 * the point is "the broker does not grow without bound or fall over under abuse".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { doHello } from '../../src/ipc/hello.js';
import { ComponentRole } from '../../src/identity/components.js';
import { encodeFrame } from '../../src/ipc/framing.js';
import { rotateRootSecret } from '../../src/ipc/root-secret.js';

let dataDir: string;
let broker: RunningBroker;
const rawSockets: net.Socket[] = [];
const clients: IpcClient[] = [];

function endpointTarget(endpoint: string): net.NetConnectOpts {
  // On Windows the endpoint is a named pipe path; elsewhere a UDS path.
  return process.platform === 'win32' ? { path: endpoint } : { path: endpoint };
}

function rawConnect(endpoint: string): net.Socket {
  const s = net.connect(endpointTarget(endpoint));
  rawSockets.push(s);
  s.on('error', () => { /* abusive sockets are expected to be reset */ });
  return s;
}

async function registeredClient(sessionId: string, role: ComponentRole = ComponentRole.MCP): Promise<IpcClient> {
  const c = new IpcClient(broker.endpoint, { rootSecret: broker.rootSecret!, helloIdentity: { claimedRole: 'mcp', claimedSessionId: sessionId } });
  clients.push(c);
  await c.connect();
  await doHello(c, role);
  await c.request('register_session', {
    sessionId, instanceId: `inst-${sessionId}`, processId: process.pid, projectId: 'p',
    cwd: process.cwd(), receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role,
  });
  await c.request('signal_readiness', { ackAvailable: true, versionOk: true });
  return c;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect a legitimate client, riding out a saturated connect-rate window. */
async function registeredClientRetry(sessionId: string): Promise<IpcClient> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await registeredClient(sessionId);
    } catch (e) {
      lastErr = e;
      // Drop the half-open client and wait for the 1s connect-rate window to refill.
      const dead = clients.pop();
      try { dead?.close(); } catch { /* ignore */ }
      await wait(600);
    }
  }
  throw lastErr;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-pressure-'));
  broker = await startBrokerHost({
    dataDir,
    // Tight bounds make the limits observable quickly without huge fixtures.
    maxConnections: 24,
    connectRatePerSec: 12,
    handshakeTimeoutMs: 400,
    globalBufferBudgetBytes: 2 * 1024 * 1024,
  });
});

afterEach(async () => {
  for (const s of rawSockets) { try { s.destroy(); } catch { /* ignore */ } }
  rawSockets.length = 0;
  for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
  clients.length = 0;
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('§3 secure resource-pressure over XBUS-STP', () => {
  it('slow-loris: a socket that never completes the handshake is force-closed (bounded slot hold)', async () => {
    const s = rawConnect(broker.endpoint);
    let closed = false;
    s.on('close', () => { closed = true; });
    await new Promise<void>((resolve) => s.on('connect', () => resolve()));
    // Send a single client_hello-shaped frame then go silent forever.
    s.write(encodeFrame({ h: 'ch', d: Buffer.from('not-a-real-hello').toString('base64') }));
    // handshakeTimeoutMs = 400 — the broker must drop it well before idle timeout.
    await wait(900);
    expect(closed).toBe(true);
    // The broker is unharmed: a legitimate client still completes end to end.
    const c = await registeredClient('aaaa0000-0000-4000-8000-00000000a001');
    const st = await c.request('get_status', {});
    expect(st.frameType).toBe('get_status_ack');
  });

  it('pre-handshake garbage: plaintext protocol frames before the handshake are rejected, broker survives', async () => {
    const s = rawConnect(broker.endpoint);
    let closed = false;
    s.on('close', () => { closed = true; });
    await new Promise<void>((resolve) => s.on('connect', () => resolve()));
    // A normal-looking protocol frame WITHOUT the secure handshake — must be refused
    // (no plaintext privileged fallback).
    s.write(encodeFrame({ protocolVersion: 1, frameType: 'shutdown', timestamp: 't', payload: { brokerInstanceId: broker.brokerInstanceId } }));
    await wait(300);
    expect(closed).toBe(true);
    // Broker still up + still owns its instance id (the spoofed shutdown did nothing).
    const c = await registeredClient('aaaa0000-0000-4000-8000-00000000a002');
    const st = (await c.request('get_status', {})).payload as { brokerInstanceId: string };
    expect(st.brokerInstanceId).toBe(broker.brokerInstanceId);
  });

  it('connect flood: a burst beyond the connect-rate is shed, legitimate clients still connect', async () => {
    // Fire a burst of raw connects well over connectRatePerSec=12.
    for (let i = 0; i < 60; i++) rawConnect(broker.endpoint);
    await wait(200);
    // A legitimate client must still be able to get through (possibly after the
    // 1s window refills). Retry briefly to ride out the rate window.
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      try {
        const c = await registeredClient(`aaaa0000-0000-4000-8000-00000000b0${attempt}`);
        const st = await c.request('get_status', {});
        ok = st.frameType === 'get_status_ack';
      } catch { await wait(400); }
    }
    expect(ok).toBe(true);
  });

  it('oversized frame: a length prefix beyond the budget is rejected and the connection dropped', async () => {
    const s = rawConnect(broker.endpoint);
    let closed = false;
    s.on('close', () => { closed = true; });
    await new Promise<void>((resolve) => s.on('connect', () => resolve()));
    // Write a 4-byte length prefix claiming a frame far larger than the global
    // buffer budget; the decoder/budget guard must reject and close.
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(8 * 1024 * 1024, 0); // 8MB > 2MB budget
    s.write(huge);
    s.write(Buffer.alloc(64 * 1024, 0x41)); // dribble payload
    await wait(300);
    expect(closed).toBe(true);
    const c = await registeredClient('aaaa0000-0000-4000-8000-00000000c001');
    expect((await c.request('get_status', {})).frameType).toBe('get_status_ack');
  });

  it('memory + connection table stay bounded across many abusive connect/abort cycles', async () => {
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    // 300 churn cycles of connect-then-abort raw sockets.
    for (let round = 0; round < 6; round++) {
      const batch: net.Socket[] = [];
      for (let i = 0; i < 50; i++) {
        const s = net.connect(endpointTarget(broker.endpoint));
        s.on('error', () => {});
        batch.push(s);
      }
      await wait(120);
      for (const s of batch) { try { s.destroy(); } catch { /* ignore */ } }
      await wait(120);
    }
    await wait(300);
    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    // Heap growth must be modest (no per-connection leak). Generous ceiling to
    // avoid GC-timing flakiness: 64MB across 300 churned connections.
    expect(after - before).toBeLessThan(64 * 1024 * 1024);
    // The broker still serves a real client (ride out the saturated rate window).
    const c = await registeredClientRetry('aaaa0000-0000-4000-8000-00000000d001');
    expect((await c.request('get_status', {})).frameType).toBe('get_status_ack');
  });

  it('legitimate encrypted traffic keeps flowing while abusive sockets hammer the broker', async () => {
    const a = await registeredClient('aaaa0000-0000-4000-8000-00000000e001');
    const b = await registeredClient('bbbb0000-0000-4000-8000-00000000e002');
    await a.request('register_alias', { alias: 'archX' });
    await b.request('register_alias', { alias: 'implX' });
    // Background abuse: keep opening raw sockets and sending junk.
    let abusing = true;
    const abuse = (async () => {
      while (abusing) {
        const s = net.connect(endpointTarget(broker.endpoint));
        s.on('error', () => {});
        s.on('connect', () => { try { s.write(Buffer.from('garbage-bytes')); } catch { /* ignore */ } });
        await wait(30);
        try { s.destroy(); } catch { /* ignore */ }
      }
    })();
    // Meanwhile, send 20 real messages over the encrypted channel; all must land.
    let delivered = 0;
    for (let i = 0; i < 20; i++) {
      const r = await a.request('send_message', { to: 'implX', text: `msg-${i}`, requiresAck: false });
      if (r.frameType === 'send_message_ack') delivered++;
    }
    abusing = false;
    await abuse;
    expect(delivered).toBe(20);
    // B can read them all back over its encrypted channel.
    const inbox = (await b.request('inbox', { limit: 50 })).payload as { messages: unknown[] };
    expect(inbox.messages.length).toBe(20);
  });

  it('root-secret rotation: clients on the OLD secret can no longer establish a new channel', async () => {
    // A client on the current secret works.
    const before = await registeredClient('aaaa0000-0000-4000-8000-00000000f001');
    expect((await before.request('get_status', {})).frameType).toBe('get_status_ack');
    const oldSecret = Buffer.from(broker.rootSecret!);
    // Rotate the on-disk secret. (The running broker keeps its loaded secret; a
    // RESTART picks up the new one — that is the next test. Here we prove a fresh
    // client using the OLD secret fails to auth against a broker that has the new
    // secret loaded, by starting a second broker bound to the rotated secret.)
    const rotated = rotateRootSecret(dataDir);
    expect(Buffer.compare(rotated, oldSecret)).not.toBe(0);
    // Stop the first broker, start a fresh one in the same dir (loads rotated secret).
    await broker.stop();
    broker = await startBrokerHost({ dataDir, maxConnections: 24, handshakeTimeoutMs: 400 });
    expect(Buffer.compare(broker.rootSecret!, rotated)).toBe(0);
    // A client using the OLD secret must fail to connect (uniform auth failure).
    const stale = new IpcClient(broker.endpoint, { rootSecret: oldSecret, helloIdentity: { claimedRole: 'mcp', claimedSessionId: 'aaaa0000-0000-4000-8000-00000000f002' } });
    clients.push(stale);
    let failed = false;
    try {
      await stale.connect();
      await doHello(stale, ComponentRole.MCP);
    } catch { failed = true; }
    expect(failed).toBe(true);
    // A client using the NEW secret works.
    const fresh = await registeredClient('aaaa0000-0000-4000-8000-00000000f003');
    expect((await fresh.request('get_status', {})).frameType).toBe('get_status_ack');
  });

  it('restart with encrypted clients: a durable message survives a broker restart and is read after reconnect', async () => {
    const a = await registeredClient('aaaa0000-0000-4000-8000-000000010001');
    const b = await registeredClient('bbbb0000-0000-4000-8000-000000010002');
    await a.request('register_alias', { alias: 'archR' });
    await b.request('register_alias', { alias: 'implR' });
    const send = await a.request('send_message', { to: 'implR', text: 'survive-restart', requiresAck: true });
    expect(send.frameType).toBe('send_message_ack');
    // Restart the broker (same dir, same secret). In-flight encrypted sessions die;
    // the durable message must persist and be deliverable after reconnect.
    await broker.stop();
    for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
    clients.length = 0;
    broker = await startBrokerHost({ dataDir, maxConnections: 24, handshakeTimeoutMs: 400 });
    const b2 = await registeredClient('bbbb0000-0000-4000-8000-000000010002');
    const inbox = (await b2.request('inbox', { limit: 10 })).payload as { messages: Array<{ text?: string; bodyIncluded: boolean }> };
    expect(inbox.messages.length).toBe(1);
    expect(inbox.messages[0]!.text).toBe('survive-restart');
  });
});
