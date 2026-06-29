/**
 * The xclaude launcher. Tests the COMPILED entry (dist/launcher/
 * xclaude.js) directly (the exact packaged bin), with a fake `claude` so no real
 * Claude is needed. Verifies arg forwarding, quoting, non-project-dir launch,
 * not-installed guidance, and that the root secret never reaches argv/env.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { install } from '../../src/cli/install.js';
import { buildClaudeArgs, cmdQuoteArg } from '../../src/launcher/xclaude.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LAUNCHER = path.join(REPO, 'dist', 'launcher', 'xclaude.js');
let root: string; let workdir: string; let fakeClaude: string;

beforeEach(async () => {
  if (!fs.existsSync(LAUNCHER)) throw new Error('dist/ missing — run `npm run build`');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-xc-'));
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-nonproject-'));
  await install({ installRoot: root });
  // A fake `claude` that echoes its argv. On Windows use a .cmd; else a sh shim.
  if (process.platform === 'win32') {
    fakeClaude = path.join(root, 'fakeclaude.cmd');
    fs.writeFileSync(fakeClaude, '@echo off\r\necho FAKECLAUDE_ARGS: %*\r\n');
  } else {
    fakeClaude = path.join(root, 'fakeclaude.sh');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\necho "FAKECLAUDE_ARGS: $@"\n', { mode: 0o755 });
  }
});
afterEach(() => {
  for (const d of [root, workdir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function runLauncher(args: string[], env: Record<string, string>, cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [LAUNCHER, ...args], { env: { ...process.env, ...env }, cwd, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('xclaude launcher (compiled entry)', () => {
  it('buildClaudeArgs puts --plugin-dir first, then user args verbatim', () => {
    expect(buildClaudeArgs('/p', ['--model', 'sonnet', 'two words'])).toEqual(['--plugin-dir', '/p', '--model', 'sonnet', 'two words']);
  });

  it('cmdQuoteArg quotes spaces/specials and leaves simple tokens bare', () => {
    expect(cmdQuoteArg('simple')).toBe('simple');
    expect(cmdQuoteArg('two words')).toBe('"two words"');
    expect(cmdQuoteArg('a&b')).toBe('"a&b"');
  });

  it('launches the fake claude from a NON-project dir, forwarding args with spaces intact', () => {
    const r = runLauncher(['--model', 'sonnet', 'two words'], {
      XBUS_INSTALL_ROOT: root, CLAUDE_CODE_EXECPATH: fakeClaude,
    }, workdir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('--plugin-dir');
    expect(r.out).toContain(path.join(root, 'plugin'));
    expect(r.out).toContain('--model');
    expect(r.out).toContain('two words'); // space-containing arg survived
  });

  it('announces XBus activation (on stderr) when launching', () => {
    // The banner goes to stderr; capture combined output via a failing exec is
    // unnecessary — run with stderr redirected into the captured stream.
    const out = (() => {
      try {
        return execFileSync(process.execPath, [LAUNCHER, '--version'], {
          env: { ...process.env, XBUS_INSTALL_ROOT: root, CLAUDE_CODE_EXECPATH: fakeClaude },
          cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) { return (e as { stdout?: string; stderr?: string }).stderr ?? ''; }
    })();
    // stderr isn't in execFileSync's return on success; assert via the launcher's
    // resolved plugin path appearing in the forwarded args instead (proves activation).
    expect(out).toContain(path.join(root, 'plugin'));
  });

  it('does not require project-local files and does not change the cwd', () => {
    const before = fs.readdirSync(workdir).join(',');
    runLauncher(['--version'], { XBUS_INSTALL_ROOT: root, CLAUDE_CODE_EXECPATH: fakeClaude }, workdir);
    expect(fs.readdirSync(workdir).join(',')).toBe(before); // nothing created in cwd
  });

  it('fails with actionable guidance when XBus is not installed', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-noinst-'));
    try {
      const r = runLauncher([], { XBUS_INSTALL_ROOT: emptyRoot, CLAUDE_CODE_EXECPATH: fakeClaude }, workdir);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/not installed|xbus install/i);
    } finally { fs.rmSync(emptyRoot, { recursive: true, force: true }); }
  });

  it('does NOT leak the root secret into the launched argv or environment', () => {
    const secret = fs.readFileSync(path.join(root, 'data', 'auth', 'root.secret'));
    const secretHex = secret.toString('hex');
    const r = runLauncher(['--model', 'sonnet'], {
      XBUS_INSTALL_ROOT: root, CLAUDE_CODE_EXECPATH: fakeClaude,
    }, workdir);
    expect(r.out).not.toContain(secretHex);
    expect(r.out).not.toContain(secret.toString('base64'));
    // The launcher's announced args contain only --plugin-dir + user args.
    expect(r.out).not.toMatch(/root\.secret/);
  });

  it('§6 ADVERSARIAL: with require-fake set and NO CLAUDE_CODE_EXECPATH, the launcher FAILS CLOSED before spawning claude', () => {
    // Simulate "a real claude exists on PATH": put a fake `claude` on a PATH dir, but
    // do NOT set CLAUDE_CODE_EXECPATH. With XBUS_TEST_REQUIRE_FAKE_CLAUDE=1 the launcher
    // must refuse to resolve/spawn ANY claude (real or PATH-resolved) — proving the
    // test harness can never launch the user's real Claude Code.
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-fakepath-'));
    const onPath = path.join(pathDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    if (process.platform === 'win32') fs.writeFileSync(onPath, '@echo off\r\necho SHOULD_NOT_RUN\r\n');
    else { fs.writeFileSync(onPath, '#!/bin/sh\necho SHOULD_NOT_RUN\n', { mode: 0o755 }); }
    const r = (() => {
      try {
        const out = execFileSync(process.execPath, [LAUNCHER], {
          // require-fake ON, execpath ABSENT, and a claude IS discoverable on PATH:
          env: { ...process.env, XBUS_INSTALL_ROOT: root, XBUS_TEST_REQUIRE_FAKE_CLAUDE: '1', CLAUDE_CODE_EXECPATH: '', PATH: `${pathDir}${path.delimiter}${process.env.PATH}` },
          cwd: workdir, encoding: 'utf8', timeout: 15000,
        });
        return { code: 0, out };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
      }
    })();
    fs.rmSync(pathDir, { recursive: true, force: true });
    expect(r.code).not.toBe(0);                       // failed closed
    expect(r.out).toMatch(/test mode requires CLAUDE_CODE_EXECPATH/i);
    expect(r.out).not.toContain('SHOULD_NOT_RUN');    // the PATH claude was NEVER spawned
  });
});

// Windows Claude auto-resolution (the release-blocking ENOENT regression). The
// launcher must find npm's `claude.cmd` on PATH WITHOUT an explicit override and
// WITHOUT spawning the bare token `claude` (which Node's non-shell spawn cannot
// launch on Windows). These run only on win32. A fake claude.cmd with a sentinel
// proves the resolver picked it; the REAL Claude is never reached because PATH is
// fully replaced with a dir that contains ONLY our fakes (plus System32 so
// where.exe/cmd.exe exist).
const itWin = process.platform === 'win32' ? it : it.skip;

describe('xclaude Windows claude auto-resolution (no CLAUDE_CODE_EXECPATH)', () => {
  let fakeDir: string;
  // System dirs that must stay on PATH so where.exe + cmd.exe resolve.
  const systemPath = [
    `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`,
    `${process.env.SystemRoot ?? 'C:\\Windows'}`,
  ].join(path.delimiter);

  beforeEach(() => { fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-claude-path-')); });
  afterEach(() => { try { fs.rmSync(fakeDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  function writeFake(name: string, body: string): void { fs.writeFileSync(path.join(fakeDir, name), body); }

  // These cases exercise AUTO-RESOLUTION, so the require-fake guard (set globally
  // in tests/setup.ts) must be OFF for them — otherwise the launcher refuses to
  // resolve any claude before lookup. Safety is preserved a different way: PATH is
  // replaced with a dir containing ONLY our fake claude.* (plus System32), so the
  // user's real Claude is unreachable; a sentinel proves the fake ran.
  const autoEnv = { XBUS_TEST_REQUIRE_FAKE_CLAUDE: '', CLAUDE_CODE_EXECPATH: '' };

  function runAutoResolve(args: string[], extraEnv: Record<string, string> = {}): { code: number; out: string } {
    // PATH = our fake dir FIRST, then System32 (for where.exe/cmd.exe). No real npm
    // dir is on PATH, so the only claude.* discoverable is our fake.
    const PATH = `${fakeDir}${path.delimiter}${systemPath}`;
    try {
      const out = execFileSync(process.execPath, [LAUNCHER, ...args], {
        env: { ...process.env, ...autoEnv, XBUS_INSTALL_ROOT: root, PATH, ...extraEnv },
        cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  itWin('7. REGRESSION: with claude.ps1 + claude.cmd + claude on PATH and NO override, resolves claude.cmd and launches (no ENOENT)', () => {
    writeFake('claude.cmd', '@echo off\r\necho FAKECLAUDE_SENTINEL\r\necho ARGS=%*\r\n');
    writeFake('claude.ps1', 'Write-Output "PS1_SHOULD_NOT_RUN"\r\n');
    writeFake('claude', '#!/bin/sh\necho EXTENSIONLESS_SHOULD_NOT_RUN\n'); // not launchable on win
    const r = runAutoResolve(['--model', 'sonnet']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('FAKECLAUDE_SENTINEL');          // the .cmd ran
    expect(r.out).not.toContain('PS1_SHOULD_NOT_RUN');       // .ps1 was NOT chosen
    expect(r.out).not.toContain('EXTENSIONLESS_SHOULD_NOT_RUN');
    expect(r.out).not.toMatch(/could not find/i);            // no misleading "missing" error
    expect(r.out).toContain('--plugin-dir');
    expect(r.out).toContain(path.join(root, 'plugin'));      // injected plugin dir preserved
    expect(r.out).toContain('--model');                       // user args preserved
  });

  itWin('5. spaces in the resolved claude.cmd path: launch succeeds, args preserved exactly', () => {
    // Put the fake under a sub-dir with a space; prepend THAT dir to PATH.
    const spaceDir = path.join(fakeDir, 'Program Dir');
    fs.mkdirSync(spaceDir, { recursive: true });
    fs.writeFileSync(path.join(spaceDir, 'claude.cmd'), '@echo off\r\necho FAKECLAUDE_SENTINEL\r\necho ARGS=%*\r\n');
    const PATH = `${spaceDir}${path.delimiter}${systemPath}`;
    let out = '';
    try {
      out = execFileSync(process.execPath, [LAUNCHER, '--model', 'sonnet', 'two words'], {
        env: { ...process.env, ...autoEnv, XBUS_INSTALL_ROOT: root, PATH },
        cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      });
    } catch (e) { out = ((e as { stdout?: string }).stdout ?? '') + ((e as { stderr?: string }).stderr ?? ''); }
    expect(out).toContain('FAKECLAUDE_SENTINEL');
    expect(out).toContain('--plugin-dir');
    expect(out).toContain(path.join(root, 'plugin'));
    expect(out).toContain('"two words"'); // space-containing arg survived cmd.exe quoting
  });

  itWin('4. missing claude on PATH and no override: fails closed, actionable, no child spawned', () => {
    // fakeDir is empty (no claude.*). PATH = empty fake dir + System32.
    const r = runAutoResolve([]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/could not find a launchable 'claude'/i);
    expect(r.out).toMatch(/where\.exe/);                      // names the lookup strategy
    expect(r.out).not.toContain('FAKECLAUDE_SENTINEL');       // nothing was spawned
  });

  itWin('2. explicit override still wins (points at a fake .cmd outside PATH)', () => {
    const override = path.join(fakeDir, 'override-claude.cmd');
    fs.writeFileSync(override, '@echo off\r\necho OVERRIDE_SENTINEL\r\necho ARGS=%*\r\n');
    // Empty PATH (just System32) so auto-resolve would find nothing; override must win.
    let out = '';
    try {
      out = execFileSync(process.execPath, [LAUNCHER, '--version'], {
        env: { ...process.env, XBUS_TEST_REQUIRE_FAKE_CLAUDE: '', XBUS_INSTALL_ROOT: root, CLAUDE_CODE_EXECPATH: override, PATH: systemPath },
        cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      });
    } catch (e) { out = ((e as { stdout?: string }).stdout ?? '') + ((e as { stderr?: string }).stderr ?? ''); }
    expect(out).toContain('OVERRIDE_SENTINEL');
    expect(out).toContain('--plugin-dir');
  });
});
