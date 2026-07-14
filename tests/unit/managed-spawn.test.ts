/**
 * Beta.7 (ADR 0025) — managed background-session launcher (EXPERIMENTAL, opt-in). Verifies the
 * documented + SANDBOXED argv (--bg, --permission-mode plan, restricted --allowedTools, sandbox
 * system prompt, budget), the no-secret-in-argv/env invariant, XBUS_DATA_DIR pinning, and the
 * Windows .cmd routing — all with an INJECTED spawn (no real claude, no real process).
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { buildManagedArgs, spawnManagedSession, MANAGED_ALLOWED_TOOLS, MANAGED_SYSTEM_PROMPT } from '../../src/launcher/spawn-managed-session.js';
import type { ResolvedClaude } from '../../src/launcher/resolve-claude.js';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerDaemon } from '../../src/broker/daemon.js';
import { BrokerStore } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

describe('managed-spawn argv (ADR 0025)', () => {
  it('builds the documented sandboxed flags (--bg, plan, restricted tools, budget)', () => {
    const a = buildManagedArgs({ pluginDir: 'C:/x/plugin', sessionId: 'sid-1', name: 'task-1', budget: { maxTurns: 5, maxBudgetUsd: 0.5 } });
    // --bg (never -p), preminted session id, plugin dir, plan mode, restricted tools, sandbox prompt.
    expect(a).toContain('--bg');
    expect(a).not.toContain('-p');
    expect(a).not.toContain('--print');
    expect(a[a.indexOf('--session-id') + 1]).toBe('sid-1');
    expect(a[a.indexOf('--plugin-dir') + 1]).toBe('C:/x/plugin');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(a[a.indexOf('--allowedTools') + 1]).toBe(MANAGED_ALLOWED_TOOLS);
    expect(a[a.indexOf('--append-system-prompt') + 1]).toBe(MANAGED_SYSTEM_PROMPT);
    expect(a[a.indexOf('--max-turns') + 1]).toBe('5');
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('0.5');
    // The sandbox prompt forbids autonomous expansion.
    expect(MANAGED_SYSTEM_PROMPT).toMatch(/do NOT create schedules/i);
    // allowedTools is inbox/ack/reply ONLY — no Bash/Edit.
    expect(MANAGED_ALLOWED_TOOLS).not.toMatch(/Bash|Edit|Write/);
  });
});

describe('managed-spawn launch (injected spawn)', () => {
  const resolved: ResolvedClaude = { execPath: '/usr/bin/claude', launchVia: 'direct', source: 'path' };
  it('spawns detached with XBUS_DATA_DIR pinned + NO root secret in env/argv', () => {
    let captured: { cmd: string; args: string[]; opts: Record<string, unknown> } | null = null;
    const fakeSpawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      captured = { cmd, args, opts };
      return { pid: 4242, on: () => {}, unref: () => {} } as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const r = spawnManagedSession({
      pluginDir: '/p', dataDir: '/data', sessionId: 'sid-2', name: 'task', budget: { maxTurns: 3 },
      resolve: () => resolved, spawnFn: fakeSpawn, platform: 'linux',
      env: { XBUS_ROOT_SECRET: 'deadbeef'.repeat(8), PATH: '/usr/bin' } as NodeJS.ProcessEnv,
    });
    expect(r.ok).toBe(true);
    expect(r.pid).toBe(4242);
    expect(captured).not.toBeNull();
    const c = captured!;
    // Direct spawn of claude with the built args.
    expect(c.cmd).toBe('/usr/bin/claude');
    expect(c.args).toContain('--bg');
    // No secret anywhere in argv.
    expect(c.args.join(' ')).not.toMatch(/deadbeef/);
    // Env: XBUS_DATA_DIR pinned, XBUS_ROOT_SECRET scrubbed.
    const env = c.opts.env as NodeJS.ProcessEnv;
    expect(env.XBUS_DATA_DIR).toBe('/data');
    expect(env.XBUS_ROOT_SECRET).toBeUndefined();
    expect(c.opts.detached).toBe(true);
  });

  it('a Windows .cmd shim routes through cmd.exe with verbatim args', () => {
    let captured: { cmd: string; args: string[]; opts: Record<string, unknown> } | null = null;
    const fakeSpawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      captured = { cmd, args, opts };
      return { pid: 99, on: () => {}, unref: () => {} } as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;
    const cmdResolved: ResolvedClaude = { execPath: 'C:/npm/claude.cmd', launchVia: 'cmd', source: 'path' };
    const r = spawnManagedSession({
      pluginDir: 'C:/p', dataDir: 'C:/data', sessionId: 'sid-3', name: 'task',
      resolve: () => cmdResolved, spawnFn: fakeSpawn, platform: 'win32', env: { ComSpec: 'C:/Windows/System32/cmd.exe' } as NodeJS.ProcessEnv,
    });
    expect(r.ok).toBe(true);
    expect(captured!.cmd).toBe('C:/Windows/System32/cmd.exe');
    expect(captured!.args[0]).toBe('/d');
    expect(captured!.opts.windowsVerbatimArguments).toBe(true);
    // The whole command line embeds claude.cmd + --bg.
    expect(captured!.args.join(' ')).toMatch(/claude\.cmd/);
    expect(captured!.args.join(' ')).toMatch(/--bg/);
  });

  it('a resolve failure degrades gracefully (ok:false, no throw)', () => {
    const r = spawnManagedSession({
      pluginDir: '/p', dataDir: '/data', sessionId: 'sid-4', name: 'task',
      resolve: () => ({ ok: false, message: 'claude not found', attempted: ['claude'] }),
      spawnFn: (() => { throw new Error('should not spawn'); }) as unknown as typeof import('node:child_process').spawn,
      platform: 'linux',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });
});

describe('daemon stop_managed liveness guard (ADR 0024 §4)', () => {
  let dir: string; let db: SqliteDriver; let daemon: BrokerDaemon; let store: BrokerStore; let clock: FakeClock;
  const SID = 'mmmm7777-0000-4000-8000-0000000000d1';
  function setup(): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-stopmgd-'));
    db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
    clock = new FakeClock();
    runMigrations(db, clock.nowIso());
    store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
    daemon = new BrokerDaemon(db, 'ep', clock, new SeqIdGen('d'), 'binst');
  }
  afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  /** A minimal fake child process handle: pid + once('exit') + kill (records the signal). */
  function fakeChild(pid: number): { pid: number; killed: string | null; kill(sig?: NodeJS.Signals): boolean; once(e: 'exit', cb: () => void): unknown; fireExit(): void } {
    let onExit: (() => void) | null = null;
    return { pid, killed: null, kill(sig) { this.killed = sig ?? 'SIGTERM'; return true; }, once(_e, cb) { onExit = cb; return this; }, fireExit() { onExit?.(); } };
  }

  it('SIGTERMs a managed pid ONLY when a live in-process handle backs it (pid + launch_key match)', () => {
    setup();
    store.recordManagedSession(SID, 5555, 'sched:a:1');
    const child = fakeChild(5555);
    daemon.registerManagedChild(SID, 'sched:a:1', child);
    const res = daemon.operatorControl({ action: 'stop_managed', sessionId: SID }) as { killed: boolean; killable: boolean; pid: number | null };
    expect(res.killed).toBe(true);          // live handle present + matches → killed
    expect(res.killable).toBe(true);
    expect(child.killed).toBe('SIGTERM');    // exactly the child we tracked
    // Markers cleared.
    expect((db.prepare('SELECT managed_by_xbus FROM sessions WHERE session_id=?').get(SID) as { managed_by_xbus: number }).managed_by_xbus).toBe(0);
  });

  it('does NOT kill a bare pid with no live handle (broker-restart / recycled-pid safety)', () => {
    setup();
    // Managed record exists (as if written before a broker restart), but NO live handle is
    // registered on THIS daemon — so its pid must NOT be SIGTERM'd (it may be recycled).
    store.recordManagedSession(SID, 6666, 'sched:b:1');
    const res = daemon.operatorControl({ action: 'stop_managed', sessionId: SID }) as { killed: boolean; killable: boolean; pid: number | null };
    expect(res.killed).toBe(false);   // no live handle → clear markers, never kill a bare pid
    expect(res.killable).toBe(false);
    expect(res.pid).toBe(6666);       // still reported for observability
    expect((db.prepare('SELECT managed_by_xbus, managed_pid FROM sessions WHERE session_id=?').get(SID) as { managed_by_xbus: number; managed_pid: number | null }).managed_by_xbus).toBe(0);
  });

  it('a managed child exiting clears its markers (so a later stop has no killable pid) + drops the handle', () => {
    setup();
    store.recordManagedSession(SID, 7777, 'sched:c:1');
    const child = fakeChild(7777);
    daemon.registerManagedChild(SID, 'sched:c:1', child);
    child.fireExit(); // child dies naturally
    // Markers cleared by the exit handler → session is no longer managed.
    expect((db.prepare('SELECT managed_by_xbus, managed_pid FROM sessions WHERE session_id=?').get(SID) as { managed_by_xbus: number; managed_pid: number | null }).managed_by_xbus).toBe(0);
    // A subsequent stop_managed now refuses (not managed) — never kills the recycled pid.
    expect(() => daemon.operatorControl({ action: 'stop_managed', sessionId: SID })).toThrow();
  });

  it('refuses stop_managed on a NON-managed session (ownership boundary)', () => {
    setup();
    store.register({ sessionId: SID, instanceId: 'i', connectionId: 'c', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    expect(() => daemon.operatorControl({ action: 'stop_managed', sessionId: SID })).toThrow();
  });
});
