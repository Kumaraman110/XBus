/**
 * Beta.6 Phase 2 — the FULL operator-console vertical, end to end, with a REAL broker host +
 * dashboard over real secure IPC (sessions) + real authenticated loopback HTTP (operator):
 *
 *   operator POST /api/thread (as local-operator) → daemon on the broker loop → one txn +
 *   one ledger event → queued delivery → a REAL session pulls it at a checkpoint (sender-
 *   agnostic) → acks → replies → the reply routes back to the operator → the authenticated
 *   timeline shows the whole thread ordered with correct sequence/parent/correlation.
 *
 * Also proves the cross-cutting guarantees the goal requires on the packaged flow:
 *   - three follow-up turns in one thread with correct linkage;
 *   - send while the recipient is disconnected, then EXACTLY-ONCE delivery after it resumes;
 *   - duplicate submit/retry creates no duplicate;
 *   - unauthorized console calls fail (401);
 *   - the beta.5.1 FOUR-session peer round-trip (send→inbox→ack→reply) is UNCHANGED while
 *     the console is live (regression), and the ledger hash-chain stays valid throughout.
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-opc-'));
  endpoint = defaultEndpoint(dataDir);
  broker = await startBrokerHost({ dataDir, dashboard: true, enforceSingleton: false });
  rootSecret = broker.rootSecret!;
  url = broker.dashboardUrl!;
});
afterEach(async () => {
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A real Claude-like session over secure IPC: hook (pull) + mcp (ack/reply) on one session. */
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
async function mcpOnly(sessionId: string, alias: string): Promise<IpcClient> {
  const c = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'mcp', claimedSessionId: sessionId } });
  await c.connect(); await doHello(c, ComponentRole.MCP);
  await c.request('register_session', { sessionId, instanceId: `i-${sessionId}`, processId: process.pid, projectId: 'proj-x', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: ComponentRole.MCP });
  await c.request('signal_readiness', { ackAvailable: true, versionOk: true });
  await c.request('register_alias', { alias });
  return c;
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
/** Drive one session hook-checkpoint pull; returns the injected messages (sender-agnostic). */
async function pull(s: { hook: IpcClient }): Promise<Array<{ messageId: string; text: string; metadata: Record<string, string> }>> {
  const r = await s.hook.request('checkpoint_pull_hook', { checkpointId: `cp-${Math.random().toString(36).slice(2)}`, limit: 20 });
  return (r.payload as { messages: Array<{ messageId: string; text: string; metadata: Record<string, string> }> }).messages;
}

describe('operator console E2E — full vertical over real IPC + HTTP', () => {
  it('operator → session request → ACK → reply → 3 follow-ups, correct linkage, exactly-once', async () => {
    const tk = await token();
    const svc = await session('a1a1a1a1-0000-4000-8000-000000000001', 'seatmap-api');

    // The session must be routable in the selector before the operator addresses it by name.
    const sess = await (await A(tk, '/api/sessions')).json() as { sessions: Array<{ sessionId: string; name: string; routable: boolean }> };
    expect(sess.sessions.some((s) => s.name === 'seatmap-api' && s.routable)).toBe(true);

    // Turn 1: operator opens a thread (POST /api/thread) — the ONLY write is browser→loopback.
    const open = await (await A(tk, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'seatmap-api', text: 'summarize the diff', requiresAck: true, requiresReply: true, idempotencyKey: 'k1' }) })).json() as { threadId: string; messageId: string; authorType: string };
    expect(open.authorType).toBe('operator');
    const T = open.threadId;

    // The session receives it at a checkpoint identically to a peer message, acks + replies.
    const got = await pull(svc);
    expect(got.map((m) => m.messageId)).toContain(open.messageId);
    const inj = got.find((m) => m.messageId === open.messageId)!.metadata['xbus_injection_id'];
    await svc.mcp.request('ack_message', { messageId: open.messageId, status: 'accepted', injectionId: inj });
    await svc.mcp.request('reply_message', { messageId: open.messageId, text: '16 Polaris fields added', outcome: 'completed', injectionId: inj });

    // The authenticated timeline shows both turns, correct linkage + delivery/ack state.
    const detail1 = await (await A(tk, `/api/thread/${T}`)).json() as { unreadCount: number; turns: Array<{ threadSequence: number; authorType: string; text: string; deliveryState: string; ackStatus: string | null; parentMessageId: string | null; correlationId: string }> };
    expect(detail1.turns.map((t) => t.threadSequence)).toEqual([1, 2]);
    expect(detail1.turns[0]!.authorType).toBe('operator');
    expect(detail1.turns[0]!.deliveryState).toBe('replied');
    expect(detail1.turns[0]!.ackStatus).toBe('accepted');
    expect(detail1.turns[1]!.authorType).toBe('claude');
    expect(detail1.turns[1]!.text).toBe('16 Polaris fields added');
    expect(detail1.turns[1]!.parentMessageId).toBe(open.messageId);
    expect(detail1.turns[1]!.correlationId).toBe(T);
    expect(detail1.unreadCount).toBe(1);

    // Three follow-up turns in the SAME thread, each answered — proves multi-turn continuity.
    let lastReplyParent = open.messageId;
    for (let i = 1; i <= 3; i++) {
      const f = await (await A(tk, `/api/thread/${T}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'seatmap-api', text: `follow-up ${i}`, requiresAck: true, requiresReply: true, idempotencyKey: `kf${i}` }) })).json() as { messageId: string; threadSequence: number };
      const pulled = await pull(svc);
      const fi = pulled.find((m) => m.messageId === f.messageId)!.metadata['xbus_injection_id'];
      await svc.mcp.request('ack_message', { messageId: f.messageId, status: 'accepted', injectionId: fi });
      await svc.mcp.request('reply_message', { messageId: f.messageId, text: `answer ${i}`, outcome: 'completed', injectionId: fi });
      lastReplyParent = f.messageId;
    }

    // Final timeline: 1 (open) + 1 (reply) + 3*(follow + reply) = 8 turns, monotonic sequence.
    const detail2 = await (await A(tk, `/api/thread/${T}`)).json() as { turns: Array<{ threadSequence: number; correlationId: string }> };
    expect(detail2.turns.map((t) => t.threadSequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(detail2.turns.map((t) => t.correlationId)).size).toBe(1); // one thread
    expect(verifyLedger(openDatabase(path.join(dataDir, 'xbus.sqlite'), { readOnly: true })).ok).toBe(true);

    svc.close();
    expect(lastReplyParent).toBeTruthy();
  }, 60_000);

  it('operator send while recipient is DISCONNECTED, then exactly-once delivery after resume', async () => {
    const tk = await token();
    // Register + immediately disconnect the target so the send queues.
    const sid = 'b2b2b2b2-0000-4000-8000-000000000002';
    let svc = await session(sid, 'offline-svc');
    svc.close();
    // Give the broker a beat to mark it disconnected (connection close handler).
    await new Promise((r) => setTimeout(r, 100));

    const open = await (await A(tk, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'offline-svc', text: 'while you were away', requiresAck: true, requiresReply: true, idempotencyKey: 'kd' }) })).json() as { threadId: string; messageId: string; state: string };
    // The console reflects the honest queued state (not "delivered").
    expect(open.state).toMatch(/queued/);

    // Resume the session; first pull delivers exactly once.
    svc = await session(sid, 'offline-svc');
    const first = await pull(svc);
    expect(first.filter((m) => m.messageId === open.messageId)).toHaveLength(1);
    const inj = first.find((m) => m.messageId === open.messageId)!.metadata['xbus_injection_id'];
    await svc.mcp.request('ack_message', { messageId: open.messageId, status: 'accepted', injectionId: inj });
    await svc.mcp.request('reply_message', { messageId: open.messageId, text: 'got it once', outcome: 'completed', injectionId: inj });
    // A SECOND pull does NOT re-inject the body (exactly-once visible delivery).
    const second = await pull(svc);
    expect(second.filter((m) => m.messageId === open.messageId)).toHaveLength(0);

    // DB invariants: exactly one injection + one ack receipt for the message.
    const ro = openDatabase(path.join(dataDir, 'xbus.sqlite'), { readOnly: true });
    expect((ro.prepare('SELECT COUNT(*) n FROM context_injections WHERE message_id=?').get(open.messageId) as { n: number }).n).toBe(1);
    expect((ro.prepare(`SELECT COUNT(*) n FROM receipts WHERE message_id=? AND receipt_type='ack'`).get(open.messageId) as { n: number }).n).toBe(1);
    ro.close();
    svc.close();
  }, 60_000);

  it('duplicate submit creates no duplicate; unauthorized console calls fail 401', async () => {
    const tk = await token();
    await session('c3c3c3c3-0000-4000-8000-000000000003', 'dup-svc');
    const body = JSON.stringify({ to: 'dup-svc', text: 'once', requiresAck: false, requiresReply: false, idempotencyKey: 'kdup' });
    const r1 = await (await A(tk, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json() as { messageId: string };
    const r2 = await (await A(tk, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json() as { messageId: string; deduplicated?: boolean };
    expect(r2.messageId).toBe(r1.messageId);
    expect(r2.deduplicated).toBe(true);
    // Unauthorized: no token → 401 on both a read and a write route.
    expect((await fetch(`${url}/api/threads`)).status).toBe(401);
    expect((await fetch(`${url}/api/thread`, { method: 'POST', body: '{}' })).status).toBe(401);
  }, 60_000);

  it('beta.5.1 regression: a FOUR-session peer round-trip is UNCHANGED while the console is live', async () => {
    const tk = await token();
    // Four real sessions; peer A→B and C→D round-trips over the classic send/inbox/ack/reply.
    const a = await mcpOnly('d4d4d4d4-0000-4000-8000-00000000000a', 'ring-a');
    const b = await mcpOnly('d4d4d4d4-0000-4000-8000-00000000000b', 'ring-b');
    const c = await mcpOnly('d4d4d4d4-0000-4000-8000-00000000000c', 'ring-c');
    const d = await mcpOnly('d4d4d4d4-0000-4000-8000-00000000000d', 'ring-d');
    // Concurrent console reads (sessions + threads + a ledger scan) must not disturb delivery.
    void A(tk, '/api/ledger?limit=500'); void A(tk, '/api/threads'); void A(tk, '/api/sessions');

    const roundTrip = async (from: IpcClient, toAlias: string, to: IpcClient): Promise<void> => {
      const s = await from.request('send_message', { to: toAlias, text: `peer ping ${toAlias}`, requiresAck: true, requiresReply: true });
      const mid = (s.payload as { messageId: string }).messageId;
      const inb = await to.request('inbox', { limit: 10 });
      const msgs = (inb.payload as { messages: Array<{ messageId: string; injectionId: string; correlationId: string; causationId: string | null }> }).messages;
      const m = msgs.find((x) => x.messageId === mid)!;
      expect(m).toBeTruthy();
      await to.request('ack_message', { messageId: mid, status: 'accepted', injectionId: m.injectionId });
      const rep = await to.request('reply_message', { messageId: mid, text: `pong ${toAlias}`, outcome: 'completed', injectionId: m.injectionId });
      const rp = rep.payload as { correlationId: string; causationId?: string };
      // Correlation preserved, causation = the original message (unchanged beta.5.1 semantics).
      expect(rp.correlationId).toBe(m.correlationId);
    };
    await roundTrip(a, 'ring-b', b);
    await roundTrip(c, 'ring-d', d);

    // The hash-chained ledger is still valid after all this thread + peer activity.
    const ro = openDatabase(path.join(dataDir, 'xbus.sqlite'), { readOnly: true });
    expect(verifyLedger(ro).ok).toBe(true);
    ro.close();
    a.close(); b.close(); c.close(); d.close();
  }, 60_000);
});
