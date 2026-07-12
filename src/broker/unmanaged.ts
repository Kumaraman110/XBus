/**
 * Conservative AGGREGATE unmanaged-session detection (beta.5 Phase 1; ADR 0013 D6).
 *
 * A Claude session that was already running before XBus installed fired no post-install
 * SessionStart, so XBus has no hook signal for it and cannot honestly claim to manage it.
 * We do NOT fabricate retroactive registration and we do NOT map individual unmanaged
 * sessions (that would need invasive introspection of a foreign process's env/memory — a
 * security smell we refuse). Instead we compute a single conservative AGGREGATE:
 *
 *     possibleUnmanaged = max(0, liveClaudeProcesses - managedOrDormantSessions)
 *
 * using only NON-INVASIVE facts: a coarse count of live `claude` processes and the count
 * of managed+dormant sessions the broker already knows. This drives a single dashboard
 * banner ("N Claude session(s) may be running that started before XBus…"), never per-row
 * entries and never a transition to `active` without a real SessionStart signal.
 */

/** Pure aggregate — trivially unit-testable, no I/O. Clamped to >= 0. */
export function computeUnmanagedBanner(input: { liveClaudeProcesses: number; managedOrDormantSessions: number }): { possibleUnmanaged: number } {
  const live = Number.isFinite(input.liveClaudeProcesses) ? Math.max(0, Math.trunc(input.liveClaudeProcesses)) : 0;
  const known = Number.isFinite(input.managedOrDormantSessions) ? Math.max(0, Math.trunc(input.managedOrDormantSessions)) : 0;
  return { possibleUnmanaged: Math.max(0, live - known) };
}

/**
 * Best-effort, NON-INVASIVE count of live `claude` processes. Uses only a process LISTING
 * (names/counts) — it never opens another process's env, memory, or handles. Platform tools:
 * Windows `tasklist`, POSIX `ps`. Any failure (tool absent, timeout, parse error) yields 0
 * (conservative: we'd rather under-report than fabricate). The caller runs this off the hot
 * path (dashboard poll / doctor), never inside a delivery transaction.
 *
 * Injectable `exec` for tests so we don't spawn real processes in the suite.
 */
export function countLiveClaudeProcesses(
  exec: (cmd: string, args: string[]) => string = defaultListProcesses,
): number {
  try {
    const isWin = process.platform === 'win32';
    const out = isWin
      ? exec('tasklist', ['/fo', 'csv', '/nh'])
      : exec('ps', ['-A', '-o', 'comm=']);
    if (!out) return 0;
    // Count lines whose process name looks like a `claude` binary. Coarse + name-only.
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let n = 0;
    for (const line of lines) {
      const name = isWin ? (line.split('","')[0] ?? '').replace(/^"/, '').toLowerCase() : line.toLowerCase();
      const base = name.split(/[\\/]/).pop() ?? name;
      if (base === 'claude' || base === 'claude.exe' || base.startsWith('claude')) n += 1;
    }
    return n;
  } catch {
    return 0; // conservative: never throw, never over-report
  }
}

function defaultListProcesses(cmd: string, args: string[]): string {
  // Lazy import so the pure functions above stay dependency-free + the module is safe to
  // import in a worker/test without spawning anything.
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}
