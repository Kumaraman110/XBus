/**
 * User-scope Claude MCP + hooks config manager (beta.4, ADR 0012 Decision 8).
 *
 * Registers XBus as a USER-SCOPE MCP server + lifecycle hooks so plain `claude`
 * (from any directory) discovers XBus with NO `--plugin-dir` and NO `xclaude`.
 *
 * CRITICAL (verified against Claude Code v2.1.x docs): MCP servers and hooks live
 * in DIFFERENT user-scope files —
 *   - MCP servers → ~/.claude.json            (top-level `mcpServers` key)
 *   - hooks       → ~/.claude/settings.json    (top-level `hooks` key)
 * Hooks written into ~/.claude.json are SILENTLY IGNORED. So this manager writes
 * BOTH files, each transactionally + ownership-tagged.
 *
 * Hooks use the EXEC form ({type:'command', command:<node>, args:[<hookEntry>]}) —
 * Claude spawns the executable directly with no shell, so paths need no quoting and
 * Windows backslashes are passed literally. The shell form (a single command string)
 * is intentionally avoided.
 *
 * Invariants (tests/unit/user-scope-config.test.ts):
 *   - TRANSACTIONAL per file: back up → atomic temp+rename → validate → byte-exact
 *     rollback on failure. If the SECOND file fails, the FIRST is rolled back too.
 *   - PRESERVING: never touch the user's OTHER mcp servers / hooks / top-level keys.
 *   - OWNERSHIP-TAGGED (_xbusOwner=installId): uninstall removes ONLY what THIS
 *     install created; a non-XBus-owned `xbus` mcp key is not clobbered without force,
 *     and an untagged hook is never removed.
 *   - IDEMPOTENT, REPAIRABLE, DEGRADED-SAFE.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Marker key embedded in XBus-owned config entries → ownership-scoped uninstall. */
export const XBUS_OWNER_TAG = '_xbusOwner';
/** Stable key the XBus MCP server is registered under. */
export const XBUS_MCP_KEY = 'xbus';
/**
 * Lifecycle events XBus hooks into, each with its OWN dedicated handler entry (beta.5):
 *   - SessionStart              → session-start-hook.js  (control-plane VISIBILITY: announce
 *                                  every new/resumed/cleared/compacted session; always exit 0)
 *   - UserPromptSubmit / Stop   → hook-entry.js          (checkpoint message DELIVERY legs)
 * Registering the WRONG entry on an event is a silent product break (e.g. SessionStart
 * pointed at the checkpoint hook would never announce), so the entry is event-specific and
 * the installer resolves each from the plugin's dist paths (see hookEntries()).
 */
export const XBUS_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;
export type XbusHookEvent = (typeof XBUS_HOOK_EVENTS)[number];

/** A single MCP server entry (Claude config shape; extra keys preserved). */
export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  [k: string]: unknown;
}
/** The user MCP config file (~/.claude.json). Unknown keys preserved. */
export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}
/** A hook command handler (exec form: command + args, no shell). */
export interface HookHandler { type: string; command: string; args?: string[]; [k: string]: unknown; }
export interface HookGroup { matcher?: string; hooks: HookHandler[]; }
/** The user settings file (~/.claude/settings.json). Unknown keys preserved. */
export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

export interface UserScopeOptions {
  /** Path to the user MCP config (~/.claude.json). */
  configPath: string;
  /** Path to the user settings file (~/.claude/settings.json). Defaults next to
   *  configPath under a `.claude` dir if omitted (back-compat for older callers). */
  settingsPath?: string;
  nodePath: string;
  serverEntry: string;
  /** The checkpoint-delivery hook entry (UserPromptSubmit + Stop) — dist/channel/hook-entry.js. */
  hookEntry: string;
  /** Beta.5: the SessionStart lifecycle hook entry — dist/channel/session-start-hook.js.
   *  Optional for back-compat; when omitted, SessionStart is NOT registered (older callers),
   *  but the installer always supplies it so every install wires session visibility. */
  sessionStartHookEntry?: string;
  dataDir: string;
  installId: string;
  dryRun?: boolean;
  /** Force-take the `xbus` mcp key even if a non-XBus-owned entry holds it. */
  force?: boolean;
  /** Injected post-write validators (default: re-read + parse + presence). */
  validateConfig?: (cfg: ClaudeConfig) => { ok: boolean; detail: string };
  validateSettings?: (s: ClaudeSettings) => { ok: boolean; detail: string };
}

export interface RegisterResult {
  ok: boolean;
  dryRun: boolean;
  alreadyRegistered?: boolean;
  replacedConflict?: boolean;
  /** Backup of the pre-install ~/.claude.json (restorable). */
  backupPath?: string;
  /** Backup of the pre-install settings.json (restorable). */
  settingsBackupPath?: string;
  rolledBack?: boolean;
  error?: string;
}
export interface UnregisterResult { ok: boolean; removed: boolean; backupPath?: string; settingsBackupPath?: string; error?: string; }
export interface RepairResult { ok: boolean; repaired: boolean; error?: string; }

/** Resolve the platform default user MCP-config path (~/.claude.json). */
export function defaultClaudeConfigPath(): string {
  if (process.env.CLAUDE_CONFIG_PATH) return process.env.CLAUDE_CONFIG_PATH;
  const baseDir = process.env.CLAUDE_CONFIG_DIR ?? os.homedir();
  return path.join(baseDir, '.claude.json');
}
/** Resolve the platform default user SETTINGS path (~/.claude/settings.json) — the
 *  file Claude Code actually reads HOOKS from. */
export function defaultClaudeSettingsPath(): string {
  if (process.env.CLAUDE_SETTINGS_PATH) return process.env.CLAUDE_SETTINGS_PATH;
  const baseDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  // When CLAUDE_CONFIG_DIR is set, settings.json lives in that dir; else ~/.claude.
  return path.join(baseDir, 'settings.json');
}

/** Derive the settings path for an options object (explicit, else next to config). */
function settingsPathFor(o: UserScopeOptions): string {
  if (o.settingsPath) return o.settingsPath;
  // Default: a sibling `.claude/settings.json` of the config file's directory if the
  // config is the canonical ~/.claude.json; otherwise just defaultClaudeSettingsPath.
  return defaultClaudeSettingsPath();
}

function readJson<T>(p: string): T | null {
  try { if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')) as T; }
  catch { return null; }
}
export function readClaudeConfig(configPath: string): ClaudeConfig | null { return readJson<ClaudeConfig>(configPath); }
export function readClaudeSettings(settingsPath: string): ClaudeSettings | null { return readJson<ClaudeSettings>(settingsPath); }

/** Our canonical MCP server entry. */
function xbusMcpEntry(o: UserScopeOptions): McpServerEntry {
  return { type: 'stdio', command: o.nodePath, args: [o.serverEntry], env: { XBUS_DATA_DIR: o.dataDir }, [XBUS_OWNER_TAG]: o.installId };
}

/**
 * Registration-idempotency identity rule (ADR 0012 D2/D7): an existing XBus MCP entry is
 * "materially identical" to the canonical one iff its IDENTITY-BEARING fields match —
 * `command` (the node executable), `args` (the server entry), and `env` (which carries
 * XBUS_DATA_DIR). If ANY differs (e.g. the data dir moved, node moved), the entry must be
 * rewritten, not short-circuited as already-registered. The `env` comparison is CANONICAL:
 *   • order-independent (keys sorted) — object-key order is not identity;
 *   • omitted `env` and an empty `{}` are equivalent (both = "no env");
 *   • values compared exactly (no case/path normalization — env values are literal, and a
 *     changed XBUS_DATA_DIR value MUST be treated as different).
 * Never logs env VALUES (only structural equality is computed here).
 */
function canonicalEnv(env: Record<string, string> | undefined): string {
  const e = env ?? {};
  const keys = Object.keys(e).sort();
  return JSON.stringify(keys.map((k) => [k, e[k]]));
}
function mcpEntryMateriallyEqual(cur: McpServerEntry, canonical: McpServerEntry): boolean {
  return cur.command === canonical.command
    && JSON.stringify(cur.args) === JSON.stringify(canonical.args)
    && canonicalEnv(cur.env) === canonicalEnv(canonical.env);
}
/**
 * The dist entry each event's handler must invoke. SessionStart is only wired when the
 * caller supplied `sessionStartHookEntry` (the installer always does); events with no
 * resolved entry are skipped, so an older caller that omits it simply doesn't register
 * SessionStart rather than misregistering it.
 */
function hookEntries(o: UserScopeOptions): Partial<Record<XbusHookEvent, string>> {
  const m: Partial<Record<XbusHookEvent, string>> = { UserPromptSubmit: o.hookEntry, Stop: o.hookEntry };
  if (o.sessionStartHookEntry) m.SessionStart = o.sessionStartHookEntry;
  return m;
}
/** All XBus-owned entry paths (for the "is this handler ours?" membership test). */
function allXbusEntries(o: UserScopeOptions): string[] {
  const s = new Set<string>([o.hookEntry]);
  if (o.sessionStartHookEntry) s.add(o.sessionStartHookEntry);
  return [...s];
}
/** Our canonical hook handler for a SPECIFIC event's entry (EXEC form — no shell). */
function xbusHookHandlerFor(o: UserScopeOptions, entry: string): HookHandler {
  return { type: 'command', command: o.nodePath, args: [entry], [XBUS_OWNER_TAG]: o.installId };
}
/** Is this hook handler ours (references ANY XBus entry — checkpoint OR session-start)?
 *  Exec form puts the entry in args[]; tolerate a legacy shell-form command string too. */
function isXbusHookHandler(h: HookHandler, o: UserScopeOptions): boolean {
  const entries = allXbusEntries(o);
  if (Array.isArray(h.args) && h.args.some((a) => typeof a === 'string' && entries.includes(a))) return true;
  return typeof h.command === 'string' && entries.some((e) => h.command.includes(e));
}

// ── transactional file helpers ──────────────────────────────────────────────

interface FileTxn { path: string; backup?: string; hadFile: boolean; }

function backupAndWrite(p: string, obj: unknown): FileTxn {
  const hadFile = fs.existsSync(p);
  let backup: string | undefined;
  if (hadFile) { backup = `${p}.xbus-backup-${process.pid}`; fs.copyFileSync(p, backup); }
  else { fs.mkdirSync(path.dirname(p), { recursive: true }); }
  const tmp = `${p}.xbus-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  // Harden the backup too (it can contain other servers' env secrets). Best-effort.
  if (backup) { try { fs.chmodSync(backup, 0o600); } catch { /* ignore */ } }
  return { path: p, ...(backup ? { backup } : {}), hadFile };
}

function rollbackTxn(t: FileTxn | undefined): void {
  if (!t) return;
  try {
    if (t.backup && fs.existsSync(t.backup)) { fs.copyFileSync(t.backup, t.path); fs.rmSync(t.backup, { force: true }); }
    else if (!t.hadFile && fs.existsSync(t.path)) { fs.rmSync(t.path, { force: true }); }
  } catch { /* best effort */ }
}

// ── merge / strip ───────────────────────────────────────────────────────────

function applyMcp(cfg: ClaudeConfig, o: UserScopeOptions): ClaudeConfig {
  const next: ClaudeConfig = { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}) } };
  next.mcpServers![XBUS_MCP_KEY] = xbusMcpEntry(o);
  return next;
}
function applyHooks(s: ClaudeSettings, o: UserScopeOptions): ClaudeSettings {
  const next: ClaudeSettings = { ...s, hooks: { ...(s.hooks ?? {}) } };
  const entries = hookEntries(o);
  for (const ev of XBUS_HOOK_EVENTS) {
    const entry = entries[ev];
    if (entry === undefined) continue; // event we don't wire this install (e.g. SessionStart omitted)
    // Preserve the user's OTHER handlers on this event; drop only prior XBus-owned ones, then
    // append THIS event's dedicated handler (SessionStart → session-start-hook, else checkpoint).
    const groups = (next.hooks![ev] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isXbusHookHandler(h, o)) }))
      .filter((g) => g.hooks.length > 0);
    groups.push({ hooks: [xbusHookHandlerFor(o, entry)] });
    next.hooks![ev] = groups;
  }
  return next;
}
function stripMcp(cfg: ClaudeConfig, o: UserScopeOptions, ownerToMatch: string | null): { cfg: ClaudeConfig; changed: boolean } {
  if (!cfg.mcpServers?.[XBUS_MCP_KEY]) return { cfg, changed: false };
  const owner = cfg.mcpServers[XBUS_MCP_KEY][XBUS_OWNER_TAG] as string | undefined;
  if (ownerToMatch !== null && owner !== ownerToMatch) return { cfg, changed: false };
  const m = { ...cfg.mcpServers }; delete m[XBUS_MCP_KEY];
  // Byte-exact-restore (symmetric with stripHooks): if removing the xbus entry emptied
  // mcpServers, drop the key entirely rather than leaving a residual `mcpServers: {}`. A
  // user whose config had NO mcpServers key before install must get it back verbatim.
  if (Object.keys(m).length === 0) {
    const rest = { ...cfg };
    delete (rest as { mcpServers?: unknown }).mcpServers;
    return { cfg: rest, changed: true };
  }
  return { cfg: { ...cfg, mcpServers: m }, changed: true };
}
function stripHooks(s: ClaudeSettings, o: UserScopeOptions, ownerToMatch: string | null): { settings: ClaudeSettings; changed: boolean } {
  if (!s.hooks) return { settings: s, changed: false };
  let changed = false;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [ev, groups] of Object.entries(s.hooks)) {
    const cleaned = groups.map((g) => ({
      ...g,
      hooks: (g.hooks ?? []).filter((h) => {
        // Remove ONLY a handler that is ours AND (matches the owner, or — for the
        // unowned-legacy case — only when we are doing an unscoped strip). An UNTAGGED
        // handler authored by the USER (even if it references our entry) is preserved
        // on a scoped (installId) uninstall.
        const ours = isXbusHookHandler(h, o);
        const tag = h[XBUS_OWNER_TAG] as string | undefined;
        const remove = ours && (ownerToMatch === null ? true : tag === ownerToMatch);
        if (remove) changed = true;
        return !remove;
      }),
    })).filter((g) => g.hooks.length > 0);
    if (cleaned.length > 0) hooks[ev] = cleaned;
  }
  // Byte-exact-restore: if removing our handlers emptied the hooks map, drop the `hooks`
  // key entirely rather than leaving a residual `hooks: {}`. A user whose settings.json
  // had NO hooks key before install must get it back verbatim (an empty {} changes the
  // file's bytes/SHA and reads as XBus-left-a-trace). Preserve a non-empty map as-is.
  if (Object.keys(hooks).length === 0) {
    const rest = { ...s };
    delete (rest as { hooks?: unknown }).hooks;
    return { settings: rest, changed };
  }
  return { settings: { ...s, hooks }, changed };
}

function defaultValidateConfig(cfg: ClaudeConfig): { ok: boolean; detail: string } {
  return cfg.mcpServers?.[XBUS_MCP_KEY] ? { ok: true, detail: 'ok' } : { ok: false, detail: 'xbus mcp entry missing after write' };
}
/** Validate that every event we WIRE this install has an XBus-owned handler pointing at the
 *  CORRECT entry (SessionStart → session-start-hook.js, UserPromptSubmit/Stop → hook-entry.js).
 *  Events not wired this install (e.g. SessionStart when the caller omitted its entry) are not
 *  required — but a wired event pointing at the WRONG entry fails validation. */
function makeValidateSettings(o: UserScopeOptions): (s: ClaudeSettings) => { ok: boolean; detail: string } {
  const entries = hookEntries(o);
  return (s: ClaudeSettings) => {
    for (const ev of XBUS_HOOK_EVENTS) {
      const entry = entries[ev];
      if (entry === undefined) continue;
      const present = (s.hooks?.[ev] ?? []).some((g) => g.hooks.some((h) =>
        h[XBUS_OWNER_TAG] !== undefined && Array.isArray(h.args) && h.args.includes(entry)));
      if (!present) return { ok: false, detail: `xbus ${ev} handler missing/mispointed after write (expected ${entry})` };
    }
    return { ok: true, detail: 'ok' };
  };
}

/** Register XBus into the user MCP config + settings (two files, transactional). */
export function registerUserScope(o: UserScopeOptions): RegisterResult {
  const settingsPath = settingsPathFor(o);
  const cfg = readClaudeConfig(o.configPath) ?? {};
  const cur = cfg.mcpServers?.[XBUS_MCP_KEY];

  if (cur && cur[XBUS_OWNER_TAG] === undefined && !o.force) {
    return { ok: false, dryRun: !!o.dryRun, error: `the "${XBUS_MCP_KEY}" mcp key is present but not owned by XBus; refusing to overwrite (use force to take it)` };
  }
  const canonical = xbusMcpEntry(o);
  const replacedConflict = !!cur && cur[XBUS_OWNER_TAG] !== undefined && cur[XBUS_OWNER_TAG] !== o.installId;
  // Idempotent: ours, same id, materially-identical entry (command/args/ENV), AND our
  // hooks already present. Including env means a moved data dir (or node path) is NOT
  // mistaken for already-registered — it triggers a rewrite so the entry stays correct.
  const settingsCur = readClaudeSettings(settingsPath) ?? {};
  const wiredEntries = hookEntries(o);
  // Idempotency: every event we WIRE this install already has OUR owned handler pointing at
  // the correct entry. (Events we don't wire — e.g. SessionStart when its entry was omitted —
  // are not required, so an older caller stays idempotent.)
  const hooksPresent = (Object.keys(wiredEntries) as XbusHookEvent[]).every((ev) => {
    const entry = wiredEntries[ev]!;
    return (settingsCur.hooks?.[ev] ?? []).some((g) => g.hooks.some((h) => h[XBUS_OWNER_TAG] === o.installId && Array.isArray(h.args) && h.args.includes(entry)));
  });
  if (cur && cur[XBUS_OWNER_TAG] === o.installId && mcpEntryMateriallyEqual(cur, canonical) && hooksPresent) {
    return { ok: true, dryRun: !!o.dryRun, alreadyRegistered: true };
  }

  if (o.dryRun) return { ok: true, dryRun: true, ...(replacedConflict ? { replacedConflict } : {}) };

  let cfgTxn: FileTxn | undefined;
  let setTxn: FileTxn | undefined;
  try {
    cfgTxn = backupAndWrite(o.configPath, applyMcp(cfg, o));
    const vCfg = (o.validateConfig ?? defaultValidateConfig)(readClaudeConfig(o.configPath) ?? {});
    if (!vCfg.ok) { rollbackTxn(cfgTxn); return { ok: false, dryRun: false, rolledBack: true, error: `mcp config validation failed: ${vCfg.detail}` }; }

    setTxn = backupAndWrite(settingsPath, applyHooks(settingsCur, o));
    const vSet = (o.validateSettings ?? makeValidateSettings(o))(readClaudeSettings(settingsPath) ?? {});
    if (!vSet.ok) { rollbackTxn(setTxn); rollbackTxn(cfgTxn); return { ok: false, dryRun: false, rolledBack: true, error: `settings/hooks validation failed: ${vSet.detail}` }; }

    const result: RegisterResult = { ok: true, dryRun: false };
    if (cfgTxn.backup) result.backupPath = cfgTxn.backup;
    if (setTxn.backup) result.settingsBackupPath = setTxn.backup;
    if (replacedConflict) result.replacedConflict = true;
    return result;
  } catch (e) {
    rollbackTxn(setTxn); rollbackTxn(cfgTxn);
    return { ok: false, dryRun: false, rolledBack: true, error: (e as Error).message };
  }
}

/** Remove ONLY the XBus entries this install owns, from BOTH files. */
export function unregisterUserScope(o: UserScopeOptions): UnregisterResult {
  const settingsPath = settingsPathFor(o);
  const cfg = readClaudeConfig(o.configPath);
  const settings = readClaudeSettings(settingsPath);
  const mcp = cfg ? stripMcp(cfg, o, o.installId) : { cfg: null as ClaudeConfig | null, changed: false };
  const hk = settings ? stripHooks(settings, o, o.installId) : { settings: null as ClaudeSettings | null, changed: false };
  if (!mcp.changed && !hk.changed) return { ok: true, removed: false };
  if (o.dryRun) return { ok: true, removed: true };
  let cfgTxn: FileTxn | undefined; let setTxn: FileTxn | undefined;
  try {
    if (mcp.changed && mcp.cfg) cfgTxn = backupAndWrite(o.configPath, mcp.cfg);
    if (hk.changed && hk.settings) setTxn = backupAndWrite(settingsPath, hk.settings);
    const result: UnregisterResult = { ok: true, removed: true };
    if (cfgTxn?.backup) result.backupPath = cfgTxn.backup;
    if (setTxn?.backup) result.settingsBackupPath = setTxn.backup;
    return result;
  } catch (e) {
    rollbackTxn(setTxn); rollbackTxn(cfgTxn);
    return { ok: false, removed: false, error: (e as Error).message };
  }
}

/** Re-apply the canonical XBus entries (fixes drift). Force-takes our own key. */
export function repairUserScope(o: UserScopeOptions): RepairResult {
  const r = registerUserScope({ ...o, force: true });
  if (!r.ok) return { ok: false, repaired: false, ...(r.error ? { error: r.error } : {}) };
  return { ok: true, repaired: !r.alreadyRegistered };
}
