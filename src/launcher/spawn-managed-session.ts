/**
 * Managed background-session launcher (beta.7 Phase 3, ADR 0025) — EXPERIMENTAL, opt-in,
 * default OFF, gated on a recorded `doctor` spawn-probe.
 *
 * Launches an XBus-managed background Claude session for a due scheduled task using DOCUMENTED
 * headless flags: `claude --bg` (NEVER `-p` — they are mutually exclusive and `-p` hook
 * behavior is unverified) `--session-id <preminted UUID>` `--plugin-dir <installed pluginDir>`
 * `--name <label>` `--permission-mode plan` `--max-turns/--max-budget-usd` (from the schedule's
 * budget) `--append-system-prompt <sandbox instruction>` `--allowedTools
 * mcp__xbus__xbus_inbox,mcp__xbus__xbus_ack,mcp__xbus__xbus_reply`. The preminted session id is
 * recorded to the broker BEFORE spawn (closes the register race). The spawned session's own
 * SessionStart + checkpoint hooks drain the already-QUEUED scheduled message on the normal pull
 * path — this launcher never carries the body.
 *
 * SANDBOX: `--permission-mode plan` + a restricted `--allowedTools` (inbox/ack/reply only) + an
 * `--append-system-prompt` forbidding schedule creation / spawning prevent a runaway autonomous
 * loop. XBUS_DATA_DIR is pinned; the root secret is NEVER placed in argv/env (the child reads
 * the ACL'd data dir). Windows `.cmd` shims route through cmd.exe with verbatim args (the exact
 * bug resolve-claude.ts fixes).
 *
 * DEGRADE: if the installed `claude` lacks `--bg` (probed via `--help`), the caller MUST NOT
 * spawn — it degrades to `enqueue_only` (the queued message still drains at the target's next
 * real checkpoint). `probeManagedSpawn` records that capability for `doctor`.
 */
import { spawn as realSpawn, execFileSync } from 'node:child_process';
import { resolveClaudeExecutable, isResolved, type ResolveClaudeOptions } from './resolve-claude.js';
import { cmdQuoteArg } from './xclaude.js';

/** The sandbox system-prompt appended to a managed session — forbids autonomous expansion. */
export const MANAGED_SYSTEM_PROMPT =
  'You are an XBus-managed background session launched to process ONE pending XBus message. ' +
  'Read it (xbus_inbox), acknowledge (xbus_ack), do the requested work, and reply (xbus_reply). ' +
  'Do NOT create schedules, spawn work, or start long-running loops. Exit when the task is done.';

/** The only tools a managed session may auto-use (no Bash/Edit/etc.). */
export const MANAGED_ALLOWED_TOOLS = 'mcp__xbus__xbus_inbox,mcp__xbus__xbus_ack,mcp__xbus__xbus_reply';

export interface ManagedBudget { maxTurns?: number; maxBudgetUsd?: number; timeoutMs?: number; }

export interface ManagedSpawnOptions {
  pluginDir: string;
  dataDir: string;
  /** Preminted session id (record to the broker BEFORE spawn to close the register race). */
  sessionId: string;
  /** A short display name for the managed session. */
  name: string;
  budget?: ManagedBudget;
  /** Injected for tests. */
  resolve?: (o: ResolveClaudeOptions) => ReturnType<typeof resolveClaudeExecutable>;
  spawnFn?: typeof realSpawn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ManagedSpawnResult {
  ok: boolean;
  pid?: number;
  reason?: string;
  /** The resolved argv (for logging/tests) — never carries the root secret. */
  argv?: string[];
}

/** Build the documented `claude` argv for a managed background session. Pure + testable. */
export function buildManagedArgs(o: { pluginDir: string; sessionId: string; name: string; budget?: ManagedBudget }): string[] {
  const args = [
    '--bg',
    '--session-id', o.sessionId,
    '--plugin-dir', o.pluginDir,
    '--name', o.name,
    '--permission-mode', 'plan',
    '--allowedTools', MANAGED_ALLOWED_TOOLS,
    '--append-system-prompt', MANAGED_SYSTEM_PROMPT,
  ];
  if (o.budget?.maxTurns !== undefined) args.push('--max-turns', String(o.budget.maxTurns));
  if (o.budget?.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(o.budget.maxBudgetUsd));
  return args;
}

/**
 * Probe whether the installed `claude` supports `--bg` (the managed-spawn prerequisite). Runs
 * `claude --help` and checks for the flag. Returns false on any error (fail-closed → the caller
 * degrades to enqueue_only). Recorded by `doctor` so managed_spawn is only claimed when real.
 */
export function probeManagedSpawn(opts: { resolve?: (o: ResolveClaudeOptions) => ReturnType<typeof resolveClaudeExecutable>; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): { available: boolean; detail: string } {
  const resolve = opts.resolve ?? resolveClaudeExecutable;
  const r = resolve({ env: opts.env, platform: opts.platform });
  if (!isResolved(r)) return { available: false, detail: 'claude not found on PATH' };
  try {
    const help = execFileSync(r.execPath, ['--help'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const hasBg = /--bg\b|--background\b/.test(help);
    return { available: hasBg, detail: hasBg ? 'claude --bg supported' : 'installed claude lacks --bg (managed_spawn degrades to enqueue_only)' };
  } catch (e) {
    return { available: false, detail: `claude --help probe failed: ${(e as Error).message}` };
  }
}

/**
 * Spawn a managed background session. Caller MUST have preminted + recorded the session id.
 * Returns {ok, pid} or {ok:false, reason} — NEVER throws (a spawn failure degrades gracefully).
 * The root secret is never in argv/env (the child reads the ACL'd data dir).
 */
export function spawnManagedSession(o: ManagedSpawnOptions): ManagedSpawnResult {
  const resolve = o.resolve ?? resolveClaudeExecutable;
  const spawnFn = o.spawnFn ?? realSpawn;
  const env = { ...(o.env ?? process.env) };
  delete (env as Record<string, string | undefined>).XBUS_ROOT_SECRET; // never propagate a secret
  env.XBUS_DATA_DIR = o.dataDir;                                        // pin the canonical root
  const r = resolve({ env, platform: o.platform });
  if (!isResolved(r)) return { ok: false, reason: r.message };
  const args = buildManagedArgs({ pluginDir: o.pluginDir, sessionId: o.sessionId, name: o.name, ...(o.budget ? { budget: o.budget } : {}) });
  try {
    let child;
    if (r.launchVia === 'cmd') {
      // Route a .cmd/.bat shim through cmd.exe with each token quoted (resolve-claude fix).
      const line = '"' + [r.execPath, ...args].map(cmdQuoteArg).join(' ') + '"';
      child = spawnFn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { detached: true, stdio: 'ignore', env, windowsHide: true, windowsVerbatimArguments: true });
    } else {
      child = spawnFn(r.execPath, args, { detached: true, stdio: 'ignore', env, windowsHide: true });
    }
    child.on('error', () => { /* async spawn failure — never crash the broker */ });
    child.unref();
    return { ok: true, ...(child.pid !== undefined ? { pid: child.pid } : {}), argv: args };
  } catch (e) {
    return { ok: false, reason: (e as Error).message, argv: args };
  }
}
