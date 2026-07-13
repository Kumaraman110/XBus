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
import { verifyLedger } from '../../src/broker/ledger.js';

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
/** Obtain a tab token via the SAME PUBLIC path a user's browser drives (blocker #3): mint a
 *  one-time open-URL through the broker's public `ensure_dashboard` IPC (no private-field
 *  access), parse the nonce from the URL FRAGMENT, then exchange it over real HTTP. */
async function token(): Promise<string> {
  const openUrl = await mintOpenUrl();
  const nonce = /#n=([^&]+)/.exec(openUrl)![1]!;
  const res = await fetch(`${broker.dashboardUrl!}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce: decodeURIComponent(nonce) }) });
  return (await res.json() as { token: string }).token;
}
/** Mint an open-URL via the public ensure_dashboard IPC frame (the CLI's path). */
async function mintOpenUrl(): Promise<string> {
  const c = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'admin' } });
  await c.connect();
  await doHello(c, ComponentRole.ADMIN);
  await c.request('register_session', { sessionId: `cli-${Math.random().toString(36).slice(2)}`, instanceId: 'i', processId: process.pid, projectId: 'proj-cli', cwd: '/tmp/x', receiveMode: 'poll_only', capabilities: ['cli'], role: ComponentRole.ADMIN });
  const r = await c.request('ensure_dashboard', {});
  c.close();
  const p = r.payload as { available: boolean; openUrl?: string };
  if (!p.available || !p.openUrl) throw new Error('dashboard not available via ensure_dashboard');
  return p.openUrl;
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

  it('the state file records the dashboard port + url (single-instance discovery), and NEVER a nonce/token', () => {
    const s = readStateFile(dataDir)!;
    expect(s.dashboardPort).toBeGreaterThan(0);
    expect(s.dashboardUrl).toContain('127.0.0.1');
    // Blocker #3: the nonce/token must NEVER be written to the state file.
    const raw = JSON.stringify(s);
    expect(raw).not.toContain('#n=');
    expect(/token/i.test(raw)).toBe(false);
  });

  it('blocker #3: public ensure_dashboard mint → fragment nonce → exchange → authed read; nonce is single-use', async () => {
    const openUrl = await mintOpenUrl();
    // The nonce is in the URL FRAGMENT, and the base dashboard URL carries NO nonce.
    expect(openUrl.startsWith(`${broker.dashboardUrl!}/#n=`)).toBe(true);
    expect(broker.dashboardUrl!).not.toContain('#');
    const nonce = decodeURIComponent(/#n=([^&]+)/.exec(openUrl)![1]!);
    // First exchange succeeds → a working tab token.
    const r1 = await fetch(`${broker.dashboardUrl!}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce }) });
    expect(r1.status).toBe(200);
    const tk = (await r1.json() as { token: string }).token;
    const authed = await fetch(`${broker.dashboardUrl!}/api/sessions`, { headers: { Authorization: `Bearer ${tk}` } });
    expect(authed.status).toBe(200);
    // The SAME nonce cannot be exchanged twice (single-use).
    const r2 = await fetch(`${broker.dashboardUrl!}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce }) });
    expect(r2.status).toBe(401);
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

  it('FOUR-REPLICA directed matrix delivers correctly UNDER concurrent dashboard load (reads never disturb delivery)', async () => {
    // Four sessions (replicas) sharing the one broker + the live dashboard. Each sends a
    // directed message to the next in a ring (r0→r1→r2→r3→r0) while a pathological dashboard
    // read load (repeated full ledger + sessions scans) hammers the off-loop worker. Every
    // message must deliver + ack + reply correctly, the broker instance must be unchanged
    // throughout, and the hash chain must stay valid — proving the Q5 "dashboard cannot
    // destabilize delivery" guarantee at multi-session scale, not just a 2-party round-trip.
    const ids = ['40404040-4040-4040-8040-000000000001', '40404040-4040-4040-8040-000000000002', '40404040-4040-4040-8040-000000000003', '40404040-4040-4040-8040-000000000004'];
    const aliases = ['rep0', 'rep1', 'rep2', 'rep3'];
    const clients = await Promise.all(ids.map((id, i) => mcpClient(id, aliases[i]!)));
    const instanceBefore = broker.brokerInstanceId;
    const tk = await token();
    const url = broker.dashboardUrl!;

    // Background pathological dashboard load: keep scanning the full ledger + all sessions
    // for the duration of the matrix. A flag stops it once the matrix completes.
    let loadRunning = true;
    let scans = 0;
    const loadLoop = (async () => {
      while (loadRunning) {
        await Promise.all([
          fetch(`${url}/api/ledger?limit=500`, { headers: { Authorization: `Bearer ${tk}` } }).then((r) => r.arrayBuffer()),
          fetch(`${url}/api/sessions`, { headers: { Authorization: `Bearer ${tk}` } }).then((r) => r.arrayBuffer()),
        ]);
        scans += 1;
      }
    })();

    // Directed ring matrix: each replica sends to the next; the recipient acks + replies.
    for (let i = 0; i < clients.length; i++) {
      const sender = clients[i]!;
      const recipientAlias = aliases[(i + 1) % clients.length]!;
      const recipient = clients[(i + 1) % clients.length]!;
      const nonce = `MATRIX-${i}`;
      const s = await sender.request('send_message', { to: recipientAlias, text: `ring ${nonce}`, requiresAck: true, requiresReply: true });
      expect(s.frameType, `send ${i}→${recipientAlias}`).toBe('send_message_ack');
      const inb = await recipient.request('inbox', { limit: 10 });
      const m = (inb.payload as { messages: Array<{ messageId: string; text: string; injectionId: string }> }).messages.find((x) => x.text.includes(nonce));
      expect(m, `recipient ${recipientAlias} received ${nonce}`).toBeTruthy();
      const ack = await recipient.request('ack_message', { messageId: m!.messageId, status: 'accepted', injectionId: m!.injectionId });
      expect((ack.payload as { state: string }).state).toBe('accepted');
      const reply = await recipient.request('reply_message', { messageId: m!.messageId, text: `ack ${nonce}`, outcome: 'completed', injectionId: m!.injectionId });
      expect(reply.frameType).toBe('reply_message_ack');
      // The original sender receives the correlated reply.
      const back = await sender.request('inbox', { limit: 10 });
      expect((back.payload as { messages: Array<{ text: string }> }).messages.some((x) => x.text === `ack ${nonce}`)).toBe(true);
    }

    loadRunning = false;
    await loadLoop;
    expect(scans, 'the dashboard was under real concurrent read load').toBeGreaterThan(0);

    // One broker throughout; every matrix message delivered (12 deliveries: 4 requests + 4
    // replies is 8, plus acks are receipts not deliveries) — assert all 4 requests completed.
    expect(broker.brokerInstanceId).toBe(instanceBefore);
    const completed = (broker.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE state='completed'`).get() as { n: number }).n;
    expect(completed).toBeGreaterThanOrEqual(4);
    // Hash chain still valid after all the concurrent activity.
    const v = verifyLedger(broker.db);
    expect(v.ok).toBe(true);

    for (const c of clients) c.close();
  }, 60_000);
});
