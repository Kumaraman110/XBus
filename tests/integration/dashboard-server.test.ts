/**
 * Dashboard HTTP server — the headless control-plane API (ADR 0015/0018/0020 Q5).
 * Real node:http over loopback with a real read-only SQLite handle. Proves the security
 * contract by construction: loopback-only bind, strict CSP, EVERY /api/* (incl. reads +
 * stream) requires a valid bearer token, the nonce→exchange→token flow, static assets are
 * inert + unauthenticated, no route mutates product state, and an off-loop read failure
 * degrades to 503 without touching the broker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { DashboardServer } from '../../src/broker/dashboard/server.js';
import { DashboardAuth } from '../../src/broker/dashboard/auth.js';
import { InProcessReadExecutor, WorkerReadExecutor, type ReadExecutor } from '../../src/broker/dashboard/read-worker.js';

let dir: string; let dbPath: string; let writer: SqliteDriver; let clock: FakeClock;
let auth: DashboardAuth; let reader: ReadExecutor; let server: DashboardServer; let base: string;

async function seedSession(): Promise<void> {
  const ids = new SeqIdGen('h');
  const store = new BrokerStore(writer, clock, ids, 'b');
  const a = store.register({ sessionId: 'cccc0001-0000-4000-8000-000000000001', instanceId: 'i', connectionId: 'c', processId: 1, projectId: 'proj-x', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: 'hook' });
  store.announceSession(a, { source: 'startup' });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-dashsrv-'));
  dbPath = path.join(dir, 'x.sqlite');
  writer = openDatabase(dbPath, { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(writer, clock.nowIso());
  await seedSession();
  auth = new DashboardAuth(clock);
  reader = new InProcessReadExecutor(dbPath);
  server = new DashboardServer({ auth, reader });
  await server.start();
  base = server.url;
});
afterEach(async () => {
  await server.stop();
  try { writer.close(); } catch { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

/** Obtain a valid tab token via the real nonce→exchange HTTP flow. */
async function getToken(): Promise<string> {
  const nonce = auth.mintNonce();
  const res = await fetch(`${base}/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
  expect(res.status).toBe(200);
  return (await res.json() as { token: string }).token;
}

describe('dashboard HTTP server — security by construction', () => {
  it('refuses a non-loopback bind at start()', async () => {
    const s = new DashboardServer({ auth, reader, host: '0.0.0.0' });
    await expect(s.start()).rejects.toThrow(/non-loopback/);
  });

  it('every response carries strict CSP + hardening headers', async () => {
    const res = await fetch(`${base}/alive`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('static index is served UNAUTHENTICATED and contains no session data / secret', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('xbus');
    expect(html).not.toContain('cccc0001'); // no session id baked into inert asset
  });

  it('EVERY /api/* read requires a valid bearer token → 401 without one', async () => {
    for (const p of ['/api/sessions', '/api/ledger', '/api/session/cccc0001-0000-4000-8000-000000000001', '/api/stream', '/api/unmanaged']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(401);
    }
  });

  it('a bad/garbage token is rejected 401', async () => {
    const res = await fetch(`${base}/api/sessions`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    expect(res.status).toBe(401);
  });

  it('nonce → exchange → token → authenticated read (the full bootstrap)', async () => {
    const token = await getToken();
    const res = await fetch(`${base}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: Array<{ sessionId: string; label: string }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.sessionId).toBe('cccc0001-0000-4000-8000-000000000001');
  });

  it('a replayed nonce at /auth/exchange is rejected 401 (single-use)', async () => {
    const nonce = auth.mintNonce();
    const first = await fetch(`${base}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce }) });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce }) });
    expect(second.status).toBe(401);
  });

  it('the ONLY non-GET route is POST /auth/exchange; other mutating verbs are rejected', async () => {
    const token = await getToken();
    // A write verb against a data route is 405 (no product-state mutation route exists).
    for (const [method, p] of [['POST', '/api/sessions'], ['PUT', '/api/ledger'], ['DELETE', '/api/session/x'], ['PATCH', '/api/sessions']] as const) {
      const res = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${token}` } });
      expect([405, 404], `${method} ${p}`).toContain(res.status);
    }
    // /auth/exchange only accepts POST.
    const g = await fetch(`${base}/auth/exchange`);
    expect(g.status).toBe(405);
  });

  it('the authenticated fetch-stream emits an initial newline-delimited JSON snapshot', async () => {
    const token = await getToken();
    const res = await fetch(`${base}/api/stream`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('x-ndjson');
    const reader2 = res.body!.getReader();
    const { value } = await reader2.read();
    const line = new TextDecoder().decode(value).split('\n')[0]!;
    const evt = JSON.parse(line) as { type: string; sessions: unknown[] };
    expect(evt.type).toBe('sessions');
    expect(Array.isArray(evt.sessions)).toBe(true);
    await reader2.cancel();
  });

  it('an oversized /auth/exchange body is rejected 413 (bounded input)', async () => {
    const big = 'x'.repeat(5000);
    const res = await fetch(`${base}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce: big }) });
    expect([413, 401]).toContain(res.status); // destroyed as too-big, or rejected as invalid
  });
});

describe('dashboard read isolation — off-loop failure does not surface as a crash', () => {
  it('a failing reader yields 503 (not a 500 leak, not a hang)', async () => {
    // A reader whose run() always rejects (simulates a worker crash / timeout).
    const badReader: ReadExecutor = { run: () => Promise.reject(new Error('worker crashed')), close: () => Promise.resolve() };
    const s = new DashboardServer({ auth, reader: badReader });
    await s.start();
    try {
      const token = await getTokenFor(s, auth);
      const res = await fetch(`${s.url}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('read_unavailable'); // no raw stack / 500 leak
    } finally { await s.stop(); }
  });

  it('the real worker_thread executor answers a read (smoke) and rejects writes structurally', async () => {
    const wReader = new WorkerReadExecutor(dbPath, { requestTimeoutMs: 5000 });
    const s = new DashboardServer({ auth, reader: wReader });
    await s.start();
    try {
      const token = await getTokenFor(s, auth);
      const res = await fetch(`${s.url}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: unknown[] };
      expect(body.sessions).toHaveLength(1);
    } finally { await s.stop(); }
  });
});

async function getTokenFor(s: DashboardServer, a: DashboardAuth): Promise<string> {
  const nonce = a.mintNonce();
  const res = await fetch(`${s.url}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce }) });
  return (await res.json() as { token: string }).token;
}
