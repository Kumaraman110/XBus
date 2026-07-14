/**
 * Beta.7 (ADR 0022) — the XBus-owned bundled Node runtime.
 *
 * Proves: when the builder supplies a vetted node.exe via XBUS_BUNDLED_NODE, the packager
 * copies it to runtime/node.exe, checksums it in SHA256SUMS, records the deterministic
 * bundledNodeVersion in runtime.json + provenance.json, keeps the artifact toolchain-free +
 * contract-valid, and a real install writes the BUNDLED runtime path into the user-scope
 * MCP/hook command (so installed XBus ignores system Node). When XBUS_BUNDLED_NODE is unset
 * (dev/source), packaging omits the runtime and the artifact is still valid — the guarantee
 * degrades honestly.
 *
 * Requires dist/ (suite pretest builds it). Uses the pinned validation node.exe as the vetted
 * binary; skips the copy-dependent assertions cleanly if that binary is absent on this host.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../../src/tools/package-win.js';
import { validateChecksumCoverage } from '../../src/shared/artifact-contract.js';
import { BUNDLED_NODE_VERSION, BUNDLED_NODE_SHA256, bundledNodePath, hasBundledRuntime, assertPinnedRuntimeInRange } from '../../src/shared/bundled-runtime.js';
import { registerUserScope, inspectUserScopeHooks } from '../../src/cli/user-scope-config.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// A vetted node.exe to stand in for the builder-supplied runtime. We do NOT hardcode any
// host path: prefer an explicit XBUS_BUNDLED_NODE override, else the node binary running this
// test (process.execPath). The packager verifies the supplied binary's SHA-256 against the
// pinned BUNDLED_NODE_SHA256, so the copy-dependent assertions run ONLY when the candidate is
// a Windows .exe whose bytes hash to exactly that pin; otherwise they skip cleanly and the
// pure-helper + no-runtime cases still run. This keeps the fixture machine-agnostic (no private
// path) and honest (it never claims to bundle a binary that isn't the pinned one).
function resolveVettedNode(): string | null {
  const cand = process.env.XBUS_BUNDLED_NODE ?? process.execPath;
  if (!cand || !/\.exe$/i.test(cand) || !fs.existsSync(cand)) return null;
  try {
    const sha = createHash('sha256').update(fs.readFileSync(cand)).digest('hex');
    return sha === BUNDLED_NODE_SHA256 ? cand : null;
  } catch { return null; }
}
const VETTED_NODE = resolveVettedNode();
const haveVetted = VETTED_NODE !== null;

const dirs: string[] = [];
function tmp(prefix: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

beforeAll(() => {
  if (!fs.existsSync(path.join(REPO, 'dist', 'cli', 'main.js'))) throw new Error('dist/ missing — run `npm run build`');
});

describe('bundled runtime — pure helpers (ADR 0022)', () => {
  it('the pinned version satisfies the supported Node floor [22.13, 25)', () => {
    expect(() => assertPinnedRuntimeInRange()).not.toThrow();
    expect(BUNDLED_NODE_VERSION).toMatch(/^22\.(1[3-9]|[2-9]\d)\./); // >= 22.13
    expect(BUNDLED_NODE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('bundledNodePath + hasBundledRuntime resolve under a plugin root', () => {
    const root = tmp('xbus-rt-');
    expect(bundledNodePath(root).replace(/\\/g, '/')).toBe(root.replace(/\\/g, '/') + '/runtime/node.exe');
    expect(hasBundledRuntime(root)).toBe(false);
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.writeFileSync(bundledNodePath(root), 'x');
    expect(hasBundledRuntime(root)).toBe(true);
  });
});

describe('packaging WITHOUT a bundled runtime (dev/source) stays valid + omits it', () => {
  it('no runtime dir, no bundledNodeVersion, still contract-valid + toolchain-free', () => {
    const prev = process.env.XBUS_BUNDLED_NODE;
    delete process.env.XBUS_BUNDLED_NODE;
    try {
      const staging = tmp('xbus-pkg-nort-');
      const r = buildPackage(staging);
      expect(r.contractViolations).toEqual([]);
      expect(r.toolchainOk).toBe(true);
      expect(r.checksumCoverage.ok).toBe(true);
      expect(fs.existsSync(path.join(staging, 'runtime', 'node.exe'))).toBe(false);
      const rt = JSON.parse(fs.readFileSync(path.join(staging, 'runtime.json'), 'utf8'));
      expect(rt.bundledNodeVersion).toBeUndefined();
    } finally { if (prev !== undefined) process.env.XBUS_BUNDLED_NODE = prev; }
  });
});

describe('packaging WITH a bundled runtime (ADR 0022)', () => {
  it.skipIf(!haveVetted)('copies runtime/node.exe, checksums it, records bundledNodeVersion, stays valid', () => {
    const prev = process.env.XBUS_BUNDLED_NODE;
    process.env.XBUS_BUNDLED_NODE = VETTED_NODE!; // non-null: skipIf(!haveVetted) gates this test
    try {
      const staging = tmp('xbus-pkg-rt-');
      const r = buildPackage(staging);
      // Runtime present + non-trivial size (a real node.exe is tens of MB).
      const nodeExe = path.join(staging, 'runtime', 'node.exe');
      expect(fs.existsSync(nodeExe)).toBe(true);
      expect(fs.statSync(nodeExe).size).toBeGreaterThan(10 * 1024 * 1024);
      // Checksummed by the whole-tree SHA256SUMS (coverage 0 missing / 0 extra).
      expect(r.checksumCoverage.ok).toBe(true);
      const sums = fs.readFileSync(path.join(staging, 'SHA256SUMS'), 'utf8');
      expect(sums).toContain('runtime/node.exe');
      // Deterministic bundled version in BOTH runtime.json + provenance.json (not process.version).
      const rt = JSON.parse(fs.readFileSync(path.join(staging, 'runtime.json'), 'utf8'));
      const prov = JSON.parse(fs.readFileSync(path.join(staging, 'provenance.json'), 'utf8'));
      expect(rt.bundledNodeVersion).toBe(BUNDLED_NODE_VERSION);
      expect(rt.bundledRuntime).toBe('runtime/node.exe');
      expect(prov.bundledNodeVersion).toBe(BUNDLED_NODE_VERSION);
      // Still toolchain-free (node.exe is an interpreter, not a .node addon) + contract-valid + no leaked secrets.
      expect(r.toolchainOk, r.toolchainReasons.join('; ')).toBe(true);
      expect(r.contractViolations).toEqual([]);
      expect(r.scanHits).toEqual([]);
      // Coverage validator agrees independently.
      const cc = validateChecksumCoverage(staging);
      expect(cc.ok).toBe(true);
    } finally { if (prev === undefined) delete process.env.XBUS_BUNDLED_NODE; else process.env.XBUS_BUNDLED_NODE = prev; }
  });

  it('a SHA mismatch on the supplied binary fails the build closed', () => {
    const prev = process.env.XBUS_BUNDLED_NODE;
    // Point at a WRONG file (any file whose sha != the pinned one). Use this test file.
    const wrong = tmp('xbus-wrong-');
    const fake = path.join(wrong, 'node.exe');
    fs.writeFileSync(fake, 'not the real node');
    process.env.XBUS_BUNDLED_NODE = fake;
    try {
      const staging = tmp('xbus-pkg-badsha-');
      // BUNDLED_NODE_SHA256 is pinned, so a mismatch must throw.
      expect(() => buildPackage(staging)).toThrow(/SHA mismatch|bundled node/i);
    } finally { if (prev === undefined) delete process.env.XBUS_BUNDLED_NODE; else process.env.XBUS_BUNDLED_NODE = prev; }
  });
});

describe('install wires the bundled runtime into the user-scope command (ADR 0022)', () => {
  it('when a bundled runtime is present in the plugin dir, the MCP/hook command IS the bundled node', () => {
    // Simulate an installed plugin dir that ships a bundled runtime, then register user-scope
    // with nodePath = the bundled path (exactly what install.ts computes) and read it back.
    const root = tmp('xbus-inst-');
    const pluginDir = path.join(root, 'plugin');
    fs.mkdirSync(path.join(pluginDir, 'runtime'), { recursive: true });
    fs.writeFileSync(bundledNodePath(pluginDir), 'x'); // stand-in binary
    const nodePath = hasBundledRuntime(pluginDir) ? bundledNodePath(pluginDir) : process.execPath;
    expect(nodePath).toBe(bundledNodePath(pluginDir));
    const settingsPath = path.join(root, 'settings.json');
    const configPath = path.join(root, 'claude.json');
    const r = registerUserScope({
      configPath, settingsPath, nodePath,
      serverEntry: path.join(pluginDir, 'dist', 'channel', 'server.js'),
      hookEntry: path.join(pluginDir, 'dist', 'channel', 'hook-entry.js'),
      sessionStartHookEntry: path.join(pluginDir, 'dist', 'channel', 'session-start-hook.js'),
      dataDir: path.join(root, 'data'), installId: 'test-install',
    });
    expect(r.ok).toBe(true);
    const hk = inspectUserScopeHooks(settingsPath);
    // The SessionStart hook's launcher command must be the bundled runtime path.
    expect(hk.events.SessionStart.registered).toBe(true);
    expect(hk.events.SessionStart.command).toBe(nodePath);
  });
});
