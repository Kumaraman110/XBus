/**
 * resolveClaudeExecutable — Windows Claude lookup. Root cause it fixes: the
 * launcher defaulted to the bare token `claude` and only routed through cmd.exe
 * when that token already ended in .cmd/.bat, so Node's non-shell spawn raised
 * ENOENT even though npm's `claude.cmd` was on PATH.
 *
 * These tests inject the PATH lookup (no real `where.exe`, no spawning) so the
 * selection logic is deterministic and platform-independent under test.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveClaudeExecutable, isResolved } from '../../src/launcher/resolve-claude.js';

/** A lookup backed by a fixed name->paths map (simulates where.exe / which). */
function fakeLookup(map: Record<string, string[]>) {
  return (name: string) => map[name] ?? [];
}

/** Create real files on disk so the resolver's fs.existsSync checks pass. */
function tmpFiles(names: string[]): { dir: string; paths: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-resolve-'));
  const paths: Record<string, string> = {};
  for (const n of names) {
    const p = path.join(dir, n);
    fs.writeFileSync(p, 'fake');
    paths[n] = p;
  }
  return { dir, paths };
}

describe('resolveClaudeExecutable — Windows', () => {
  it('1. npm-installed Claude: picks claude.cmd (cmd launch) over .ps1 and extensionless', () => {
    const { dir, paths } = tmpFiles(['claude.ps1', 'claude.cmd', 'claude']);
    try {
      const r = resolveClaudeExecutable({
        platform: 'win32', env: {},
        lookup: fakeLookup({
          'claude.cmd': [paths['claude.cmd']!],
          'claude': [paths['claude']!, paths['claude.cmd']!], // where.exe "claude" returns both
        }),
      });
      expect(isResolved(r)).toBe(true);
      if (isResolved(r)) {
        expect(r.execPath).toBe(paths['claude.cmd']);
        expect(r.launchVia).toBe('cmd');
        expect(r.source).toBe('path');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('2. explicit override wins and no PATH lookup is consulted', () => {
    const { dir, paths } = tmpFiles(['my-claude.cmd']);
    let lookupCalls = 0;
    try {
      const r = resolveClaudeExecutable({
        platform: 'win32', explicitPath: paths['my-claude.cmd'], env: {},
        lookup: () => { lookupCalls++; return []; },
      });
      expect(isResolved(r)).toBe(true);
      if (isResolved(r)) { expect(r.source).toBe('explicit'); expect(r.launchVia).toBe('cmd'); expect(r.execPath).toBe(paths['my-claude.cmd']); }
      expect(lookupCalls).toBe(0); // override short-circuits PATH lookup
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('2b. explicit override that does not exist fails closed with an actionable message', () => {
    const r = resolveClaudeExecutable({ platform: 'win32', explicitPath: 'C:\\nope\\claude.cmd', env: {} });
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) expect(r.message).toMatch(/CLAUDE_CODE_EXECPATH/);
  });

  it('3. native executable: claude.exe selected with direct spawn', () => {
    const { dir, paths } = tmpFiles(['claude.exe']);
    try {
      const r = resolveClaudeExecutable({
        platform: 'win32', env: {},
        lookup: fakeLookup({ 'claude.exe': [paths['claude.exe']!] }),
      });
      expect(isResolved(r)).toBe(true);
      if (isResolved(r)) { expect(r.execPath).toBe(paths['claude.exe']); expect(r.launchVia).toBe('direct'); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('4. missing Claude: fails closed, message names the lookup strategy + attempts', () => {
    const r = resolveClaudeExecutable({ platform: 'win32', env: {}, lookup: fakeLookup({}) });
    expect(isResolved(r)).toBe(false);
    if (!isResolved(r)) {
      expect(r.message).toMatch(/where\.exe/);
      expect(r.attempted).toEqual(['claude.cmd', 'claude.exe', 'claude.bat', 'claude']);
    }
  });

  it('5. never selects claude.ps1 even if it is the only where.exe hit for "claude"', () => {
    const { dir, paths } = tmpFiles(['claude.ps1']);
    try {
      const r = resolveClaudeExecutable({
        platform: 'win32', env: {},
        // where.exe "claude" returns ONLY the .ps1 (no .cmd present)
        lookup: fakeLookup({ 'claude': [paths['claude.ps1']!] }),
      });
      // The .ps1 hit's basename != "claude" so it is skipped; nothing launchable.
      expect(isResolved(r)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('6. multiple candidates: deterministic order cmd > exe > bat > extensionless', () => {
    const { dir, paths } = tmpFiles(['claude.cmd', 'claude.exe', 'claude.bat', 'claude']);
    try {
      const r = resolveClaudeExecutable({
        platform: 'win32', env: {},
        lookup: fakeLookup({
          'claude.cmd': [paths['claude.cmd']!],
          'claude.exe': [paths['claude.exe']!],
          'claude.bat': [paths['claude.bat']!],
          'claude': [paths['claude']!],
        }),
      });
      expect(isResolved(r)).toBe(true);
      if (isResolved(r)) expect(r.execPath).toBe(paths['claude.cmd']); // .cmd wins
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('6b. when only .exe and extensionless exist, .exe wins (direct)', () => {
    const { dir, paths } = tmpFiles(['claude.exe', 'claude']);
    try {
      const r = resolveClaudeExecutable({
        platform: 'win32', env: {},
        lookup: fakeLookup({ 'claude.exe': [paths['claude.exe']!], 'claude': [paths['claude']!] }),
      });
      expect(isResolved(r)).toBe(true);
      if (isResolved(r)) { expect(r.execPath).toBe(paths['claude.exe']); expect(r.launchVia).toBe('direct'); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a where.exe hit that no longer exists on disk is skipped', () => {
    const r = resolveClaudeExecutable({
      platform: 'win32', env: {},
      lookup: fakeLookup({ 'claude.cmd': ['C:\\stale\\claude.cmd'] }), // not on disk
    });
    expect(isResolved(r)).toBe(false);
  });
});

describe('resolveClaudeExecutable — POSIX', () => {
  it('resolves claude on PATH with direct spawn', () => {
    const { dir, paths } = tmpFiles(['claude']);
    try {
      const r = resolveClaudeExecutable({ platform: 'linux', env: {}, lookup: fakeLookup({ 'claude': [paths['claude']!] }) });
      expect(isResolved(r)).toBe(true);
      if (isResolved(r)) { expect(r.execPath).toBe(paths['claude']); expect(r.launchVia).toBe('direct'); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('missing claude fails closed (POSIX)', () => {
    const r = resolveClaudeExecutable({ platform: 'linux', env: {}, lookup: fakeLookup({}) });
    expect(isResolved(r)).toBe(false);
  });

  it('explicit override wins on POSIX too', () => {
    const { dir, paths } = tmpFiles(['claude']);
    try {
      const r = resolveClaudeExecutable({ platform: 'linux', explicitPath: paths['claude'], env: {} });
      expect(isResolved(r)).toBe(true);
      if (isResolved(r)) expect(r.source).toBe('explicit');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
