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
    expect(html).toContain('AgenTel'); // beta.8 rebrand (was 'XBus')
    expect(html).toContain('/app.js');   // loads the external script (script-src 'self')
    expect(html).toContain('/style.css'); // external stylesheet (style-src 'self')
  });

  it('beta.7: delivery renders as FIVE separate columns, never the combined q/d/ack/reply/fail string', async () => {
    const html = await (await fetch(`${base}/`)).text();
    // The five separate column headers are present, in order.
    for (const h of ['Queued', 'Delivered', 'ACK', 'Replied', 'Failed']) {
      expect(html, `missing delivery column header ${h}`).toContain(`>${h}<`);
    }
    // The old combined header/string must be GONE from both the markup and the client.
    expect(html).not.toContain('q/d/ack/reply/fail');
    expect(html).not.toContain('Delivery (');
    const js = await (await fetch(`${base}/app.js`)).text();
    expect(js).not.toMatch(/\$\{d\.queued\}\/\$\{d\.delivered\}/); // no combined template literal
  });

  it('beta.7: an "Internal sessions" filter + friendly statuses are present (inert markup + client)', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('Internal sessions');
    expect(html).toContain('show-internal');
    const js = await (await fetch(`${base}/app.js`)).text();
    // Friendly, human status wording (not raw labels) — the specific queued-case copy.
    expect(js).toContain('Waiting for recipient checkpoint');
    // The internal filter is client-enforced (hide by default) + reads the read-model flag.
    expect(js).toContain('isInternal');
    expect(js).toMatch(/show-internal/);
  });

  it('index.html has NO inline EXECUTABLE <script> or on* handlers (strict CSP compliance)', async () => {
    const html = await (await fetch(`${base}/`)).text();
    // No inline EXECUTABLE script bodies: every executable <script> must be a src= include with no
    // inline content. A `type="importmap"` block is a DATA tag (module specifier map), not executable
    // JS — it is explicitly permitted under `script-src 'self'` WITHOUT 'unsafe-inline' (BETA.11: the
    // vendored three.js needs it to resolve OrbitControls' bare `three` import), so it is exempt.
    const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    for (const tag of scriptTags) {
      const openTag = (tag.match(/<script\b[^>]*>/i) ?? [''])[0];
      const isImportmap = /type\s*=\s*["']importmap["']/i.test(openTag);
      if (isImportmap) {
        // Must be valid JSON (data), never contain executable constructs.
        const body = tag.replace(/<script\b[^>]*>/i, '').replace(/<\/script>/i, '').trim();
        expect(() => JSON.parse(body), 'importmap must be pure JSON data').not.toThrow();
        continue;
      }
      const inner = tag.replace(/<script\b[^>]*>/i, '').replace(/<\/script>/i, '').trim();
      expect(inner, 'inline executable script body present').toBe('');
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
