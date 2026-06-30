/**
 * Resolve the `claude` executable to a LAUNCHABLE path on the current platform.
 *
 * Root cause this fixes: the launcher defaulted to the bare token `claude` and
 * only routed through cmd.exe when that token already ended in `.cmd`/`.bat`.
 * On Windows, npm installs Claude as PATH shims (`claude.ps1`, `claude.cmd`, and
 * an extensionless `claude`). Node's non-shell `spawn('claude', …)` does NOT
 * consult PATHEXT, so it raised ENOENT even though `claude.cmd` was on PATH — and
 * the launcher then wrongly told the user Claude was missing.
 *
 * This resolver finds Claude the way Windows actually would, deterministically,
 * WITHOUT shell injection (it never builds a shell command line from untrusted
 * input — it queries `where.exe` per concrete file name and validates the result).
 *
 * Windows preference order (deterministic, documented + tested):
 *     claude.cmd  →  claude.exe  →  claude.bat  →  claude (extensionless)
 *   - `.ps1` is intentionally NEVER selected: launching it safely requires a
 *     PowerShell argument model the launcher does not implement, and a `.cmd`
 *     shim is always present alongside it for npm installs.
 *   - the extensionless `claude` is only accepted if it is a real launchable file
 *     (some npm layouts ship it as a shell script that Windows cannot spawn
 *     directly); it is last because `.cmd`/`.exe` are the reliable launch targets.
 *
 * POSIX: resolve `claude` via PATH (`which`-style) and spawn it directly.
 *
 * An explicit `CLAUDE_CODE_EXECPATH` always wins and is validated to exist; it is
 * the documented advanced override, never the normal path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ResolveClaudeOptions {
  explicitPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  /** Injectable PATH lookup (defaults to `where.exe`/`which`). For tests. */
  lookup?: ((name: string, env: NodeJS.ProcessEnv) => string[]) | undefined;
}

export interface ResolvedClaude {
  /** Absolute path to the launchable executable/shim. */
  execPath: string;
  /** How to launch it: a .cmd/.bat must go through cmd.exe; else spawn directly. */
  launchVia: 'cmd' | 'direct';
  /** Where it came from — for diagnostics. */
  source: 'explicit' | 'path';
}

export interface ResolveClaudeFailure {
  ok: false;
  /** Human-actionable message naming the lookup strategy + attempts. */
  message: string;
  /** The concrete names that were searched, in order. */
  attempted: string[];
}

/** Windows launch-target preference. `.ps1` is deliberately absent. */
const WINDOWS_CANDIDATES = ['claude.cmd', 'claude.exe', 'claude.bat', 'claude'] as const;

/** Default PATH lookup: `where.exe <name>` on Windows, `command -v`/which on POSIX.
 *  Each call is a single fixed argument (the concrete file name) — no shell, no
 *  interpolation of user input. Returns absolute paths in PATH order, [] if none. */
function defaultLookup(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  try {
    if (platform === 'win32') {
      const out = execFileSync('where.exe', [name], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    // POSIX: `command -v` would need a shell; use `which` which is execFile-safe.
    const out = execFileSync('which', [name], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return []; // not found (where.exe/which exit nonzero) — not an error here
  }
}

/** A `.cmd`/`.bat` is launched via cmd.exe; everything else is spawned directly. */
function launchViaFor(execPath: string): 'cmd' | 'direct' {
  return /\.(cmd|bat)$/i.test(execPath) ? 'cmd' : 'direct';
}

/**
 * Resolve Claude. Returns a ResolvedClaude on success, or a ResolveClaudeFailure
 * (never throws for "not found" — the caller renders the actionable message).
 */
export function resolveClaudeExecutable(opts: ResolveClaudeOptions = {}): ResolvedClaude | ResolveClaudeFailure {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const lookup = opts.lookup ?? ((name: string, e: NodeJS.ProcessEnv) => defaultLookup(name, e, platform));

  // 1) Explicit override always wins; validate it exists.
  const explicit = opts.explicitPath;
  if (explicit && explicit.trim() !== '') {
    if (!fs.existsSync(explicit)) {
      return {
        ok: false,
        message: `CLAUDE_CODE_EXECPATH is set to "${explicit}" but no file exists there. Point it at your Claude Code executable, or unset it to auto-detect.`,
        attempted: [explicit],
      };
    }
    return { execPath: explicit, launchVia: launchViaFor(explicit), source: 'explicit' };
  }

  // 2) Auto-detect on PATH.
  if (platform === 'win32') {
    const attempted: string[] = [];
    for (const name of WINDOWS_CANDIDATES) {
      attempted.push(name);
      const hits = lookup(name, env);
      for (const hit of hits) {
        // where.exe with an extensionless query ("claude") also returns the .cmd;
        // only accept a hit whose basename matches the candidate we asked for, so
        // the preference order is honoured exactly and .ps1 is never chosen.
        const base = path.basename(hit).toLowerCase();
        if (base !== name.toLowerCase()) continue;
        if (/\.ps1$/i.test(hit)) continue; // never select a PowerShell script
        if (!fs.existsSync(hit)) continue;
        return { execPath: hit, launchVia: launchViaFor(hit), source: 'path' };
      }
    }
    return {
      ok: false,
      message: [
        `could not find a launchable 'claude' on PATH.`,
        `Searched (in order) via where.exe: ${WINDOWS_CANDIDATES.join(', ')}.`,
        `Install Claude Code so 'claude.cmd' is on your PATH, or set CLAUDE_CODE_EXECPATH to its full path (advanced).`,
      ].join('\n  '),
      attempted,
    };
  }

  // POSIX.
  const hits = lookup('claude', env);
  const hit = hits.find((h) => fs.existsSync(h));
  if (hit) return { execPath: hit, launchVia: 'direct', source: 'path' };
  return {
    ok: false,
    message: `could not find 'claude' on PATH. Install Claude Code, or set CLAUDE_CODE_EXECPATH to its full path (advanced).`,
    attempted: ['claude'],
  };
}

/** Type guard: did resolution succeed? */
export function isResolved(r: ResolvedClaude | ResolveClaudeFailure): r is ResolvedClaude {
  return (r as ResolveClaudeFailure).ok !== false;
}
