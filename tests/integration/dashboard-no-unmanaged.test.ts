/**
 * Beta.10 (Train B) — NEGATIVE test: the shipped dashboard makes NO operational claim about
 * "unmanaged" sessions (product decision: no data beats fabricated certainty).
 *
 * Asserts, over a real DashboardServer + the real packaged static assets:
 *   1. GET /api/unmanaged is NOT a supported route — authenticated, it 404s (not 200 with a
 *      hardcoded possibleUnmanaged), i.e. the endpoint is absent, not merely inert.
 *   2. The served index.html renders NO unmanaged banner element and NO wording implying AgenTel
 *      verified the absence/presence of pre-existing sessions.
 *   3. app.js issues NO request to /api/unmanaged and defines NO renderBanner/possibleUnmanaged.
 *
 * This is the guardrail that keeps the removed feature from silently returning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { FakeClock } from '../../src/shared/clock.js';
import { DashboardServer } from '../../src/broker/dashboard/server.js';
import { DashboardAuth } from '../../src/broker/dashboard/auth.js';
import { InProcessReadExecutor } from '../../src/broker/dashboard/read-worker.js';

let dir: string; let dbPath: string; let writer: SqliteDriver; let server: DashboardServer; let auth: DashboardAuth; let base: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-nounmanaged-'));
  dbPath = path.join(dir, 'x.sqlite');
  writer = openDatabase(dbPath, { applyPragmas: true });
  runMigrations(writer, new FakeClock().nowIso());
  auth = new DashboardAuth(new FakeClock());
  server = new DashboardServer({ auth, reader: new InProcessReadExecutor(dbPath) });
  await server.start();
  base = server.url;
});
afterEach(async () => { await server.stop(); try { writer.close(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

async function token(): Promise<string> {
  const nonce = auth.mintNonce();
  const res = await fetch(`${base}/auth/exchange`, { method: 'POST', body: JSON.stringify({ nonce }) });
  return (await res.json() as { token: string }).token;
}

describe('shipped dashboard does NOT expose unmanaged-session detection', () => {
  it('GET /api/unmanaged is NOT a supported route (authenticated → 404, never 200)', async () => {
    const tk = await token();
    const res = await fetch(`${base}/api/unmanaged`, { headers: { Authorization: `Bearer ${tk}` } });
    // Absent route → the /api/* fall-through 404 (auth passed, so this is a genuine "no such
    // endpoint", not a 401). It must NOT be 200 with a fabricated possibleUnmanaged payload.
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('possibleUnmanaged');
    expect(body).not.toHaveProperty('managedOrDormant');
  });

  it('the served index.html renders no unmanaged banner + no "verified absence" wording', async () => {
    const html = await (await fetch(`${base}/`)).text();
    // No banner element id and no unmanaged-claim wording.
    expect(html).not.toContain('id="banner"');
    expect(html.toLowerCase()).not.toContain('aren’t managed yet');
    expect(html.toLowerCase()).not.toContain('unmanaged yet');
    expect(html.toLowerCase()).not.toContain('started before');
  });

  it('app.js makes no /api/unmanaged request and defines no banner renderer', async () => {
    const js = await (await fetch(`${base}/app.js`)).text();
    expect(js).not.toContain('/api/unmanaged');
    expect(js).not.toContain('renderBanner');
    expect(js).not.toContain('possibleUnmanaged');
  });
});
