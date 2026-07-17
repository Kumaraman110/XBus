/**
 * Beta.9 (ADR 0029): the release-asset installer (`install.ps1`) must be BUNDLED-RUNTIME-FIRST and
 * verify the bundled runtime's SHA-256 against SHA256SUMS before executing it. These tests drive
 * the SHIPPED `install.ps1` (repo root, copied verbatim into the release ZIP) via PowerShell against
 * synthetic release-shaped fixtures, with an isolated USERPROFILE/HOME/install-root/data-dir. They
 * never touch real user data or a live broker.
 *
 * The fixture is a minimal release layout: runtime/node.exe (a real Node copy, so it can run a stub
 * CLI), dist/cli/main.js (a tiny stub that records how it was invoked), and a correct SHA256SUMS —
 * so the installer's runtime RESOLUTION + INTEGRITY behavior is tested deterministically without a
 * full 89 MB package build. Windows-only (PowerShell + install.ps1).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALL_PS1 = path.join(REPO, 'install.ps1');
const isWin = process.platform === 'win32';
const pwsh = 'powershell'; // Windows PowerShell is always present on Windows runners.

function sha256(file: string): string { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

/** Build a synthetic release fixture. `withBundled` copies a real node into runtime/node.exe (so it
 *  can execute the stub CLI); `sums` controls whether/what SHA256SUMS says for runtime/node.exe. */
function makeFixture(opts: { withBundled: boolean; tamper?: boolean; sumsEntry?: 'correct' | 'wrong' | 'missing' | 'noFile' }): { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentel-inst-'));
  fs.copyFileSync(INSTALL_PS1, path.join(dir, 'install.ps1'));
  // Stub CLI: records argv + a marker into a file next to it, so the test can assert HOW it ran.
  fs.mkdirSync(path.join(dir, 'dist', 'cli'), { recursive: true });
  const marker = path.join(dir, 'cli-invoked.json');
  fs.writeFileSync(path.join(dir, 'dist', 'cli', 'main.js'),
    `import fs from 'node:fs';\n` +
    `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(2), nodeVersion: process.version }));\n` +
    `process.exit(0);\n`);
  fs.mkdirSync(path.join(dir, 'dist', 'launcher'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'launcher', 'xclaude.js'), 'process.exit(0);\n');

  const sumsLines: string[] = [];
  if (opts.withBundled) {
    fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
    const nodeExe = path.join(dir, 'runtime', 'node.exe');
    fs.copyFileSync(process.execPath, nodeExe); // a REAL, runnable node
    // The SHA256SUMS entry must reflect the ORIGINAL (untampered) bytes so a tamper is DETECTED.
    const originalHash = sha256(nodeExe);
    if (opts.tamper) {
      // Corrupt the PE header (first bytes) so the file both mismatches its hash AND cannot execute
      // — flipping a trailing byte of a large PE may leave it runnable, which would not test the
      // integrity gate. Integrity verification must reject it before any execution attempt anyway.
      const b = fs.readFileSync(nodeExe); b[0] ^= 0xff; b[1] ^= 0xff; fs.writeFileSync(nodeExe, b);
    }
    // SHA256SUMS entry for runtime/node.exe.
    const entryMode = opts.sumsEntry ?? 'correct';
    if (entryMode !== 'missing' && entryMode !== 'noFile') {
      const hash = entryMode === 'wrong' ? '0'.repeat(64) : originalHash;
      sumsLines.push(`${hash}  runtime/node.exe`);
    }
    if (entryMode !== 'noFile') {
      sumsLines.push(`${sha256(path.join(dir, 'dist', 'cli', 'main.js'))}  dist/cli/main.js`);
      fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sumsLines.sort().join('\n') + '\n');
    }
    // 'noFile' → intentionally no SHA256SUMS at all.
  }
  return { dir, marker } as { dir: string };
}

/** Run install.ps1 in `dir` with an isolated env. `pathHasNode` controls whether a Node dir is on PATH. */
function runInstall(dir: string, opts: { dryRun?: boolean; nodeOnPath?: string | null } = {}): { code: number; out: string; marker: string } {
  const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentel-home-'));
  // Isolated PATH: System32 (for cmd/powershell internals) plus optionally a node dir.
  const sys32 = path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32');
  const winDir = process.env.SYSTEMROOT || 'C:\\Windows';
  const parts = [sys32, winDir, path.join(sys32, 'WindowsPowerShell', 'v1.0')];
  if (opts.nodeOnPath) parts.unshift(opts.nodeOnPath);
  const env: Record<string, string> = {
    SYSTEMROOT: winDir, USERPROFILE: isoHome, HOME: isoHome,
    XBUS_INSTALL_ROOT: path.join(isoHome, 'install-root'), XBUS_DATA_DIR: path.join(isoHome, 'data'),
    PATH: parts.join(path.delimiter), Path: parts.join(path.delimiter),
    // PATHEXT is REQUIRED for `Get-Command node` to resolve node.exe (PATH fallback path); without
    // it PowerShell won't append .exe and would report node missing even when it's on PATH.
    PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1',
    TEMP: process.env.TEMP || isoHome, TMP: process.env.TMP || isoHome,
  };
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'install.ps1')];
  if (opts.dryRun) args.push('-DryRun');
  const r = spawnSync(pwsh, args, { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || ''), marker: path.join(dir, 'cli-invoked.json') };
}

const dirs: string[] = [];
function track<T extends { dir: string }>(f: T): T { dirs.push(f.dir); return f; }
afterEach(() => { for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

describe.runIf(isWin)('bundled release installer (install.ps1)', () => {
  it('[1] bundled artifact dry-runs with NO Node on PATH', () => {
    const fx = track(makeFixture({ withBundled: true }));
    const r = runInstall(fx.dir, { dryRun: true, nodeOnPath: null });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/runtime source: bundled/);
    expect(r.out).toMatch(/dry-run/);
    const rec = JSON.parse(fs.readFileSync(r.marker, 'utf8'));
    expect(rec.argv).toEqual(['install', '--dry-run']);
  });

  it('[2] a Node on PATH is IGNORED when runtime/node.exe exists (bundled wins)', () => {
    const fx = track(makeFixture({ withBundled: true }));
    // Put the current Node's dir on PATH — the installer must STILL use the bundled runtime.
    const r = runInstall(fx.dir, { dryRun: true, nodeOnPath: path.dirname(process.execPath) });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/runtime source: bundled/);
    const rec = JSON.parse(fs.readFileSync(r.marker, 'utf8'));
    // The stub records its OWN execPath = the runtime that launched it = the bundled one.
    expect(path.normalize(rec.execPath).toLowerCase()).toBe(path.normalize(path.join(fx.dir, 'runtime', 'node.exe')).toLowerCase());
  });

  it('[3] the installer invokes the bundled runtime by ABSOLUTE path', () => {
    const fx = track(makeFixture({ withBundled: true }));
    const r = runInstall(fx.dir, { dryRun: true, nodeOnPath: null });
    expect(r.code, r.out).toBe(0);
    const bundled = path.normalize(path.join(fx.dir, 'runtime', 'node.exe'));
    expect(r.out).toContain(bundled);                    // printed absolute runtime path
    const rec = JSON.parse(fs.readFileSync(r.marker, 'utf8'));
    expect(path.normalize(rec.execPath).toLowerCase()).toBe(bundled.toLowerCase());
  });

  it('[4] a TAMPERED bundled runtime fails BEFORE execution (never runs it, never falls back)', () => {
    const fx = track(makeFixture({ withBundled: true, tamper: true }));
    const r = runInstall(fx.dir, { dryRun: true, nodeOnPath: path.dirname(process.execPath) });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/integrity|does not match|tampered|corrupt/i);
    // The stub CLI must NOT have run (no marker written) — verification blocked execution.
    expect(fs.existsSync(r.marker)).toBe(false);
    // And it did NOT silently fall back to the PATH Node.
    expect(r.out).not.toMatch(/runtime source: path-fallback/);
  });

  it('[4b] a MISSING SHA256SUMS entry for the runtime fails closed (no execution)', () => {
    const fx = track(makeFixture({ withBundled: true, sumsEntry: 'missing' }));
    const r = runInstall(fx.dir, { dryRun: true, nodeOnPath: null });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/SHA256SUMS|unverified|entry for runtime/i);
    expect(fs.existsSync(r.marker)).toBe(false);
  });

  it('[5] missing runtime/node.exe uses a complete supported Node 22/24 on PATH (source-checkout fallback)', () => {
    // Only meaningful when THIS Node is in-floor (the harness Node). Skip if not.
    const inFloor = /^v(22\.(1[3-9]|[2-9]\d)|2[34]\.)/.test(process.version);
    const fx = track(makeFixture({ withBundled: false }));
    const r = runInstall(fx.dir, { dryRun: true, nodeOnPath: path.dirname(process.execPath) });
    if (inFloor) {
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/runtime source: path-fallback/);
    } else {
      // An out-of-floor PATH Node (e.g. 25) must be refused with remediation, not used.
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/supported floor|Node 22|release ZIP/i);
    }
  });

  it('[6] missing bundled runtime AND no Node on PATH fails with actionable remediation', () => {
    const fx = track(makeFixture({ withBundled: false }));
    const r = runInstall(fx.dir, { dryRun: true, nodeOnPath: null });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/no Node on PATH|release ZIP|install Node 22/i);
    expect(fs.existsSync(r.marker)).toBe(false);
  });
});

describe('release-asset documentation (INSTALL.txt)', () => {
  const txt = fs.readFileSync(path.join(REPO, 'INSTALL.txt'), 'utf8');

  it('[7] no longer tells users to install Node, and says the ZIP bundles its own runtime', () => {
    expect(txt).toMatch(/includes its OWN pinned Node runtime|runtime\\node\.exe/i);
    expect(txt).toMatch(/do NOT need to install Node|NOTHING else/i);
    // The old "Node.js >= 22.13 and < 25" hard requirement line must be gone from the user path.
    expect(txt).not.toMatch(/Requirements\s*-+\s*- Windows\.\s*- Node\.js >= 22\.13/);
    expect(txt).toMatch(/\.\\install\.ps1/); // primary install command
    expect(txt).toMatch(/Node 25.*IGNORED|IGNORED.*Node 25/is);
  });

  it('[8] preserves internal compat: xbus-install storage path, xclaude alias, and repo docs pointer', () => {
    expect(txt).toContain('xbus-install');            // on-disk storage path unchanged (upgrade compat)
    expect(txt).toContain('xclaude');                 // launcher alias kept
    expect(txt).toMatch(/AgenTel/);                   // user-facing product wording
  });
});
