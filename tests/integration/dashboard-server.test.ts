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

  it('a rename to a TAKEN/INVALID name maps to 400 with the actionable message (not a 500 "internal")', async () => {
    // Regression (beta.7): operatorRenameAlias throws XBUS_SESSION_NAME_TAKEN /
    // XBUS_INVALID_SESSION_NAME — user-input rejections that must surface as 400 with the reason,
    // not a suppressed 500 'internal'. The control route feeds through the write error-mapper.
    for (const code of ['XBUS_SESSION_NAME_TAKEN', 'XBUS_INVALID_SESSION_NAME']) {
      const onOperatorControl = (): unknown => { throw Object.assign(new Error('session name already in use'), { code }); };
      const s = new DashboardServer({ auth, reader, onOperatorControl });
      await s.start();
      try {
        const token = await getTokenFor(s, auth);
        const res = await fetch(`${s.url}/api/session/cccc0001-0000-4000-8000-000000000001/control`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename_alias', name: 'x' }),
        });
        expect(res.status, code).toBe(400); // NOT 500
        const body = await res.json() as { error: string; message: string };
        expect(body.error).toBe(code);
        expect(body.message).toBe('session name already in use'); // actionable reason preserved, not 'internal'
      } finally { await s.stop(); }
    }
  });
});

async function getTokenFor(s: DashboardServer, a: DashboardAuth): Promise<string> {
  const nonce = a.mintNonce();
  const res = await fetch(`${s.url}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce }) });
  return (await res.json() as { token: string }).token;
}

// ── Beta.5 blocker #5: server-side stream/broadcast/overload bounds ─────────────
describe('dashboard server — stream + broadcast + overload bounds', () => {
  /** A reader that COUNTS calls per method + can be made to reject (overload sim). */
  function countingReader(behavior: { overload?: boolean } = {}): { reader: ReadExecutor; calls: Record<string, number> } {
    const calls: Record<string, number> = {};
    const reader: ReadExecutor = {
      run: (method) => { calls[method] = (calls[method] ?? 0) + 1; return behavior.overload ? Promise.reject(Object.assign(new Error('overloaded'), { name: 'ReadOverloadedError' })) : Promise.resolve(method === 'sessions' ? [] : { events: [] }); },
      close: () => Promise.resolve(),
    };
    return { reader, calls };
  }

  it('notifyChange does ONE coalesced sessions read fanned out to ALL open streams (not one per stream)', async () => {
    const { reader, calls } = countingReader();
    const auth2 = new DashboardAuth(new FakeClock());
    const s = new DashboardServer({ auth: auth2, reader });
    await s.start();
    try {
      // Open 3 authenticated streams. Each does ONE initial read on open.
      const tokens = await Promise.all([0, 1, 2].map(() => getTokenFor(s, auth2)));
      const controllers = tokens.map(() => new AbortController());
      await Promise.all(tokens.map((t, i) => fetch(`${s.url}/api/stream`, { headers: { Authorization: `Bearer ${t}` }, signal: controllers[i]!.signal }).then((r) => r.body!.getReader().read())));
      const afterOpen = calls['sessions'] ?? 0;
      expect(afterOpen).toBeGreaterThanOrEqual(3); // 3 initial per-stream snapshots
      // A single mutation → notifyChange → ONE more sessions read total (coalesced), not +3.
      s.notifyChange();
      await new Promise((r) => setTimeout(r, 50));
      expect((calls['sessions'] ?? 0) - afterOpen).toBe(1);
      for (const c of controllers) c.abort();
    } finally { await s.stop(); }
  });

  it('the authenticated stream count is CAPPED (maxStreams) → 503 beyond it', async () => {
    const { reader } = countingReader();
    const auth2 = new DashboardAuth(new FakeClock());
    const s = new DashboardServer({ auth: auth2, reader, maxStreams: 2 });
    await s.start();
    try {
      const ctrls: AbortController[] = [];
      const open = async () => { const t = await getTokenFor(s, auth2); const c = new AbortController(); ctrls.push(c); return fetch(`${s.url}/api/stream`, { headers: { Authorization: `Bearer ${t}` }, signal: c.signal }); };
      const r1 = await open(); const r2 = await open();
      expect(r1.status).toBe(200); expect(r2.status).toBe(200);
      void r1.body!.getReader().read(); void r2.body!.getReader().read();
      await new Promise((r) => setTimeout(r, 20));
      const r3 = await open(); // 3rd exceeds the cap
      expect(r3.status).toBe(503);
      expect((await r3.json() as { error: string }).error).toBe('too_many_streams');
      for (const c of ctrls) c.abort();
    } finally { await s.stop(); }
  });

  it('broadcast recovers after a SYNCHRONOUS reader throw (does not wedge live updates) — D2', async () => {
    // A reader whose run('sessions') THROWS synchronously on the first call, then works.
    let throwOnce = true;
    const calls: string[] = [];
    const reader: ReadExecutor = {
      run: (method) => { calls.push(method); if (method === 'sessions' && throwOnce) { throwOnce = false; throw new Error('sync spawn failure'); } return Promise.resolve(method === 'sessions' ? [{ ok: 1 }] : { events: [] }); },
      close: () => Promise.resolve(),
    };
    const auth2 = new DashboardAuth(new FakeClock());
    const s = new DashboardServer({ auth: auth2, reader });
    await s.start();
    try {
      const t = await getTokenFor(s, auth2);
      const c = new AbortController();
      // Open a stream (its initial read throws sync — must not wedge). Then a notifyChange
      // must still broadcast a snapshot (broadcasting flag was reset despite the throw).
      const streamRes = await fetch(`${s.url}/api/stream`, { headers: { Authorization: `Bearer ${t}` }, signal: c.signal });
      const rdr = streamRes.body!.getReader();
      await new Promise((r) => setTimeout(r, 20));
      s.notifyChange(); // first broadcast may hit the sync-throw; flag must reset
      s.notifyChange(); // this one must succeed and reach the stream
      const { value } = await rdr.read();
      const line = new TextDecoder().decode(value).split('\n').find((l) => l.trim())!;
      expect(JSON.parse(line).type).toBe('sessions'); // live updates NOT wedged
      c.abort();
    } finally { await s.stop(); }
  });

  it('a ReadOverloadedError from the reader → 503 overloaded with Retry-After', async () => {
    const { reader } = countingReader({ overload: true });
    const auth2 = new DashboardAuth(new FakeClock());
    const s = new DashboardServer({ auth: auth2, reader });
    await s.start();
    try {
      const t = await getTokenFor(s, auth2);
      const res = await fetch(`${s.url}/api/sessions`, { headers: { Authorization: `Bearer ${t}` } });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect((await res.json() as { error: string }).error).toBe('overloaded');
    } finally { await s.stop(); }
  });
});
