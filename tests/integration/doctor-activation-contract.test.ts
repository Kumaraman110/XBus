/**
 * BETA.10 (ADR 0036) — `xbus doctor --json` activation contract. Reliability requires a STABLE
 * machine-readable activation state + evidence fields + a distinct documented exit code, from the
 * SAME classifier as the human output. This runs the REAL compiled CLI in a disposable data dir with
 * NO broker (so activation is a non-connected state) and asserts the JSON contract + exit code.
 *
 * LOCAL_WINDOWS_OR_RELEASE_ONLY: spawns the compiled dist CLI as a child process (needs dist/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', '..', 'dist', 'cli', 'main.js');

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-doctorc-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

/** Run `doctor --json` in a disposable env (no golden touch); returns {code, json}. */
function doctor(): { code: number; json: Record<string, unknown> } {
  const env = { ...process.env, XBUS_DATA_DIR: dir, AGENTEL_DATA_DIR: dir, AGENTEL_ALLOW_UNSUPPORTED_NODE: '1' };
  // Strip any inherited session id so doctor takes the operator-view path deterministically.
  delete (env as Record<string, unknown>).CLAUDE_CODE_SESSION_ID;
  try {
    const out = execFileSync(process.execPath, [CLI, 'doctor', '--json'], { env, encoding: 'utf8', timeout: 30_000 });
    return { code: 0, json: JSON.parse(out) as Record<string, unknown> };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    // doctor uses a NON-zero exit code per activation state; the JSON is still on stdout.
    return { code: err.status ?? -1, json: JSON.parse(err.stdout ?? '{}') as Record<string, unknown> };
  }
}

const STATES = ['CONNECTED', 'PLUGIN_NOT_LOADED', 'MCP_DISCONNECTED', 'BROKER_UNAVAILABLE', 'DEGRADED_HOOK_ONLY'];
const EXIT: Record<string, number> = { CONNECTED: 0, PLUGIN_NOT_LOADED: 10, MCP_DISCONNECTED: 11, BROKER_UNAVAILABLE: 12, DEGRADED_HOOK_ONLY: 13 };

describe('doctor --json activation contract (skipIf no dist)', () => {
  const noDist = !fs.existsSync(CLI);
  it.skipIf(noDist)('emits a stable activation enum + required evidence fields', () => {
    const { json } = doctor();
    expect(STATES).toContain(json.activation);
    // Required machine-readable fields (Reliability ask #1/#2):
    expect(typeof json.activationConnected).toBe('boolean');
    expect(typeof json.activationSummary).toBe('string');
    expect(json).toHaveProperty('activationRemedy'); // string|null
    expect(json).toHaveProperty('activationEvidence');
    expect(json).toHaveProperty('persistentOptInAvailable');
    const ev = json.activationEvidence as Record<string, unknown>;
    expect(ev).toHaveProperty('mcpEver');
    expect(ev).toHaveProperty('brokerReachable');
  });

  it.skipIf(noDist)('the exit code matches the documented per-state table', () => {
    const { code, json } = doctor();
    expect(code).toBe(EXIT[json.activation as string]);
  });

  it.skipIf(noDist)('with no broker running, activation is a non-CONNECTED state and connected=false', () => {
    const { json } = doctor();
    expect(json.activation).not.toBe('CONNECTED');
    expect(json.activationConnected).toBe(false);
  });
});
