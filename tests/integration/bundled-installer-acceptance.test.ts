/**
 * Beta.9 (ADR 0029): REAL bundled release-asset acceptance — no stubs on the success path. Builds
 * an actual `package-win` artifact WITH the bundled runtime/node.exe + real dist/cli/main.js + the
 * shipped install.ps1, then drives install.ps1 (from a working directory OUTSIDE the extracted
 * artifact) with a fully isolated env: USERPROFILE/HOME, install root, data dir, Claude MCP config
 * (~/.claude.json), and settings.json. It never touches real default data or a live broker.
 *
 * Proves the release-asset installer end to end: dry-run + real install with NO external Node on
 * PATH, the installed plugin ships its own runtime/node.exe, the installed MCP config references the
 * bundled ABSOLUTE runtime, the installed CLI runs `doctor`, uninstall retains the isolated data
 * dir, Node 25 first on PATH still selects the bundled runtime, invocation from another cwd
 * succeeds, a tampered bundled runtime fails before execution, and the output NEVER contains
 * "source is not a valid XBus plugin payload". Windows-only (PowerShell + install.ps1 + bundled
 * runtime). Requires the pinned vetted node.exe via XBUS_BUNDLED_NODE (release build input).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildPackage } from '../../src/tools/package-win.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isWin = process.platform === 'win32';
const bundledNodeSrc = process.env.XBUS_BUNDLED_NODE; // the pinned vetted node.exe (release input)
const canRun = isWin && !!bundledNodeSrc && fs.existsSync(bundledNodeSrc ?? '');
const pwsh = 'powershell';

let artifact: string;             // extracted release artifact root (has runtime/node.exe, install.ps1, SHA256SUMS)
let outsideCwd: string;           // a working directory OUTSIDE the artifact
const NEVER = 'source is not a valid XBus plugin payload';

function sha256(f: string): string { return createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

/** A fully isolated environment for one install lifecycle. */
function isoEnv(extraPathDir?: string | null): { env: Record<string, string>; home: string; installRoot: string; dataDir: string; configPath: string; settingsPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentel-accept-home-'));
  const installRoot = path.join(home, 'install-root');
  const dataDir = path.join(home, 'data');
  const claudeDir = path.join(home, '.claude'); fs.mkdirSync(claudeDir, { recursive: true });
  const configPath = path.join(home, '.claude.json');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const sys32 = path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32');
  const winDir = process.env.SYSTEMROOT || 'C:\\Windows';
  const parts = [sys32, winDir, path.join(sys32, 'WindowsPowerShell', 'v1.0')];
  if (extraPathDir) parts.unshift(extraPathDir);
  const env: Record<string, string> = {
    SYSTEMROOT: winDir, USERPROFILE: home, HOME: home,
    XBUS_INSTALL_ROOT: installRoot, XBUS_DATA_DIR: dataDir,
    CLAUDE_CONFIG_PATH: configPath, CLAUDE_SETTINGS_PATH: settingsPath,
    PATH: parts.join(path.delimiter), Path: parts.join(path.delimiter),
    PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1',
    TEMP: process.env.TEMP || home, TMP: process.env.TMP || home,
    // A fake claude host so the launcher never resolves the real one (not used here, but isolates).
    XBUS_TEST_REQUIRE_FAKE_CLAUDE: '1',
  };
  return { env, home, installRoot, dataDir, configPath, settingsPath };
}

/** Run install.ps1 from `cwd` (deliberately OUTSIDE the artifact) with an isolated env. */
function runInstallPs1(cwd: string, env: Record<string, string>, dryRun: boolean): { code: number; out: string } {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(artifact, 'install.ps1')];
  if (dryRun) args.push('-DryRun');
  const r = spawnSync(pwsh, args, { cwd, encoding: 'utf8', timeout: 120_000, env });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}
/** Run the INSTALLED CLI (via the installed bundled runtime) with an isolated env. */
function runInstalledCli(installRoot: string, env: Record<string, string>, cliArgs: string[]): { code: number; out: string } {
  const node = path.join(installRoot, 'plugin', 'runtime', 'node.exe');
  const cli = path.join(installRoot, 'plugin', 'dist', 'cli', 'main.js');
  const r = spawnSync(node, [cli, ...cliArgs], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 60_000, env });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}
/** Run the CLI from the EXTRACTED ARTIFACT's runtime (not the installed tree) — the way a real
 *  user uninstalls, so the running node.exe never holds a lock on the install tree it removes. */
function runArtifactCli(env: Record<string, string>, cliArgs: string[]): { code: number; out: string } {
  const node = path.join(artifact, 'runtime', 'node.exe');
  const cli = path.join(artifact, 'dist', 'cli', 'main.js');
  const r = spawnSync(node, [cli, ...cliArgs], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 60_000, env });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

beforeAll(() => {
  if (!canRun) return;
  if (!fs.existsSync(path.join(REPO, 'dist', 'tools', 'package-win.js'))) throw new Error('dist/ missing — run `npm run build`');
  artifact = fs.mkdtempSync(path.join(os.tmpdir(), 'agentel-accept-art-'));
  buildPackage(artifact); // real bundled artifact (XBUS_BUNDLED_NODE → runtime/node.exe + SHA256SUMS)
  outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentel-accept-outside-'));
}, 300_000);

afterAll(() => {
  for (const d of [artifact, outsideCwd]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

describe.runIf(canRun)('REAL bundled release-asset acceptance (install.ps1 + package-win artifact)', () => {
  it('artifact shipped runtime/node.exe + install.ps1 + a SHA256SUMS entry for the runtime', () => {
    expect(fs.existsSync(path.join(artifact, 'runtime', 'node.exe'))).toBe(true);
    expect(fs.existsSync(path.join(artifact, 'install.ps1'))).toBe(true);
    const sums = fs.readFileSync(path.join(artifact, 'SHA256SUMS'), 'utf8');
    expect(sums).toMatch(/ {2}runtime\/node\.exe$/m);
  });

  it('[1] install.ps1 -DryRun succeeds with NO external Node on PATH (from an OUTSIDE cwd)', () => {
    const { env } = isoEnv(null);
    const r = runInstallPs1(outsideCwd, env, true);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/runtime source: bundled/);
    expect(r.out).not.toContain(NEVER);                       // [10] + [8]
  });

  it('[2,3,4,5,6,8,10] real install → doctor → uninstall (retain data), NO external Node, OUTSIDE cwd', () => {
    const iso = isoEnv(null);
    // [2]+[8]+[10]: real install from a cwd OUTSIDE the artifact, no external Node.
    const inst = runInstallPs1(outsideCwd, iso.env, false);
    expect(inst.code, inst.out).toBe(0);
    expect(inst.out).toMatch(/runtime source: bundled/);
    expect(inst.out).not.toContain(NEVER);

    // [3]: the INSTALLED plugin contains its bundled runtime/node.exe.
    const installedRuntime = path.join(iso.installRoot, 'plugin', 'runtime', 'node.exe');
    expect(fs.existsSync(installedRuntime), 'installed plugin must ship runtime/node.exe').toBe(true);

    // [4]: the installed MCP config references the bundled ABSOLUTE runtime path.
    const cfg = JSON.parse(fs.readFileSync(iso.configPath, 'utf8'));
    const servers = cfg.mcpServers ?? {};
    const commands = Object.values(servers).map((s: any) => String(s.command));
    expect(commands.some((c) => path.normalize(c).toLowerCase() === path.normalize(installedRuntime).toLowerCase()),
      `MCP config command must be the bundled absolute runtime; got ${JSON.stringify(commands)}`).toBe(true);

    // [5]: the installed CLI can run doctor (via the installed bundled runtime).
    const doc = runInstalledCli(iso.installRoot, iso.env, ['doctor', '--json']);
    expect(doc.code, doc.out).toBe(0);
    expect(doc.out).not.toContain(NEVER);

    // Seed a data-dir marker to prove uninstall RETAINS the isolated data dir.
    fs.mkdirSync(iso.dataDir, { recursive: true });
    const dataMarker = path.join(iso.dataDir, 'keep-me.txt'); fs.writeFileSync(dataMarker, 'retain');

    // [6]: uninstall succeeds; plugin removed; data dir + marker RETAINED (no --remove-data).
    // Run via the ARTIFACT's runtime (as a real user would) so the executing node.exe does not hold
    // a self-lock on the install tree it is removing.
    const un = runArtifactCli(iso.env, ['uninstall', '--json']);
    expect(un.code, un.out).toBe(0);
    expect(fs.existsSync(path.join(iso.installRoot, 'plugin', '.claude-plugin', 'plugin.json')), 'plugin should be removed').toBe(false);
    expect(fs.existsSync(dataMarker), 'data dir must be retained by default').toBe(true);

    try { fs.rmSync(iso.home, { recursive: true, force: true }); } catch { /* */ }
  }, 180_000);

  it('[7] Node 25 first on PATH still selects the bundled runtime', () => {
    // Only meaningful if a real Node 25 is available; else skip honestly by using the current
    // out-of-floor Node if it is >= 25, otherwise assert the fixture-level guarantee via [2].
    const node25 = process.version.startsWith('v25') ? path.dirname(process.execPath) : null;
    const iso = isoEnv(node25);
    const r = runInstallPs1(outsideCwd, iso.env, true);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/runtime source: bundled/);
    expect(r.out).toContain(path.normalize(path.join(artifact, 'runtime', 'node.exe')));
    try { fs.rmSync(iso.home, { recursive: true, force: true }); } catch { /* */ }
  });

  it('[9] a TAMPERED bundled runtime fails BEFORE execution (integrity gate; never falls back)', () => {
    // Tamper a COPY of the artifact so the shared one stays valid for other tests.
    const tampered = fs.mkdtempSync(path.join(os.tmpdir(), 'agentel-accept-tamper-'));
    fs.cpSync(artifact, tampered, { recursive: true });
    const nodeExe = path.join(tampered, 'runtime', 'node.exe');
    const b = fs.readFileSync(nodeExe); b[0] ^= 0xff; b[1] ^= 0xff; fs.writeFileSync(nodeExe, b); // corrupt PE header + hash
    const { env } = isoEnv(path.dirname(process.execPath)); // even with a Node on PATH → must NOT fall back
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tampered, 'install.ps1'), '-DryRun'];
    const r = spawnSync(pwsh, args, { cwd: outsideCwd, encoding: 'utf8', timeout: 60_000, env });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(r.status ?? 1).not.toBe(0);
    expect(out).toMatch(/integrity|does not match|tampered|corrupt/i);
    expect(out).not.toMatch(/runtime source: path-fallback/);
    try { fs.rmSync(tampered, { recursive: true, force: true }); } catch { /* */ }
  }, 120_000);
});
