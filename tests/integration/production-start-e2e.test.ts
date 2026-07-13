/**
 * Beta.5 blocker #2: the PRODUCTION broker-start path enables the control plane. Starts the
 * broker through the EXACT installed command `node dist/cli/main.js start` (the same entry
 * ensure.ts auto-start spawns) and proves — via the state file + the authenticated dashboard
 * API — that the dashboard AND dormant import are active, with NO test-only dashboard:true.
 *
 * Requires dist/ (suite pretest builds it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { readStateFile } from '../../src/broker/state-file.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'dist', 'cli', 'main.js');
let dataDir: string; let child: ReturnType<typeof spawn> | null;

beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-prodstart-')); child = null; });
afterEach(() => {
  if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  try { execFileSync(process.execPath, [CLI, 'stop'], { env: { ...process.env, XBUS_DATA_DIR: dataDir, XBUS_ALLOW_UNSUPPORTED_NODE: '1' }, timeout: 15_000, stdio: 'ignore' }); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Wait until readStateFile reports a dashboard port, or throw after timeoutMs. */
async function waitForDashboard(timeoutMs: number): Promise<{ port: number; url: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = readStateFile(dataDir);
    if (s?.dashboardPort && s.dashboardUrl) return { port: s.dashboardPort, url: s.dashboardUrl };
    if (Date.now() > deadline) throw new Error('dashboard did not come up in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('production `xbus start` enables the control plane (no test-only flags)', () => {
  it('starts the dashboard + records its port/url in the state file; dashboard answers /alive', async () => {
    // Seed a couple of transcript files so dormant import has something to import.
    const projectsDir = path.join(dataDir, 'projects', '-c--proj');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, 'aaaa1111-0000-4000-8000-000000000001.jsonl'), '{"type":"user"}\n');
    fs.writeFileSync(path.join(projectsDir, 'bbbb2222-0000-4000-8000-000000000002.jsonl'), '{"type":"user"}\n');

    // Start the broker through the EXACT installed command (no dashboard:true anywhere).
    child = spawn(process.execPath, [CLI, 'start'], {
      env: { ...process.env, XBUS_DATA_DIR: dataDir, XBUS_ALLOW_UNSUPPORTED_NODE: '1', XBUS_CLAUDE_PROJECTS_DIR: path.join(dataDir, 'projects') },
      stdio: 'ignore',
    });
    const dash = await waitForDashboard(30_000);
    expect(dash.port).toBeGreaterThan(0);
    expect(dash.url).toContain('127.0.0.1');

    // /alive is reachable (dashboard actually listening) — unauthenticated liveness only.
    const alive = await fetch(`${dash.url}/alive`);
    expect(alive.status).toBe(200);
    // /api/sessions requires a token (production dashboard is authenticated) → 401 without one.
    const unauth = await fetch(`${dash.url}/api/sessions`);
    expect(unauth.status).toBe(401);

    // Dormant IMPORT ran in production start: the two seeded transcripts are imported as
    // dormant rows. Verify via a read-only DB open (the CLI has no unauth session list).
    const { openDatabase } = await import('../../src/database/connection.js');
    const db = openDatabase(path.join(dataDir, 'xbus.sqlite'), { readOnly: true });
    try {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE management_state='dormant'`).get() as { n: number }).n;
      expect(n, 'dormant import ran in production start').toBe(2);
    } finally { db.close(); }
  }, 60_000);
});
