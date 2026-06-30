/**
 * User-scope Claude MCP + hooks config manager (beta.4, ADR 0012 Decision 8).
 *
 * Registers XBus as a USER-SCOPE MCP server + lifecycle hooks in the user's Claude
 * config so plain `claude` (from any directory) discovers XBus with NO
 * `--plugin-dir` and NO `xclaude` launcher. The companion to `install()` — it owns
 * the one thing the plugin-dir install does not: the user's Claude config file.
 *
 * Invariants (all tested in tests/unit/user-scope-config.test.ts):
 *   - TRANSACTIONAL: back up the prior config, write atomically (temp + rename),
 *     validate, and roll back to the byte-exact original on any failure.
 *   - PRESERVING: never touch the user's OTHER mcp servers, hooks, or top-level keys.
 *   - OWNERSHIP-TAGGED: our entries carry XBUS_OWNER_TAG=<installId>; uninstall
 *     removes ONLY what THIS install owns (never a different install's, never the
 *     user's own). A non-XBus-owned entry under the `xbus` key is NOT clobbered
 *     without force.
 *   - IDEMPOTENT: re-registering the same install is a no-op.
 *   - REPAIRABLE: re-apply the canonical entry when ours has drifted.
 *   - DEGRADED-SAFE: a write failure leaves the config exactly as it was.
 *
 * All filesystem inputs are injected via options (configPath, entries, validate),
 * so this is deterministic and never touches the real ~/.claude in tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Marker key embedded in XBus-owned config entries → ownership-scoped uninstall. */
export const XBUS_OWNER_TAG = '_xbusOwner';
/** Stable key the XBus MCP server is registered under. */
export const XBUS_MCP_KEY = 'xbus';
/** Lifecycle events XBus hooks into (the checkpoint legs). */
export const XBUS_HOOK_EVENTS = ['UserPromptSubmit', 'Stop'] as const;

/** A single MCP server entry (Claude config shape; extra keys preserved). */
export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  [k: string]: unknown;
}
/** The subset of the Claude user config we read/merge. Unknown keys are preserved. */
export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; [k: string]: unknown }> }>>;
  [k: string]: unknown;
}

export interface UserScopeOptions {
  /** Path to the user's Claude config file (platform-resolved by the caller). */
  configPath: string;
  /** Absolute node executable path (for the MCP/hook command). */
  nodePath: string;
  /** Absolute path to the compiled MCP server entry (dist/channel/server.js). */
  serverEntry: string;
  /** Absolute path to the compiled hook entry (dist/channel/hook-entry.js). */
  hookEntry: string;
  /** The broker data dir (pinned into the child env so every component agrees). */
  dataDir: string;
  /** This install's id (ownership tag). */
  installId: string;
  dryRun?: boolean;
  /** Force-take the `xbus` key even if a non-XBus-owned entry holds it. */
  force?: boolean;
  /** Injected post-write validator (default: re-read + parse). */
  validate?: (cfg: ClaudeConfig) => { ok: boolean; detail: string };
}

export interface RegisterResult {
  ok: boolean;
  dryRun: boolean;
  alreadyRegistered?: boolean;
  replacedConflict?: boolean;
  backupPath?: string;
  rolledBack?: boolean;
  error?: string;
}
export interface UnregisterResult { ok: boolean; removed: boolean; backupPath?: string; error?: string; }
export interface RepairResult { ok: boolean; repaired: boolean; error?: string; }

/** Resolve the platform default Claude user-config path (Decision 8 platform map). */
export function defaultClaudeConfigPath(): string {
  const home = os.homedir();
  // Claude Code uses ~/.claude.json on all platforms for the user config today;
  // the per-platform support dirs are reserved for caches, not this config.
  return process.env.CLAUDE_CONFIG_PATH ?? path.join(home, '.claude.json');
}

/** Read + parse the Claude config; null if absent/unparseable. */
export function readClaudeConfig(configPath: string): ClaudeConfig | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as ClaudeConfig;
  } catch { return null; }
}

/** Our canonical MCP server entry for a given install. */
function xbusMcpEntry(o: UserScopeOptions): McpServerEntry {
  return {
    command: o.nodePath,
    args: [o.serverEntry],
    env: { XBUS_DATA_DIR: o.dataDir },
    [XBUS_OWNER_TAG]: o.installId,
  };
}

/** Our canonical hook command: `"<node>" "<hookEntry>"`.
 *
 *  The command is a SHELL string, so the path must appear LITERALLY (a Windows path
 *  keeps its single backslashes). We therefore wrap each path in real double quotes
 *  (spaces-safe on both cmd.exe and POSIX sh) — NOT JSON.stringify, which would
 *  DOUBLE backslashes into the value (C:\\Users\\…), breaking both the runtime path
 *  and the includes()-based ownership match on uninstall. Filenames cannot contain a
 *  double quote on Windows, and our install paths never do on POSIX, so naive
 *  double-quote wrapping is safe here. */
function shQuote(p: string): string { return `"${p}"`; }
function xbusHookCommand(o: UserScopeOptions): string {
  return `${shQuote(o.nodePath)} ${shQuote(o.hookEntry)}`;
}

/** Is this hook-command string ours (references our hook entry)? */
function isXbusHookCommand(cmd: string, o: UserScopeOptions): boolean {
  return cmd.includes(o.hookEntry);
}

/** Build the post-merge config: add/replace ONLY our entries, preserve all else. */
function applyXbus(cfg: ClaudeConfig, o: UserScopeOptions): ClaudeConfig {
  const next: ClaudeConfig = { ...cfg };
  next.mcpServers = { ...(cfg.mcpServers ?? {}) };
  next.mcpServers[XBUS_MCP_KEY] = xbusMcpEntry(o);

  const hooks = { ...(cfg.hooks ?? {}) } as NonNullable<ClaudeConfig['hooks']>;
  const ourCmd = xbusHookCommand(o);
  for (const ev of XBUS_HOOK_EVENTS) {
    const existing = (hooks[ev] ?? []).map((g) => ({
      ...g,
      hooks: (g.hooks ?? []).filter((h) => !isXbusHookCommand(h.command, o)), // drop any prior ours
    })).filter((g) => g.hooks.length > 0); // drop now-empty groups we emptied
    existing.push({ hooks: [{ type: 'command', command: ourCmd, [XBUS_OWNER_TAG]: o.installId }] });
    hooks[ev] = existing;
  }
  next.hooks = hooks;
  return next;
}

/** Remove every XBus entry owned by `installId` (or any XBus entry if installId is
 *  null → repair/force). Returns the cleaned config + whether anything changed. */
function stripXbus(cfg: ClaudeConfig, o: UserScopeOptions, ownerToMatch: string | null): { cfg: ClaudeConfig; changed: boolean } {
  let changed = false;
  const next: ClaudeConfig = { ...cfg };
  // MCP server.
  if (cfg.mcpServers && cfg.mcpServers[XBUS_MCP_KEY]) {
    const owner = cfg.mcpServers[XBUS_MCP_KEY][XBUS_OWNER_TAG] as string | undefined;
    if (ownerToMatch === null || owner === ownerToMatch) {
      const m = { ...cfg.mcpServers };
      delete m[XBUS_MCP_KEY];
      next.mcpServers = m;
      changed = true;
    }
  }
  // Hooks.
  if (cfg.hooks) {
    const hooks: NonNullable<ClaudeConfig['hooks']> = {};
    for (const [ev, groups] of Object.entries(cfg.hooks)) {
      const cleanedGroups = groups.map((g) => {
        const kept = (g.hooks ?? []).filter((h) => {
          const isOurs = isXbusHookCommand(h.command, o) && (ownerToMatch === null || (h[XBUS_OWNER_TAG] as string | undefined) === ownerToMatch || (h[XBUS_OWNER_TAG] === undefined));
          if (isOurs) changed = true;
          return !isOurs;
        });
        return { ...g, hooks: kept };
      }).filter((g) => g.hooks.length > 0);
      if (cleanedGroups.length > 0) hooks[ev] = cleanedGroups;
    }
    next.hooks = hooks;
  }
  return { cfg: next, changed };
}

/** Atomic write with a one-shot backup of the prior file. Returns the backup path
 *  (or undefined if there was no prior file). Throws on write failure. */
function writeAtomicWithBackup(configPath: string, cfg: ClaudeConfig): string | undefined {
  let backupPath: string | undefined;
  if (fs.existsSync(configPath)) {
    backupPath = `${configPath}.xbus-backup-${process.pid}`;
    fs.copyFileSync(configPath, backupPath);
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }
  const tmp = `${configPath}.xbus-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configPath);
  return backupPath;
}

/** Restore the byte-exact original from a backup, then remove the backup. */
function restoreBackup(configPath: string, backupPath: string | undefined, hadFile: boolean): void {
  try {
    if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, configPath);
      fs.rmSync(backupPath, { force: true });
    } else if (!hadFile && fs.existsSync(configPath)) {
      fs.rmSync(configPath, { force: true }); // we created it → remove it
    }
  } catch { /* best effort */ }
}

function defaultValidate(cfg: ClaudeConfig): { ok: boolean; detail: string } {
  if (!cfg.mcpServers || !cfg.mcpServers[XBUS_MCP_KEY]) return { ok: false, detail: 'xbus mcp entry missing after write' };
  return { ok: true, detail: 'ok' };
}

/** Register XBus into the user-scope Claude config (transactional, idempotent). */
export function registerUserScope(o: UserScopeOptions): RegisterResult {
  const existing = readClaudeConfig(o.configPath) ?? {};
  const cur = existing.mcpServers?.[XBUS_MCP_KEY];

  // Conflict: the `xbus` key is held by something NOT owned by any XBus install.
  if (cur && cur[XBUS_OWNER_TAG] === undefined && !o.force) {
    return { ok: false, dryRun: !!o.dryRun, error: `the "${XBUS_MCP_KEY}" mcp key is present but not owned by XBus; refusing to overwrite (use force to take it)` };
  }
  // Idempotent: already ours with the same install id + canonical command/args.
  const canonical = xbusMcpEntry(o);
  const replacedConflict = !!cur && cur[XBUS_OWNER_TAG] !== undefined && cur[XBUS_OWNER_TAG] !== o.installId;
  if (cur && cur[XBUS_OWNER_TAG] === o.installId && cur.command === canonical.command && JSON.stringify(cur.args) === JSON.stringify(canonical.args)) {
    return { ok: true, dryRun: !!o.dryRun, alreadyRegistered: true };
  }

  if (o.dryRun) return { ok: true, dryRun: true, ...(replacedConflict ? { replacedConflict } : {}) };

  const hadFile = fs.existsSync(o.configPath);
  const merged = applyXbus(existing, o);
  let backupPath: string | undefined;
  try {
    backupPath = writeAtomicWithBackup(o.configPath, merged);
    const validate = o.validate ?? defaultValidate;
    const reread = readClaudeConfig(o.configPath);
    const v = reread ? validate(reread) : { ok: false, detail: 'config unreadable after write' };
    if (!v.ok) {
      restoreBackup(o.configPath, backupPath, hadFile);
      return { ok: false, dryRun: false, rolledBack: true, error: `config validation failed: ${v.detail}` };
    }
    // Success — drop the backup file we no longer need (the result still reports it).
    const result: RegisterResult = { ok: true, dryRun: false };
    if (backupPath) result.backupPath = backupPath;
    if (replacedConflict) result.replacedConflict = true;
    return result;
  } catch (e) {
    restoreBackup(o.configPath, backupPath, hadFile);
    return { ok: false, dryRun: false, rolledBack: true, error: (e as Error).message };
  }
}

/** Remove ONLY the XBus entries this install owns. Other installs / the user's own
 *  config are left untouched. Transactional. */
export function unregisterUserScope(o: UserScopeOptions): UnregisterResult {
  const existing = readClaudeConfig(o.configPath);
  if (!existing) return { ok: true, removed: false };
  const { cfg, changed } = stripXbus(existing, o, o.installId);
  if (!changed) return { ok: true, removed: false };
  if (o.dryRun) return { ok: true, removed: true };
  const hadFile = fs.existsSync(o.configPath);
  let backupPath: string | undefined;
  try {
    backupPath = writeAtomicWithBackup(o.configPath, cfg);
    const result: UnregisterResult = { ok: true, removed: true };
    if (backupPath) result.backupPath = backupPath;
    return result;
  } catch (e) {
    restoreBackup(o.configPath, backupPath, hadFile);
    return { ok: false, removed: false, error: (e as Error).message };
  }
}

/** Re-apply the canonical XBus entry (fixes drift, e.g. a moved node path).
 *  Registers fresh if absent. Force-takes our own key (repair owns the xbus key). */
export function repairUserScope(o: UserScopeOptions): RepairResult {
  const r = registerUserScope({ ...o, force: true });
  if (!r.ok) return { ok: false, repaired: false, ...(r.error ? { error: r.error } : {}) };
  return { ok: true, repaired: !r.alreadyRegistered };
}
