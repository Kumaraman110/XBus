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
  const winHook = 'C:\\Users\\v\\.claude\\xbus-install\\plugin\\dist\\channel\\hook-entry.js';
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
