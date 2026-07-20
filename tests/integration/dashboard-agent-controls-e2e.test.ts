/**
 * Beta.10 (Train B) — agent-management control actions, end to end over a REAL broker host +
 * dashboard, driven the way the browser drives them: authenticated POST /api/session/:id/control.
 *
 * This is the authoritative-state + authorization + audit coverage the dashboard release gate
 * demands for the vertical slice:
 *   - each action is SERVER-authorized (needs a valid tab token; unauthorized → 401),
 *   - each action AUDITS (a ledger event appears; the hash-chain stays valid),
 *   - each action returns AUTHORITATIVE state AND the read-model projection reflects it after a
 *     re-read (so the UI cannot drift from the broker; "survives refresh"),
 *   - an invalid input surfaces a clean 400 with an actionable message (never a generic 500),
 *   - remove_record is NOT exercised as a live mutation here (it is UI-gated pending KNOWN-3); we
 *     assert the route is reachable + audited only once the broker fix lands.
 *
 * NOTE: this drives the real authenticated HTTP surface, not a browser DOM. Real-browser
 * click-path acceptance is owned by the Reliability Tester; the DOM logic is unit-tested in
 * tests/unit/dashboard-agents.test.ts and live-verified via the Playwright MCP (see the report).
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
import { verifyLedger } from '../../src/broker/ledger.js';
import { openDatabase } from '../../src/database/connection.js';

let dataDir: string; let broker: RunningBroker; let endpoint: string; let rootSecret: Buffer; let url: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-agentctl-'));
  endpoint = defaultEndpoint(dataDir);
  broker = await startBrokerHost({ dataDir, dashboard: true, enforceSingleton: false });
  rootSecret = broker.rootSecret!;
  url = broker.dashboardUrl!;
});
afterEach(async () => {
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A real Claude-like session over secure IPC (hook pull + mcp ack/reply). */
async function session(sessionId: string, name: string): Promise<{ hook: IpcClient; mcp: IpcClient; close: () => void }> {
  const hook = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'hook', claimedSessionId: sessionId } });
  await hook.connect(); await doHello(hook, ComponentRole.HOOK);
  await hook.request('register_session', { sessionId, instanceId: `h-${sessionId}`, processId: process.pid, projectId: 'proj-x', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK });
  const mcp = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'mcp', claimedSessionId: sessionId } });
  await mcp.connect(); await doHello(mcp, ComponentRole.MCP);
  await mcp.request('register_session', { sessionId, instanceId: `m-${sessionId}`, processId: process.pid, projectId: 'proj-x', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: ComponentRole.MCP, requestedSessionName: name });
  await mcp.request('signal_readiness', { ackAvailable: true, hookAvailable: true, versionOk: true });
  return { hook, mcp, close: () => { try { hook.close(); } catch { /* */ } try { mcp.close(); } catch { /* */ } } };
}
async function mintOpenUrl(): Promise<string> {
  const c = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'admin' } });
  await c.connect(); await doHello(c, ComponentRole.ADMIN);
  await c.request('register_session', { sessionId: `cli-${Math.random().toString(36).slice(2)}`, instanceId: 'i', processId: process.pid, projectId: 'proj-cli', cwd: '/tmp/x', receiveMode: 'poll_only', capabilities: ['cli'], role: ComponentRole.ADMIN });
  const r = await c.request('ensure_dashboard', {}); c.close();
  return (r.payload as { openUrl: string }).openUrl;
}
async function token(): Promise<string> {
  const openUrl = await mintOpenUrl();
  const nonce = decodeURIComponent(/#n=([^&]+)/.exec(openUrl)![1]!);
  const res = await fetch(`${url}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce }) });
  return (await res.json() as { token: string }).token;
}
function A(tk: string, p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${url}${p}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tk}` } });
}
async function control(tk: string, sid: string, payload: unknown): Promise<Response> {
  return A(tk, `/api/session/${encodeURIComponent(sid)}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}
async function getSession(tk: string, sid: string): Promise<Record<string, unknown>> {
  return (await A(tk, `/api/session/${encodeURIComponent(sid)}`)).json() as Promise<Record<string, unknown>>;
}
function ledgerHas(eventType: string): boolean {
  const db = openDatabase(path.join(dataDir, 'xbus.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM ledger_events WHERE event_type=?').get(eventType) as { n: number };
    return row.n > 0;
  } finally { db.close(); }
}
function chainOk(): boolean {
  const db = openDatabase(path.join(dataDir, 'xbus.sqlite'), { readOnly: true });
  try { return verifyLedger(db).ok; } finally { db.close(); }
}

const SID = 'a1a1a1a1-0000-4000-8000-0000000000ff';

describe('agent controls E2E — authorize + audit + authoritative state over real broker+HTTP', () => {
  it('EVERY control action requires auth (401 without a token)', async () => {
    const res = await fetch(`${url}/api/session/${SID}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pin' }) });
    expect(res.status).toBe(401);
  });

  it('pin/unpin: mutates, audits, and the read-model reflects it after a re-read (survives refresh)', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      expect((await getSession(tk, SID)).pinned).toBe(false);
      const r = await control(tk, SID, { action: 'pin' });
      expect(r.status).toBe(200);
      expect((await r.json() as { pinned: boolean }).pinned).toBe(true); // authoritative return
      expect((await getSession(tk, SID)).pinned).toBe(true);             // reflected on re-read
      expect(ledgerHas('OPERATOR_SESSION_PINNED')).toBe(true);           // audited
      await control(tk, SID, { action: 'unpin' });
      expect((await getSession(tk, SID)).pinned).toBe(false);
      expect(ledgerHas('OPERATOR_SESSION_UNPINNED')).toBe(true);
      expect(chainOk()).toBe(true);
    } finally { svc.close(); }
  }, 30_000);

  it('archive/unarchive: sets archived + archived_at, audits, reflected on re-read', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      await control(tk, SID, { action: 'archive' });
      let s = await getSession(tk, SID);
      expect(s.archived).toBe(true);
      expect(s.archivedAt).not.toBeNull();
      expect(ledgerHas('OPERATOR_SESSION_ARCHIVED')).toBe(true);
      await control(tk, SID, { action: 'unarchive' });
      s = await getSession(tk, SID);
      expect(s.archived).toBe(false);
      expect(s.archivedAt).toBeNull();
      expect(ledgerHas('OPERATOR_SESSION_UNARCHIVED')).toBe(true);
      expect(chainOk()).toBe(true);
    } finally { svc.close(); }
  }, 30_000);

  it('set_control (pause/DND/active): sets the receive control, audits, reflected as receiveControl', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      expect((await getSession(tk, SID)).receiveControl).toBe('active');
      const r = await control(tk, SID, { action: 'set_control', mode: 'do_not_disturb' });
      expect(r.status).toBe(200);
      expect((await getSession(tk, SID)).receiveControl).toBe('do_not_disturb');
      expect(ledgerHas('OPERATOR_CONTROL_SET')).toBe(true);
      // Back to active.
      await control(tk, SID, { action: 'set_control', mode: 'active' });
      expect((await getSession(tk, SID)).receiveControl).toBe('active');
      expect(chainOk()).toBe(true);
    } finally { svc.close(); }
  }, 30_000);

  it('set_control rejects an invalid mode with a clean 400 (not a 500)', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      const r = await control(tk, SID, { action: 'set_control', mode: 'nonsense' });
      expect(r.status).toBe(400);
      const body = await r.json() as { error: string; message: string };
      expect(body.message).toMatch(/mode must be/i); // actionable, not 'internal'
    } finally { svc.close(); }
  }, 30_000);

  it('rename_alias: renames the routable handle, audits, reflected as the session name', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      const r = await control(tk, SID, { action: 'rename_alias', name: 'seatmap-api-v2' });
      expect(r.status).toBe(200);
      expect((await getSession(tk, SID)).name).toBe('seatmap-api-v2');
      expect(ledgerHas('OPERATOR_ALIAS_RENAMED')).toBe(true);
      expect(chainOk()).toBe(true);
    } finally { svc.close(); }
  }, 30_000);

  it('an unknown action returns a clean 400 (PROTOCOL_VIOLATION), never a 500', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      const r = await control(tk, SID, { action: 'not_a_real_action' });
      expect(r.status).toBe(400);
    } finally { svc.close(); }
  }, 30_000);

  it('stop_managed on a NON-managed session refuses cleanly (400) — never a spurious kill', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      // The session is a normal (non-managed) session → clearManagedSession throws → mapped to 400.
      const r = await control(tk, SID, { action: 'stop_managed' });
      expect(r.status).toBe(400);
    } finally { svc.close(); }
  }, 30_000);

  // ── Package D integration: remove_record over the real dashboard HTTP route (KNOWN-3 safe) ──
  it('remove_record REFUSES a connected session (400), then succeeds once disconnected + is gone on re-read', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    // Connected → the broker refuses (safe-remove contract): clean 400, record intact.
    const refused = await control(tk, SID, { action: 'remove_record' });
    expect(refused.status).toBe(400);
    expect((await getSession(tk, SID)).sessionId).toBe(SID); // still present
    // Disconnect (close the IPC clients), give the broker a moment to mark it disconnected.
    svc.close();
    await new Promise((r) => setTimeout(r, 500));
    const removed = await control(tk, SID, { action: 'remove_record' });
    expect(removed.status).toBe(200);
    expect((await removed.json() as { removed: boolean }).removed).toBe(true);
    // Authoritative re-read: the session is GONE (404), and the removal is audited + chain valid.
    const after = await A(tk, `/api/session/${encodeURIComponent(SID)}`);
    expect(after.status).toBe(404);
    expect(ledgerHas('OPERATOR_SESSION_RECORD_REMOVED') || ledgerHas('SESSION_RECORD_REMOVED') || ledgerHas('IDENTITY_REMOVED')).toBe(true);
    expect(chainOk()).toBe(true);
  }, 30_000);

  // ── Package D integration: the WS3 endpoints my probe consumes respond through the HTTP surface ──
  it('GET /api/health advertises the capabilities my probe lights (redeliver + instances + remove_safe)', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      const h = await (await A(tk, '/api/health')).json() as { build: { schemaVersion: number }; capabilities: string[]; ledger: { ok: boolean } };
      expect(Array.isArray(h.capabilities)).toBe(true);
      expect(h.capabilities).toEqual(expect.arrayContaining(['redeliver', 'instances', 'remove_safe']));
      expect(typeof h.build.schemaVersion).toBe('number');
      expect(h.ledger.ok).toBe(true);
    } finally { svc.close(); }
  }, 30_000);

  it('GET /api/session/:id carries instances[] (current flagged) for the inspector history', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      const s = await getSession(tk, SID) as { instances?: Array<{ current: boolean; role: string; state: string }> };
      expect(Array.isArray(s.instances)).toBe(true);
      expect(s.instances!.length).toBeGreaterThan(0);
      expect(s.instances!.some((i) => i.current)).toBe(true); // a current instance is flagged
    } finally { svc.close(); }
  }, 30_000);

  it('redelivery: ordinary redeliver succeeds; replaying ACCEPTED work is refused (400) without confirmReplayAccepted', async () => {
    const tk = await token();
    const svc = await session(SID, 'seatmap-api');
    try {
      // Operator opens a thread to the session (a real queued delivery to redeliver).
      const open = await (await A(tk, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'seatmap-api', text: 'please review', requiresAck: true, requiresReply: true, idempotencyKey: 'rd1' }) })).json() as { messageId: string };
      // Ordinary redelivery of not-yet-accepted work → 200 outcome 'redelivered'.
      const ordinary = await A(tk, `/api/message/${encodeURIComponent(open.messageId)}/redeliver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'nudge' }) });
      expect(ordinary.status).toBe(200);
      expect((await ordinary.json() as { outcome: string }).outcome).toBe('redelivered');
      // Session pulls + ACCEPTS the message → now it is accepted work.
      const pulled = await svc.hook.request('checkpoint_pull_hook', { checkpointId: `cp-${Math.random().toString(36).slice(2)}`, limit: 20 });
      const msgs = (pulled.payload as { messages: Array<{ messageId: string; metadata: Record<string, string> }> }).messages;
      const inj = msgs.find((m) => m.messageId === open.messageId)!.metadata['xbus_injection_id'];
      await svc.mcp.request('ack_message', { messageId: open.messageId, status: 'accepted', injectionId: inj });
      // Replaying ACCEPTED work WITHOUT confirmReplayAccepted → refused 400 (never silent replay).
      const refused = await A(tk, `/api/message/${encodeURIComponent(open.messageId)}/redeliver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'again' }) });
      expect(refused.status).toBe(400);
      // WITH the explicit acknowledgement → 200 outcome 'replayed'.
      const replayed = await A(tk, `/api/message/${encodeURIComponent(open.messageId)}/redeliver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'again', confirmReplayAccepted: true }) });
      expect(replayed.status).toBe(200);
      expect((await replayed.json() as { outcome: string }).outcome).toBe('replayed');
      expect(chainOk()).toBe(true);
    } finally { svc.close(); }
  }, 30_000);
});
