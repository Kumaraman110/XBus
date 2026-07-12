/**
 * Beta.5 Phase 1 — the FULL vertical, end to end, with a REAL broker host + dashboard:
 *
 *   SessionStart announce (over real secure IPC) → daemon → one txn → ledger event
 *   → authenticated dashboard read model (over real loopback HTTP) shows the session.
 *
 * Also proves the two cross-cutting guarantees for this slice:
 *   - beta.4.1 request/ACK/reply messaging is UNCHANGED while the dashboard is live
 *     (a send→inbox→ack→reply round-trip succeeds with the dashboard running), and
 *   - a concurrent dashboard read (incl. a ledger scan) does not disturb the broker
 *     (the message round-trip still completes; one broker instance throughout).
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
import { readStateFile } from '../../src/broker/state-file.js';

let dataDir: string; let broker: RunningBroker; let endpoint: string; let rootSecret: Buffer;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-cpe2e-'));
  endpoint = defaultEndpoint(dataDir);
  broker = await startBrokerHost({ dataDir, dashboard: true, enforceSingleton: false });
  rootSecret = broker.rootSecret!;
});
afterEach(async () => {
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function hookClient(sessionId: string): Promise<IpcClient> {
  const c = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'hook', claimedSessionId: sessionId } });
  await c.connect();
  await doHello(c, ComponentRole.HOOK);
  await c.request('register_session', { sessionId, instanceId: `i-${sessionId}`, processId: process.pid, projectId: 'proj-x', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK });
  return c;
}
async function mcpClient(sessionId: string, alias: string): Promise<IpcClient> {
  const c = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'mcp', claimedSessionId: sessionId } });
  await c.connect();
  await doHello(c, ComponentRole.MCP);
  await c.request('register_session', { sessionId, instanceId: `i-${sessionId}`, processId: process.pid, projectId: 'proj-x', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: ComponentRole.MCP });
  await c.request('signal_readiness', { ackAvailable: true, versionOk: true });
  await c.request('register_alias', { alias });
  return c;
}
async function token(): Promise<string> {
  // The auth store is broker-owned + in-memory; drive the exchange through HTTP the same
  // way a browser would. We can't mint a nonce from the test (the broker owns it), so use
  // the dashboard's exchange after minting via the running server's auth — exposed only
  // through the real flow. Here we reach the broker's DashboardServer directly.
  const url = broker.dashboardUrl!;
  // The server holds a DashboardAuth; there is no HTTP "mint" (mint is broker-internal on
  // browser-open). For the test we mint via the server's auth object accessed off the
  // RunningBroker.dashboard instance, then exchange over real HTTP.
  const auth = (broker.dashboard as unknown as { auth: { mintNonce(): string } }).auth;
  const nonce = auth.mintNonce();
  const res = await fetch(`${url}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce }) });
  return (await res.json() as { token: string }).token;
}

describe('control plane E2E — announce → ledger → authenticated dashboard', () => {
  it('a SessionStart announce appears in the authenticated dashboard read model + ledger', async () => {
    const sid = '10101010-1010-4010-8010-101010101010';
    const c = await hookClient(sid);
    const ack = await c.request('announce_session', { source: 'startup', cwd: '/tmp/x', transcriptPath: '/p/t.jsonl' });
    expect(ack.frameType).toBe('announce_session_ack');

    const tk = await token();
    const url = broker.dashboardUrl!;
    // Sessions API shows the announced session, labelled + source-tagged.
    const sres = await fetch(`${url}/api/sessions`, { headers: { Authorization: `Bearer ${tk}` } });
    expect(sres.status).toBe(200);
    const { sessions } = await sres.json() as { sessions: Array<{ sessionId: string; source: string; managementState: string; label: string }> };
    const row = sessions.find((s) => s.sessionId === sid)!;
    expect(row).toBeTruthy();
    expect(row.source).toBe('startup');
    expect(row.managementState).toBe('active');
    // Ledger API shows the SESSION_STARTED event (body-free).
    const lres = await fetch(`${url}/api/ledger?limit=50`, { headers: { Authorization: `Bearer ${tk}` } });
    const { events } = await lres.json() as { events: Array<{ eventType: string; subject: { sessionId?: string } }> };
    expect(events.some((e) => e.eventType === 'SESSION_STARTED' && e.subject?.sessionId === sid)).toBe(true);
    c.close();
  });

  it('the state file records the dashboard port + url (single-instance discovery)', () => {
    const s = readStateFile(dataDir)!;
    expect(s.dashboardPort).toBeGreaterThan(0);
    expect(s.dashboardUrl).toContain('127.0.0.1');
  });

  it('beta.4.1 messaging is UNCHANGED while the dashboard is live (send→inbox→ack→reply)', async () => {
    const A = await mcpClient('20202020-2020-4020-8020-202020202020', 'architect');
    const B = await mcpClient('30303030-3030-4030-8030-303030303030', 'implementer');
    // Concurrently hammer the dashboard with a ledger scan to prove reads don't disturb delivery.
    const tk = await token();
    const url = broker.dashboardUrl!;
    const scan = fetch(`${url}/api/ledger?limit=500`, { headers: { Authorization: `Bearer ${tk}` } });

    const s = await A.request('send_message', { to: 'implementer', text: 'ping while dashboard live', requiresAck: true, requiresReply: true });
    expect(s.frameType).toBe('send_message_ack');
    const inb = await B.request('inbox', { limit: 10 });
    const msgs = (inb.payload as { messages: Array<{ messageId: string; text: string; injectionId: string }> }).messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain('ping while dashboard live');
    const receipt = msgs[0]!.injectionId;
    const ack = await B.request('ack_message', { messageId: msgs[0]!.messageId, status: 'accepted', injectionId: receipt });
    expect((ack.payload as { state: string }).state).toBe('accepted');
    const reply = await B.request('reply_message', { messageId: msgs[0]!.messageId, text: 'pong', outcome: 'completed', injectionId: receipt });
    expect(reply.frameType).toBe('reply_message_ack');
    const aPull = await A.request('inbox', { limit: 10 });
    expect((aPull.payload as { messages: Array<{ text: string }> }).messages[0]!.text).toBe('pong');

    await scan; // the concurrent dashboard read completed independently
    A.close(); B.close();
  });
});
