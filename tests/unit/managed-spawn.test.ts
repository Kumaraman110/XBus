/**
 * Beta.7 (ADR 0025) — managed background-session launcher (EXPERIMENTAL, opt-in). Verifies the
 * documented + SANDBOXED argv (--bg, --permission-mode plan, restricted --allowedTools, sandbox
 * system prompt, budget), the no-secret-in-argv/env invariant, XBUS_DATA_DIR pinning, and the
 * Windows .cmd routing — all with an INJECTED spawn (no real claude, no real process).
 */
import { describe, it, expect } from 'vitest';
import { buildManagedArgs, spawnManagedSession, MANAGED_ALLOWED_TOOLS, MANAGED_SYSTEM_PROMPT } from '../../src/launcher/spawn-managed-session.js';
import type { ResolvedClaude } from '../../src/launcher/resolve-claude.js';

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
