/**
 * Dashboard vanilla UI (beta.5 Phase 1). The UI is a pure CLIENT of the tested API; these
 * tests assert the served assets are INERT (no secrets, no session data, no inline
 * scripts/styles that would violate the strict CSP), that they load unauthenticated, and
 * that the app.js implements the documented auth-flow contract (fragment nonce → strip →
 * exchange → sessionStorage token → Authorization header; never localStorage/cookie/URL).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { FakeClock } from '../../src/shared/clock.js';
import { DashboardServer, defaultStaticDir } from '../../src/broker/dashboard/server.js';
import { DashboardAuth } from '../../src/broker/dashboard/auth.js';
import { InProcessReadExecutor } from '../../src/broker/dashboard/read-worker.js';

let dir: string; let dbPath: string; let writer: SqliteDriver; let server: DashboardServer; let base: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ui-'));
  dbPath = path.join(dir, 'x.sqlite');
  writer = openDatabase(dbPath, { applyPragmas: true });
  runMigrations(writer, new FakeClock().nowIso());
  server = new DashboardServer({ auth: new DashboardAuth(new FakeClock()), reader: new InProcessReadExecutor(dbPath) });
  await server.start();
  base = server.url;
});
afterEach(async () => { await server.stop(); try { writer.close(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

describe('dashboard UI — inert client assets', () => {
  it('the packaged static dir resolves + serves the real index.html unauthenticated', async () => {
    expect(defaultStaticDir()).toBeTruthy(); // built into dist by copy-static
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('XBus');
    expect(html).toContain('/app.js');   // loads the external script (script-src 'self')
    expect(html).toContain('/style.css'); // external stylesheet (style-src 'self')
  });

  it('index.html has NO inline <script> or on* handlers (strict CSP compliance)', async () => {
    const html = await (await fetch(`${base}/`)).text();
    // No inline script bodies: every <script> must be a src= include with no inline content.
    const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    for (const tag of scriptTags) {
      const inner = tag.replace(/<script\b[^>]*>/i, '').replace(/<\/script>/i, '').trim();
      expect(inner, 'inline script body present').toBe('');
    }
    expect(/\son\w+\s*=/.test(html), 'inline on* handler present').toBe(false);
  });

  it('app.js is served + contains no baked-in secret/session data', async () => {
    const res = await fetch(`${base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    const js = await res.text();
    // Implements the documented auth flow …
    expect(js).toContain('/auth/exchange');
    expect(js).toContain('sessionStorage');
    expect(js).toContain('Authorization');
    expect(js).toContain('history.replaceState'); // strips the nonce fragment
    // … and does NOT use the forbidden storage/transport for the token.
    expect(js).not.toContain('localStorage');
    expect(js).not.toMatch(/document\.cookie/);
    expect(js).not.toContain('EventSource'); // uses fetch-streaming (header auth)
  });

  it('beta.6: the console markup is present + inert (no inline JS, no baked session data)', async () => {
    const html = await (await fetch(`${base}/`)).text();
    // The communication console shell is served (selector, thread list, timeline, composer).
    expect(html).toContain('communication console');
    expect(html).toContain('session-select');
    expect(html).toContain('thread-list');
    expect(html).toContain('timeline');
    expect(html).toContain('composer');
    // Still no inline handlers anywhere in the enlarged markup.
    expect(/\son\w+\s*=/.test(html), 'inline on* handler present').toBe(false);
    // The inert HTML bakes in NO thread/session ids or operator secrets.
    expect(html).not.toMatch(/local-operator['"]/); // no hardcoded operator identity value
  });

  it('beta.6: app.js drives the console write API + stamps NO client-side sender/actor', async () => {
    const js = await (await fetch(`${base}/app.js`)).text();
    // Uses the authenticated write routes …
    expect(js).toContain('/api/thread');
    expect(js).toContain('/api/threads');
    expect(js).toContain('idempotencyKey'); // safe retry / no-duplicate submit
    // … and NEVER sets a sender/actor/author (identity is broker-stamped, ADR 0021).
    expect(js).not.toMatch(/author_type|sender_session_id|["']actor["']\s*:/);
    // Still fetch-streaming (header auth), never EventSource.
    expect(js).not.toContain('EventSource');
  });

  it('static assets still carry the strict CSP + hardening headers', async () => {
    const res = await fetch(`${base}/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('path traversal on static serving is blocked', async () => {
    // Encoded traversal should not escape the static root.
    const res = await fetch(`${base}/..%2f..%2f..%2fpackage.json`);
    expect([403, 404]).toContain(res.status);
  });
});
