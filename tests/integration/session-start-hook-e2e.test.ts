/**
 * Beta.5 Phase 1 TEST GATE — the REAL SessionStart hook entrypoint, end to end.
 *
 * Spawns the compiled `dist/channel/session-start-hook.js` as a child process (exactly how
 * Claude Code invokes it) with fixture hook JSON on stdin, for each lifecycle source:
 *   startup · resume · clear · compact · fork (startup with a NEW session id).
 * The hook auto-starts the single broker (ensureBrokerDefault) against an isolated
 * XBUS_DATA_DIR and announces. We then open the resulting SQLite DB and assert:
 *   - all five paths produced the right visibility state + ledger events,
 *   - the hash chain is valid,
 *   - ONE broker served them all (one broker.state.json instance id),
 *   - every hook invocation EXITED 0 (never blocks Claude), even the fork.
 *
 * This is the automated proxy for "run real Claude sessions"; the pixel-level dashboard
 * rendering remains a human visual gate (ADR 0013).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { openDatabase } from '../../src/database/connection.js';
import { verifyLedger } from '../../src/broker/ledger.js';
import { readStateFile } from '../../src/broker/state-file.js';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { ensureDataDir } from '../../src/ipc/transport.js';

const HOOK = path.resolve('dist/channel/session-start-hook.js');
let dataDir: string;
let broker: RunningBroker | null;

/** Run the real hook with fixture stdin + isolated env; resolves with the exit code. */
function runHook(input: Record<string, unknown>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [HOOK], {
      env: { ...process.env, XBUS_DATA_DIR: dataDir, XBUS_ALLOW_UNSUPPORTED_NODE: '1', CLAUDE_CODE_SESSION_ID: '' },
      timeout: 30_000,
    }, (err, _stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
      resolve({ code, stderr: stderr ?? '' });
    });
    child.stdin!.end(JSON.stringify(input));
  });
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-sshe2e-'));
  ensureDataDir(dataDir);
  // Pre-start the persistent broker — this models the machine SINGLETON (the first session
  // boots it; every subsequent SessionStart connects to the already-running broker). A cold
  // hook that beats the broker up would degrade gracefully (proven separately); here we
  // prove the steady-state: every lifecycle event lands. The DB is migrated by the host.
  broker = await startBrokerHost({ dataDir, enforceSingleton: false, reaperIntervalMs: 0 });
});
afterEach(async () => {
  if (broker) { try { await broker.stop(); } catch { /* ignore */ } broker = null; }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SessionStart hook E2E — real entrypoint, all five lifecycle paths', () => {
  it('startup/resume/clear/compact/fork all appear via the ledger + one broker; every hook exits 0', async () => {
    const SID = '70000000-0000-4000-8000-000000000001';
    const FORK = '70000000-0000-4000-8000-0000000000ff';
    const cwd = path.join(dataDir, 'wd');
    fs.mkdirSync(cwd, { recursive: true });

    // Fire the four same-session lifecycle events in order + a fork with a NEW id.
    const startup = await runHook({ hook_event_name: 'SessionStart', session_id: SID, source: 'startup', cwd, transcript_path: '/p/t.jsonl' });
    expect(startup.code, `startup stderr: ${startup.stderr}`).toBe(0);
    const resume = await runHook({ hook_event_name: 'SessionStart', session_id: SID, source: 'resume', cwd });
    expect(resume.code).toBe(0);
    const clear = await runHook({ hook_event_name: 'SessionStart', session_id: SID, source: 'clear', cwd });
    expect(clear.code).toBe(0);
    const compact = await runHook({ hook_event_name: 'SessionStart', session_id: SID, source: 'compact', cwd });
    expect(compact.code).toBe(0);
    const fork = await runHook({ hook_event_name: 'SessionStart', session_id: FORK, source: 'startup', cwd });
    expect(fork.code).toBe(0);

    // Give the broker a moment to flush WAL, then read the resulting DB read-only.
    const dbPath = path.join(dataDir, 'xbus.sqlite');
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = openDatabase(dbPath, { readOnly: true });
    try {
      // The main session recorded started→resumed→cleared→compacted; the fork is a
      // separate active session with its own STARTED.
      const mainEvents = (db.prepare(`SELECT event_type FROM ledger_events WHERE subject_json LIKE ? ORDER BY seq`).all(`%${SID}%`) as Array<{ event_type: string }>).map((r) => r.event_type);
      expect(mainEvents).toEqual(['SESSION_STARTED', 'SESSION_RESUMED', 'SESSION_CLEARED', 'SESSION_COMPACTED']);
      const forkEvents = (db.prepare(`SELECT event_type FROM ledger_events WHERE subject_json LIKE ? ORDER BY seq`).all(`%${FORK}%`) as Array<{ event_type: string }>).map((r) => r.event_type);
      expect(forkEvents).toEqual(['SESSION_STARTED']);
      // Two distinct active sessions.
      const active = (db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE management_state='active'`).get() as { n: number }).n;
      expect(active).toBe(2);
      // Hash chain valid across the whole sequence.
      expect(verifyLedger(db).ok).toBe(true);
    } finally { db.close(); }

    // ONE broker served everything (the harness's single instance id in the state file).
    const state = readStateFile(dataDir);
    expect(state).not.toBeNull();
    expect(state!.brokerInstanceId).toBe(broker!.brokerInstanceId);
  }, 120_000);

  it('malformed hook input still exits 0 (never blocks Claude)', async () => {
    const cwd = path.join(dataDir, 'wd2'); fs.mkdirSync(cwd, { recursive: true });
    // Send junk on stdin; the hook must parse-fail → degrade → exit 0.
    const r = await new Promise<number>((resolve) => {
      const child = execFile(process.execPath, [HOOK], { env: { ...process.env, XBUS_DATA_DIR: dataDir, XBUS_ALLOW_UNSUPPORTED_NODE: '1', CLAUDE_CODE_SESSION_ID: '' }, timeout: 30_000 }, (err) => {
        resolve(err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0);
      });
      child.stdin!.end('this is not json at all');
    });
    expect(r).toBe(0);
  }, 60_000);
});
