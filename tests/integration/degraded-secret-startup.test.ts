/**
 * Final-review #2/#3 regression: hook + MCP-server entrypoints must DEGRADE (never crash
 * with an uncaught exception) when the root secret is malformed/unreadable. A hook that
 * throws would block Claude's turn; an MCP server that throws would crash instead of just
 * making the xbus tools absent. Both must exit gracefully (ADR 0012: "Claude remains
 * usable when XBus is degraded").
 *
 * Driven as real subprocess spawns of the COMPILED entrypoints (dist), because the guard
 * lives at process boundary (loadOrCreateRootSecret can throw before the inner try).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', '..', 'dist');
const HOOK_ENTRY = path.join(DIST, 'channel', 'hook-entry.js');
const SERVER_ENTRY = path.join(DIST, 'channel', 'server.js');

let dataDir: string;

function plantMalformedSecret(dir: string): void {
  const authDir = path.join(dir, 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  // Wrong byte length ⇒ loadOrCreateRootSecret throws XBusError(AUTH_FAILED).
  fs.writeFileSync(path.join(authDir, 'root.secret'), Buffer.alloc(7), { mode: 0o600 });
}

beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-degsec-')); });
afterEach(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('degraded startup on malformed root secret', () => {
  it('hook-entry exits 0 (degrades, never blocks Claude) on a malformed secret', () => {
    plantMalformedSecret(dataDir);
    const r = spawnSync(process.execPath, [HOOK_ENTRY], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'deg-hook' }),
      env: { ...process.env, XBUS_DATA_DIR: dataDir, CLAUDE_CODE_SESSION_ID: 'deg-hook-sess' },
      encoding: 'utf8', timeout: 30000,
    });
    // The whole point: the hook must not crash the turn. Exit 0, no thrown-stack on stderr.
    expect(r.status).toBe(0);
    expect(r.stderr ?? '').not.toMatch(/AUTH_FAILED|Uncaught|UnhandledPromiseRejection|malformed/);
  });

  it('MCP server exits cleanly (does not crash) on a malformed secret', () => {
    plantMalformedSecret(dataDir);
    const r = spawnSync(process.execPath, [SERVER_ENTRY], {
      // No stdin data; the server should fail the secret load and exit before reading MCP.
      input: '',
      env: { ...process.env, XBUS_DATA_DIR: dataDir, CLAUDE_CODE_SESSION_ID: 'deg-mcp-sess' },
      encoding: 'utf8', timeout: 30000,
    });
    // Graceful, non-crash exit (0). An uncaught XBusError would surface a non-zero code
    // with a thrown stack; the actionable diagnostic is allowed but not a raw crash.
    expect(r.status).toBe(0);
    expect(r.stderr ?? '').not.toMatch(/Uncaught|UnhandledPromiseRejection/);
  });

  it('sanity: a VALID secret does not trigger the degrade path (hook exits 0 with no error stack)', () => {
    // A fresh (absent) secret is created cleanly — the degrade path is only for malformed.
    const r = spawnSync(process.execPath, [HOOK_ENTRY], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'ok-hook' }),
      env: { ...process.env, XBUS_DATA_DIR: dataDir, CLAUDE_CODE_SESSION_ID: 'ok-hook-sess' },
      encoding: 'utf8', timeout: 30000,
    });
    expect(r.status).toBe(0);
    expect(r.stderr ?? '').not.toMatch(/AUTH_FAILED|Uncaught/);
  });
});
