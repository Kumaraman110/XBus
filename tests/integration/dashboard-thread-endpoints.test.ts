/**
 * Beta.6 Phase 2 (ADR 0021): the operator communication-console API on the read-only
 * dashboard server. Proves — over real node:http on loopback with a real read-only SQLite
 * handle + the real broker writer on this thread — that:
 *   - every new /api/thread* route (reads AND writes) requires a valid bearer token → 401;
 *   - the write routes run through the broker-loop callback (the dashboard handle is
 *     read-only), open/continue a thread as the reserved 'local-operator', and are
 *     idempotent (a retried submit with the same key makes no duplicate);
 *   - GET thread projections return the ordered timeline with body + delivery/ack state;
 *   - unread is derived and mark-read advances it;
 *   - request-body limits (413), bad JSON (400), unknown paths (404), and a missing write
 *     callback (503) all behave; and the browser can never spoof a sender/actor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { ensureOperatorSession, OPERATOR_SESSION_ID } from '../../src/broker/operator.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { DashboardServer } from '../../src/broker/dashboard/server.js';
import { DashboardAuth } from '../../src/broker/dashboard/auth.js';
import { InProcessReadExecutor, type ReadExecutor } from '../../src/broker/dashboard/read-worker.js';
import { validateSendInput } from '../../src/protocol/schemas.js';

let dir: string; let dbPath: string; let writer: SqliteDriver; let clock: FakeClock; let ids: SeqIdGen;
let store: BrokerStore; let delivery: DeliveryOps;
let auth: DashboardAuth; let reader: ReadExecutor; let server: DashboardServer; let base: string;
const S = 'ssss7777-0000-4000-8000-00000000000d';

/** Minimal broker-loop write callbacks mirroring daemon.operatorSend/operatorMarkThreadRead:
 *  they run the transactional store op on THIS (writer) thread and validate the send surface. */
function operatorSendCb(payload: unknown): unknown {
  const p = (payload ?? {}) as Record<string, unknown>;
  // Mirror daemon.operatorSend: run the SAME trust-boundary validator peers use
  // (reserved-metadata + size + kind + prototype-pollution defenses) on the send surface.
  const input = validateSendInput({
    to: p.to, text: p.text,
    ...(p.kind !== undefined ? { kind: p.kind } : {}),
    ...(p.requiresAck !== undefined ? { requiresAck: p.requiresAck } : {}),
    ...(p.requiresReply !== undefined ? { requiresReply: p.requiresReply } : {}),
    ...(p.ttlSeconds !== undefined ? { ttlSeconds: p.ttlSeconds } : {}),
    ...(p.idempotencyKey !== undefined ? { idempotencyKey: p.idempotencyKey } : {}),
    ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
  });
  return store.operatorSend({
    ...input,
    ...(typeof p.threadId === 'string' ? { threadId: p.threadId } : {}),
    ...(typeof p.parentMessageId === 'string' ? { parentMessageId: p.parentMessageId } : {}),
    ...(typeof p.subject === 'string' ? { subject: p.subject } : {}),
  });
}
function markReadCb(payload: unknown): unknown {
  const p = (payload ?? {}) as Record<string, unknown>;
  return store.markThreadRead(String(p.threadId), Number(p.upToSequence));
}

async function bootServer(opts: { withWrite?: boolean } = {}): Promise<void> {
  auth = new DashboardAuth(clock);
  reader = new InProcessReadExecutor(dbPath);
  server = new DashboardServer({
    auth, reader,
    ...(opts.withWrite === false ? {} : { onOperatorSend: operatorSendCb, onMarkThreadRead: markReadCb }),
  });
  await server.start();
  base = server.url;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-dashthread-'));
  dbPath = path.join(dir, 'x.sqlite');
  writer = openDatabase(dbPath, { applyPragmas: true });
  clock = new FakeClock();
  ids = new SeqIdGen('h');
  runMigrations(writer, clock.nowIso());
  ensureOperatorSession(writer, clock);
  store = new BrokerStore(writer, clock, ids, 'b');
  delivery = new DeliveryOps(writer, clock, ids, 5 * 60_000);
  // A routable target session for the operator to message.
  const authS = store.register({ sessionId: S, instanceId: 'iS', connectionId: 'cS', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'target-svc' }) as SessionAuthority;
  store.signalReadiness(authS, { ackAvailable: true, hookAvailable: true, versionOk: true });
  await bootServer();
});
afterEach(async () => {
  await server.stop();
  try { writer.close(); } catch { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

async function getToken(): Promise<string> {
  const nonce = auth.mintNonce();
  const res = await fetch(`${base}/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
  return (await res.json() as { token: string }).token;
}
function authFetch(token: string, p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${p}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
}
function hookAuth(sessionId: string): SessionAuthority {
  const s = writer.prepare('SELECT active_epoch, fencing_token FROM sessions WHERE session_id=?').get(sessionId) as { active_epoch: number; fencing_token: number };
  return { sessionId, instanceId: `hook-${sessionId.slice(0, 8)}`, componentInstanceId: `hook-${sessionId.slice(0, 8)}`, role: 'hook' as never, epoch: s.active_epoch, generation: s.active_epoch, fencingToken: s.fencing_token, connectionId: 'cp' };
}
function mcpAuth(sessionId: string): SessionAuthority {
  const s = writer.prepare('SELECT active_epoch, fencing_token FROM sessions WHERE session_id=?').get(sessionId) as { active_epoch: number; fencing_token: number };
  return { sessionId, instanceId: 'iS', componentInstanceId: 'iS', role: 'mcp' as never, epoch: s.active_epoch, generation: s.active_epoch, fencingToken: s.fencing_token, connectionId: 'cS' };
}
function allocSeq(recipientSessionId: string): number {
  const row = writer.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(recipientSessionId) as { next_sequence: number } | undefined;
  const seq = row ? row.next_sequence : 1;
  writer.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(recipientSessionId, seq + 1);
  return seq;
}

describe('operator console API — auth on every thread route', () => {
  it('every /api/thread* route (read + write) requires a valid bearer token → 401', async () => {
    for (const [method, p] of [['GET', '/api/threads'], ['GET', '/api/thread/abc'], ['POST', '/api/thread'], ['POST', '/api/thread/abc/send'], ['POST', '/api/thread/abc/read']] as const) {
      const res = await fetch(`${base}${p}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(res.status, `${method} ${p}`).toBe(401);
    }
  });

  it('a garbage token is rejected 401 on a write route', async () => {
    const res = await fetch(`${base}/api/thread`, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('operator console API — open / continue / read a thread', () => {
  it('POST /api/thread opens a thread as local-operator; GET returns the ordered timeline with body', async () => {
    const token = await getToken();
    const open = await authFetch(token, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'target-svc', text: 'summarize the diff', requiresAck: true, requiresReply: true, subject: 'review' }) });
    expect(open.status).toBe(200);
    const opened = await open.json() as { threadId: string; messageId: string; authorType: string; threadSequence: number; state: string };
    expect(opened.authorType).toBe('operator');
    expect(opened.threadSequence).toBe(1);
    expect(opened.state).toMatch(/queued/); // recipient hasn't pulled yet

    // The thread appears in the list, addressed to the peer.
    const list = await (await authFetch(token, '/api/threads')).json() as { threads: Array<{ threadId: string; peerName: string; unreadCount: number; subject: string | null }> };
    const summary = list.threads.find((t) => t.threadId === opened.threadId)!;
    expect(summary).toBeDefined();
    expect(summary.peerName).toBe('target-svc');
    expect(summary.subject).toBe('review');
    expect(summary.unreadCount).toBe(0); // operator's own turn is not unread to itself

    // GET the timeline — one turn, body included, author operator, delivery queued.
    const detail = await (await authFetch(token, `/api/thread/${opened.threadId}`)).json() as { turns: Array<{ messageId: string; authorType: string; text: string; deliveryState: string; senderName: string }> };
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]!.authorType).toBe('operator');
    expect(detail.turns[0]!.text).toBe('summarize the diff');
    expect(detail.turns[0]!.senderName).toBe('local-operator');
    expect(detail.turns[0]!.deliveryState).toBe('queued');
  });

  it('full round-trip: operator opens → session acks+replies → timeline shows reply → operator follow-up', async () => {
    const token = await getToken();
    const opened = await (await authFetch(token, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'target-svc', text: 'q1', requiresAck: true, requiresReply: true }) })).json() as { threadId: string; messageId: string };

    // The session pulls at a checkpoint (sender-agnostic), acks, replies — the SAME lifecycle.
    const pulled = delivery.checkpointPull(hookAuth(S), 'cp1', 10);
    const inj = pulled.find((m) => m.messageId === opened.messageId)!.metadata!['xbus_injection_id'];
    delivery.ack(mcpAuth(S), { messageId: opened.messageId, status: 'accepted', injectionId: inj });
    delivery.reply(mcpAuth(S), { messageId: opened.messageId, text: 'a1', outcome: 'completed', injectionId: inj }, allocSeq);

    // Timeline now has 2 turns; the operator's turn shows replied, the reply is from the session.
    const detail = await (await authFetch(token, `/api/thread/${opened.threadId}`)).json() as { unreadCount: number; turns: Array<{ threadSequence: number; authorType: string; text: string; deliveryState: string; ackStatus: string | null; parentMessageId: string | null }> };
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0]!.authorType).toBe('operator');
    expect(detail.turns[0]!.ackStatus).toBe('accepted');
    expect(detail.turns[0]!.deliveryState).toBe('replied');
    expect(detail.turns[1]!.authorType).toBe('claude');
    expect(detail.turns[1]!.text).toBe('a1');
    expect(detail.turns[1]!.parentMessageId).toBe(opened.messageId);
    expect(detail.unreadCount).toBe(1); // the session's reply is unread to the operator

    // Mark read up to seq 2 → unread clears.
    const mr = await authFetch(token, `/api/thread/${opened.threadId}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upToSequence: 2 }) });
    expect(mr.status).toBe(200);
    const after = await (await authFetch(token, `/api/thread/${opened.threadId}`)).json() as { unreadCount: number };
    expect(after.unreadCount).toBe(0);

    // Operator follow-up on the SAME thread (path carries the thread id).
    const follow = await authFetch(token, `/api/thread/${opened.threadId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'target-svc', text: 'q2', requiresAck: true, requiresReply: true }) });
    expect(follow.status).toBe(200);
    const f = await follow.json() as { threadId: string; threadSequence: number; authorType: string };
    expect(f.threadId).toBe(opened.threadId);
    expect(f.threadSequence).toBe(3);
    expect(f.authorType).toBe('operator');
  });

  it('duplicate submit with the same idempotency key creates NO duplicate turn', async () => {
    const token = await getToken();
    const body = JSON.stringify({ to: 'target-svc', text: 'once', requiresAck: false, requiresReply: false, idempotencyKey: 'k-dup-1' });
    const first = await (await authFetch(token, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json() as { messageId: string; threadId: string; deduplicated?: boolean };
    const second = await (await authFetch(token, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json() as { messageId: string; deduplicated?: boolean };
    expect(second.messageId).toBe(first.messageId);
    expect(second.deduplicated).toBe(true);
    const n = (writer.prepare('SELECT COUNT(*) n FROM messages WHERE sender_session_id=? AND idempotency_key=?').get(OPERATOR_SESSION_ID, 'k-dup-1') as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe('operator console API — limits, methods, and write isolation', () => {
  it('an oversized request body → 413; malformed JSON → 400; unknown POST path → 404', async () => {
    const token = await getToken();
    const huge = 'x'.repeat(200 * 1024);
    const big = await authFetch(token, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'target-svc', text: huge }) });
    expect(big.status).toBe(413);
    const bad = await authFetch(token, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    const unknown = await authFetch(token, '/api/thread/abc/frobnicate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(unknown.status).toBe(404);
  });

  it('a reserved-metadata key in an operator send is rejected (permission-relay defense)', async () => {
    const token = await getToken();
    const res = await authFetch(token, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'target-svc', text: 'x', metadata: { role: 'admin' } }) });
    // daemon.operatorSend → validateSendInput throws RESERVED_METADATA_KEY → mapped 400.
    expect(res.status).toBe(400);
  });

  it('with NO write callback wired, write routes 503 but reads still work (dashboard-failure isolation)', async () => {
    await server.stop();
    await bootServer({ withWrite: false });
    const token = await getToken();
    const w = await authFetch(token, '/api/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'target-svc', text: 'x' }) });
    expect(w.status).toBe(503);
    const r = await authFetch(token, '/api/threads');
    expect(r.status).toBe(200);
  });

  it('a GET on a write-only shape and a PUT/DELETE on a data route are rejected', async () => {
    const token = await getToken();
    // /api/thread has no GET (only /api/threads list + /api/thread/:id detail) → 404.
    expect((await authFetch(token, '/api/thread')).status).toBe(404);
    for (const method of ['PUT', 'DELETE', 'PATCH'] as const) {
      const res = await authFetch(token, '/api/threads', { method });
      expect([405, 404], `${method} /api/threads`).toContain(res.status);
    }
  });
});
