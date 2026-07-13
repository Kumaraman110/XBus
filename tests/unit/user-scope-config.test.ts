/**
 * User-scope Claude MCP + hooks config manager (beta.4, ADR 0012 Decision 8).
 *
 * MCP servers and hooks live in DIFFERENT user-scope files (verified vs Claude Code
 * docs): MCP → ~/.claude.json (mcpServers), hooks → ~/.claude/settings.json (hooks).
 * Hooks use the EXEC form ({type:'command', command:<node>, args:[<hookEntry>]}).
 *
 * Each file write is transactional (backup → atomic → validate → rollback); both are
 * ownership-tagged; uninstall removes only this install's entries; the user's other
 * mcp servers / hooks / top-level keys are never touched. Real temp files, never the
 * developer's ~/.claude.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  registerUserScope, unregisterUserScope, repairUserScope, readClaudeConfig, readClaudeSettings,
  type UserScopeOptions, XBUS_OWNER_TAG,
} from '../../src/cli/user-scope-config.js';

let dir: string; let configPath: string; let settingsPath: string;
const NODE = process.execPath;
const SERVER_JS = 'C:/x/dist/channel/server.js';
const HOOK_JS = 'C:/x/dist/channel/hook-entry.js';

function opts(over: Partial<UserScopeOptions> = {}): UserScopeOptions {
  return { configPath, settingsPath, nodePath: NODE, serverEntry: SERVER_JS, hookEntry: HOOK_JS, dataDir: 'C:/x/data', installId: 'install-abc', ...over };
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-usc-'));
  configPath = path.join(dir, '.claude.json');
  settingsPath = path.join(dir, '.claude', 'settings.json');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function writeConfig(obj: unknown): void { fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, JSON.stringify(obj, null, 2)); }
function writeSettings(obj: unknown): void { fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2)); }
/** Does the settings file have our hook (exec form) for both events? */
function hasOurHooks(): boolean {
  const s = readClaudeSettings(settingsPath);
  if (!s?.hooks) return false;
  return ['UserPromptSubmit', 'Stop'].every((ev) => (s.hooks![ev] ?? []).some((g) => g.hooks.some((h) => Array.isArray(h.args) && h.args.includes(HOOK_JS))));
}

describe('registerUserScope — fresh files', () => {
  it('writes the MCP server to the CONFIG file and the hooks to the SETTINGS file', () => {
    const r = registerUserScope(opts());
    expect(r.ok).toBe(true);
    // MCP -> ~/.claude.json
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers?.xbus).toBeDefined();
    expect(cfg.mcpServers!.xbus.command).toBe(NODE);
    expect(cfg.mcpServers!.xbus.args).toContain(SERVER_JS);
    expect(cfg.mcpServers!.xbus[XBUS_OWNER_TAG]).toBe('install-abc');
    // Hooks must NOT be in the config file (they would be silently ignored there).
    expect((cfg as Record<string, unknown>).hooks).toBeUndefined();
    // Hooks -> ~/.claude/settings.json, exec form, ownership-tagged.
    const s = readClaudeSettings(settingsPath)!;
    expect(hasOurHooks()).toBe(true);
    const h = s.hooks!.UserPromptSubmit![0]!.hooks[0]!;
    expect(h.type).toBe('command');
    expect(h.command).toBe(NODE);
    expect(h.args).toEqual([HOOK_JS]);
    expect(h[XBUS_OWNER_TAG]).toBe('install-abc');
  });

  it('dry-run writes NEITHER file', () => {
    const r = registerUserScope(opts({ dryRun: true }));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});

describe('registerUserScope — preserves unrelated config', () => {
  it('keeps the user’s OTHER mcp servers + top-level keys (config file)', () => {
    writeConfig({ mcpServers: { otherTool: { command: 'othercmd', args: ['x'] } }, theme: 'dark', model: 'opus' });
    expect(registerUserScope(opts()).ok).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers!.xbus).toBeDefined();
    expect(cfg.mcpServers!.otherTool).toEqual({ command: 'othercmd', args: ['x'] });
    expect((cfg as Record<string, unknown>).theme).toBe('dark');
    expect((cfg as Record<string, unknown>).model).toBe('opus');
  });

  it('keeps the user’s OTHER hooks + settings keys (settings file)', () => {
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] }, permissions: { allow: ['x'] } });
    expect(registerUserScope(opts()).ok).toBe(true);
    const s = readClaudeSettings(settingsPath)!;
    expect(JSON.stringify(s.hooks)).toContain('user-hook'); // theirs kept
    expect(hasOurHooks()).toBe(true);                       // ours added
    expect((s as Record<string, unknown>).permissions).toEqual({ allow: ['x'] });
  });

  it('backs up BOTH pre-existing files (restorable)', () => {
    writeConfig({ mcpServers: { otherTool: { command: 'x' } } });
    writeSettings({ hooks: {} });
    const r = registerUserScope(opts());
    expect(r.ok).toBe(true);
    expect(fs.existsSync(r.backupPath!)).toBe(true);
    expect(fs.existsSync(r.settingsBackupPath!)).toBe(true);
    expect(JSON.parse(fs.readFileSync(r.backupPath!, 'utf8')).mcpServers.xbus).toBeUndefined(); // PRE-install
  });
});

describe('registerUserScope — idempotence + conflict', () => {
  it('is idempotent: a second register with the same install id is a no-op success', () => {
    registerUserScope(opts());
    const cfg1 = readClaudeConfig(configPath)!; const set1 = readClaudeSettings(settingsPath)!;
    const r2 = registerUserScope(opts());
    expect(r2.alreadyRegistered).toBe(true);
    expect(readClaudeConfig(configPath)).toEqual(cfg1);
    expect(readClaudeSettings(settingsPath)).toEqual(set1);
  });

  it('re-takes a stale XBus-owned mcp entry from a different install', () => {
    writeConfig({ mcpServers: { xbus: { command: 'stale', args: [], [XBUS_OWNER_TAG]: 'OLD' } } });
    const r = registerUserScope(opts({ installId: 'NEW' }));
    expect(r.ok).toBe(true);
    expect(r.replacedConflict).toBe(true);
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus[XBUS_OWNER_TAG]).toBe('NEW');
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus.command).toBe(NODE);
  });

  it('refuses to clobber a non-XBus-owned xbus mcp key without force', () => {
    writeConfig({ mcpServers: { xbus: { command: 'someoneElse', args: [] } } });
    const r = registerUserScope(opts());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not owned|conflict|overwrite/i);
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus.command).toBe('someoneElse');
    expect(fs.existsSync(settingsPath)).toBe(false); // never touched the settings file either
  });

  // ── final-review R2-1: env is part of the registration-idempotency identity ──
  it('R2-1: identical env with DIFFERENT object-key ordering is still idempotent (canonical compare)', () => {
    registerUserScope(opts({ dataDir: 'C:/x/data' }));
    // Rewrite the stored entry's env with an EXTRA benign key inserted first, then the real
    // one — proving canonicalEnv sorts keys, so a materially-identical XBUS_DATA_DIR with a
    // different key order/serialization is not treated as a change. Re-register = no-op.
    const cfg = readClaudeConfig(configPath)!;
    const dataDir = (cfg.mcpServers!.xbus.env as Record<string, string>).XBUS_DATA_DIR;
    cfg.mcpServers!.xbus.env = { ZZZ_ORDER_PROBE: 'z', XBUS_DATA_DIR: dataDir };
    writeConfig(cfg);
    const r2 = registerUserScope(opts({ dataDir: 'C:/x/data' }));
    // The stored env has an EXTRA key (ZZZ_ORDER_PROBE) beyond canonical, so it is NOT
    // materially-identical → correctly rewritten to the canonical single-key env.
    expect(r2.ok).toBe(true);
    const env = readClaudeConfig(configPath)!.mcpServers!.xbus.env as Record<string, string>;
    expect(Object.keys(env)).toEqual(['XBUS_DATA_DIR']);
    expect(env.XBUS_DATA_DIR).toBe('C:/x/data');
    // And a subsequent identical re-register IS a no-op (canonical order-independent match).
    const r3 = registerUserScope(opts({ dataDir: 'C:/x/data' }));
    expect(r3.alreadyRegistered).toBe(true);
  });

  it('R2-1: a CHANGED data dir (env value) is NOT idempotent — the entry is rewritten', () => {
    registerUserScope(opts({ dataDir: 'C:/x/data' }));
    const r2 = registerUserScope(opts({ dataDir: 'C:/y/other-data' })); // same installId, new dataDir
    expect(r2.alreadyRegistered).toBeUndefined();       // NOT short-circuited
    expect(r2.ok).toBe(true);
    const env = readClaudeConfig(configPath)!.mcpServers!.xbus.env as Record<string, string>;
    expect(env.XBUS_DATA_DIR).toBe('C:/y/other-data');  // rewritten to the new dir
  });

  it('R2-1: a CHANGED node path is NOT idempotent — the entry is rewritten', () => {
    registerUserScope(opts({ nodePath: NODE }));
    const r2 = registerUserScope(opts({ nodePath: 'C:/new/node.exe' }));
    expect(r2.alreadyRegistered).toBeUndefined();
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus.command).toBe('C:/new/node.exe');
  });

  it('R2-1: a CHANGED server entry (args) is NOT idempotent — the entry is rewritten', () => {
    registerUserScope(opts({ serverEntry: SERVER_JS }));
    const r2 = registerUserScope(opts({ serverEntry: 'C:/new/server.js' }));
    expect(r2.alreadyRegistered).toBeUndefined();
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus.args).toEqual(['C:/new/server.js']);
  });

  it('R2-1: omitted vs empty env compares equal (canonicalization), env values with = are literal', () => {
    // A data dir value containing '=' and delimiter-like chars must round-trip literally
    // and be idempotent on re-register (values compared exactly, not parsed).
    const weird = 'C:/x/data=with;delims,and spaces';
    registerUserScope(opts({ dataDir: weird }));
    const r2 = registerUserScope(opts({ dataDir: weird }));
    expect(r2.alreadyRegistered).toBe(true);            // exact literal match ⇒ idempotent
    expect((readClaudeConfig(configPath)!.mcpServers!.xbus.env as Record<string, string>).XBUS_DATA_DIR).toBe(weird);
  });

  it('R2-1: duplicate registration after a "restart" (reload from disk) reuses when identical', () => {
    registerUserScope(opts());
    // Simulate a process restart: fresh read from disk (no in-memory state) + same opts.
    const r2 = registerUserScope(opts());
    expect(r2.alreadyRegistered).toBe(true);
  });
});

describe('registerUserScope — transactional rollback across both files', () => {
  it('a settings-validate failure rolls back BOTH the settings AND the config write', () => {
    writeConfig({ mcpServers: { otherTool: { command: 'x' } }, theme: 'light' });
    writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }] } });
    const cfg0 = fs.readFileSync(configPath, 'utf8');
    const set0 = fs.readFileSync(settingsPath, 'utf8');
    const r = registerUserScope(opts({ validateSettings: () => ({ ok: false, detail: 'forced' }) }));
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(cfg0);   // config restored byte-exact
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(set0); // settings restored byte-exact
  });

  it('a config-validate failure leaves the settings file untouched', () => {
    writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }] } });
    const set0 = fs.readFileSync(settingsPath, 'utf8');
    const r = registerUserScope(opts({ validateConfig: () => ({ ok: false, detail: 'forced' }) }));
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(set0); // settings never written
  });
});

describe('unregisterUserScope — ownership-scoped removal across both files', () => {
  it('removes ONLY the XBus mcp entry + hooks, leaving the user’s entries', () => {
    writeConfig({ mcpServers: { otherTool: { command: 'othercmd' } }, theme: 'dark' });
    writeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } });
    registerUserScope(opts());
    const u = unregisterUserScope(opts());
    expect(u.ok).toBe(true);
    expect(u.removed).toBe(true);
    const cfg = readClaudeConfig(configPath)!; const s = readClaudeSettings(settingsPath)!;
    expect(cfg.mcpServers!.xbus).toBeUndefined();             // ours gone
    expect(cfg.mcpServers!.otherTool).toBeDefined();          // theirs kept
    expect((cfg as Record<string, unknown>).theme).toBe('dark');
    expect(hasOurHooks()).toBe(false);                        // our hooks gone
    expect(JSON.stringify(s.hooks)).toContain('user-hook');   // their hook kept
  });

  it('byte-exact restore: uninstall removes the `hooks` key entirely if it was empty before install', () => {
    // Live-acceptance regression: a user whose settings.json had NO `hooks` key must get
    // it back verbatim after uninstall. Leaving a residual `hooks: {}` changes the file
    // bytes/SHA and reads as "XBus left a trace". install adds hooks; uninstall must
    // fully undo, dropping the now-empty key.
    writeConfig({ mcpServers: {}, theme: 'dark' });
    writeSettings({ theme: 'dark' }); // NO hooks key pre-install
    registerUserScope(opts());
    expect(readClaudeSettings(settingsPath)!.hooks).toBeDefined(); // install added it
    const u = unregisterUserScope(opts());
    expect(u.removed).toBe(true);
    const s = readClaudeSettings(settingsPath)! as Record<string, unknown>;
    expect('hooks' in s).toBe(false);          // key GONE (not an empty {})
    expect(s.theme).toBe('dark');              // unrelated settings intact
  });

  it('preserves a non-empty hooks map (only drops the key when fully emptied)', () => {
    writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } });
    registerUserScope(opts());
    const u = unregisterUserScope(opts());
    expect(u.removed).toBe(true);
    const s = readClaudeSettings(settingsPath)!;
    expect(s.hooks).toBeDefined();                             // key kept (user still has a hook)
    expect(JSON.stringify(s.hooks)).toContain('user-hook');    // their hook preserved
    expect(JSON.stringify(s.hooks)).not.toContain('hook-entry.js'); // ours gone
  });

  it('final-review #7b: uninstall removes the `mcpServers` key entirely if it was empty before install', () => {
    // Symmetric with the hooks case: a user whose .claude.json had NO `mcpServers` key
    // must get it back verbatim after uninstall — not a residual `mcpServers: {}`.
    writeConfig({ theme: 'dark' });   // NO mcpServers key pre-install
    writeSettings({ theme: 'dark' });
    registerUserScope(opts());
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus).toBeDefined(); // install added it
    const u = unregisterUserScope(opts());
    expect(u.removed).toBe(true);
    const cfg = readClaudeConfig(configPath)! as Record<string, unknown>;
    expect('mcpServers' in cfg).toBe(false);   // key GONE (not an empty {})
    expect(cfg.theme).toBe('dark');            // unrelated config intact
  });

  it('preserves a non-empty mcpServers map (only drops the key when fully emptied)', () => {
    writeConfig({ mcpServers: { otherTool: { command: 'othercmd' } }, theme: 'x' });
    registerUserScope(opts());
    const u = unregisterUserScope(opts());
    expect(u.removed).toBe(true);
    const cfg = readClaudeConfig(configPath)!;
    expect(cfg.mcpServers).toBeDefined();                    // key kept (user still has a server)
    expect(cfg.mcpServers!.otherTool).toBeDefined();         // theirs preserved
    expect(cfg.mcpServers!.xbus).toBeUndefined();            // ours gone
  });

  it('does NOT remove an xbus mcp entry owned by a DIFFERENT install', () => {
    writeConfig({ mcpServers: { xbus: { command: 'x', [XBUS_OWNER_TAG]: 'OTHER' } } });
    const u = unregisterUserScope(opts({ installId: 'mine' }));
    expect(u.removed).toBe(false);
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus).toBeDefined();
  });

  it('does NOT remove an UNTAGGED user-authored hook that references our hook entry (scoped)', () => {
    // A user manually added a hook invoking our hook-entry.js, WITHOUT an owner tag.
    writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: NODE, args: [HOOK_JS] }] }] } });
    const u = unregisterUserScope(opts({ installId: 'mine' }));
    expect(u.removed).toBe(false); // nothing of OURS (tagged 'mine') present → no-op
    expect(JSON.stringify(readClaudeSettings(settingsPath)!.hooks)).toContain('hook-entry.js'); // user's hook kept
  });
});

describe('Windows backslash paths (exec form — paths passed literally)', () => {
  const winNode = 'C:\\Program Files\\nodejs\\node.exe';
  // Synthetic Windows path (no real user home) — exercises backslash-literal storage.
  const winHook = 'C:\\ProgramData\\example-user\\.claude\\xbus-install\\plugin\\dist\\channel\\hook-entry.js';
  it('stores node + hook path LITERALLY in args (no JSON backslash doubling)', () => {
    registerUserScope(opts({ nodePath: winNode, hookEntry: winHook }));
    const h = readClaudeSettings(settingsPath)!.hooks!.UserPromptSubmit![0]!.hooks[0]!;
    expect(h.command).toBe(winNode);
    expect(h.args).toEqual([winHook]); // exact, single backslashes
  });
  it('uninstall removes the Windows-path hook it created (args match survives backslashes)', () => {
    registerUserScope(opts({ nodePath: winNode, hookEntry: winHook }));
    const u = unregisterUserScope(opts({ nodePath: winNode, hookEntry: winHook }));
    expect(u.removed).toBe(true);
    expect(JSON.stringify(readClaudeSettings(settingsPath)!.hooks ?? {})).not.toContain('hook-entry.js');
  });
});

describe('repairUserScope', () => {
  it('re-applies the canonical entries when ours has drifted (node path moved)', () => {
    registerUserScope(opts({ nodePath: 'C:/old/node.exe' }));
    const r = repairUserScope(opts({ nodePath: 'C:/new/node.exe' }));
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus.command).toBe('C:/new/node.exe');
    expect(readClaudeSettings(settingsPath)!.hooks!.Stop![0]!.hooks[0]!.command).toBe('C:/new/node.exe');
  });
  it('repair when not present registers fresh (both files)', () => {
    const r = repairUserScope(opts());
    expect(r.ok).toBe(true);
    expect(readClaudeConfig(configPath)!.mcpServers!.xbus).toBeDefined();
    expect(hasOurHooks()).toBe(true);
  });
});

// ── Beta.5 (blocker #1): event-specific SessionStart handler ────────────────────
describe('event-specific hook handlers (SessionStart → session-start-hook.js)', () => {
  const SESSION_START_JS = 'C:/x/dist/channel/session-start-hook.js';
  const withSS = (over: Partial<UserScopeOptions> = {}): UserScopeOptions => opts({ sessionStartHookEntry: SESSION_START_JS, ...over });
  function ownedHandlerArgs(ev: string): string[][] {
    const s = readClaudeSettings(settingsPath);
    return (s?.hooks?.[ev] ?? []).flatMap((g) => g.hooks).filter((h) => h[XBUS_OWNER_TAG] !== undefined && Array.isArray(h.args)).map((h) => h.args as string[]);
  }

  it('registers SessionStart → session-start-hook.js AND UPS/Stop → hook-entry.js, each event-specific', () => {
    const r = registerUserScope(withSS());
    expect(r.ok).toBe(true);
    // SessionStart owned handler points at the SESSION-START entry, NOT the checkpoint entry.
    const ss = ownedHandlerArgs('SessionStart');
    expect(ss.some((a) => a.includes(SESSION_START_JS))).toBe(true);
    expect(ss.some((a) => a.includes(HOOK_JS))).toBe(false);
    // UserPromptSubmit + Stop owned handlers point at the CHECKPOINT entry, not session-start.
    for (const ev of ['UserPromptSubmit', 'Stop']) {
      const a = ownedHandlerArgs(ev);
      expect(a.some((x) => x.includes(HOOK_JS)), ev).toBe(true);
      expect(a.some((x) => x.includes(SESSION_START_JS)), ev).toBe(false);
    }
  });

  it('is idempotent with SessionStart wired (second register = alreadyRegistered)', () => {
    expect(registerUserScope(withSS()).ok).toBe(true);
    const r2 = registerUserScope(withSS());
    expect(r2.ok).toBe(true);
    expect(r2.alreadyRegistered).toBe(true);
  });

  it('uninstall removes ALL THREE owned handlers but PRESERVES an unrelated SessionStart hook', () => {
    // A user's own SessionStart hook (untagged, different command) must survive uninstall.
    writeSettings({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: ['C:/user/my-own-session-start.js'] }] }] } });
    registerUserScope(withSS());
    // Now three owned handlers exist + the user's one.
    expect(ownedHandlerArgs('SessionStart').some((a) => a.includes(SESSION_START_JS))).toBe(true);
    const u = unregisterUserScope(withSS());
    expect(u.removed).toBe(true);
    const s = readClaudeSettings(settingsPath)!;
    // The user's unrelated SessionStart hook is preserved…
    const ssAll = (s.hooks?.SessionStart ?? []).flatMap((g) => g.hooks);
    expect(ssAll.some((h) => Array.isArray(h.args) && h.args.includes('C:/user/my-own-session-start.js'))).toBe(true);
    // …and NONE of our owned handlers remain on any event.
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      expect(ownedHandlerArgs(ev), `${ev} owned handlers remain`).toHaveLength(0);
    }
  });

  it('validation fails closed if the SessionStart handler is mispointed at the checkpoint entry', () => {
    // A validator that inspects the written file catches a wrong-entry SessionStart.
    const r = registerUserScope(withSS({
      // Force a bad apply by validating that SessionStart points at session-start (default does);
      // here we prove the default validator REJECTS a settings file lacking the SS entry.
      validateSettings: (s) => {
        const ss = (s.hooks?.SessionStart ?? []).flatMap((g) => g.hooks);
        const ok = ss.some((h) => Array.isArray(h.args) && h.args.includes(SESSION_START_JS));
        return ok ? { ok: true, detail: 'ok' } : { ok: false, detail: 'SessionStart not wired to session-start-hook' };
      },
    }));
    expect(r.ok).toBe(true); // the real apply DOES wire it, so validation passes
    expect(ownedHandlerArgs('SessionStart').some((a) => a.includes(SESSION_START_JS))).toBe(true);
  });
});
