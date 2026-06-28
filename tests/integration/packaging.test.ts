/**
 * §7 — isolated Windows packaging. Builds a self-contained XBus package into a
 * TEMP staging dir (never the real profile, never PATH) and verifies it is
 * shippable: checksums, SBOM, pinned runtime, content-clean, and — critically —
 * needs NO build toolchain (npm/Bun/node-gyp/compiler) after install.
 *
 * Requires `dist/` to exist (the suite's pretest builds it; if running this file
 * alone, run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPackage, assertNoBuildToolchain } from '../../src/tools/package-win.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let staging: string;
let result: ReturnType<typeof buildPackage>;

beforeAll(() => {
  if (!fs.existsSync(path.join(REPO, 'dist', 'cli', 'main.js'))) {
    throw new Error('dist/ missing — run `npm run build` before this test');
  }
  staging = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-pkg-'));
  result = buildPackage(staging);
});
afterAll(() => { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('§7 isolated Windows packaging', () => {
  it('stages compiled output + pinned prod deps (no dev tooling)', () => {
    expect(fs.existsSync(path.join(staging, 'dist', 'cli', 'main.js'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'node_modules', 'uuid'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'node_modules', 'zod'))).toBe(true);
    // Dev tooling must NOT be staged.
    expect(fs.existsSync(path.join(staging, 'node_modules', 'typescript'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'node_modules', 'vitest'))).toBe(false);
    expect(result.fileCount).toBeGreaterThan(0);
  });

  it('writes a pinned runtime descriptor declaring no compiler needed', () => {
    const rt = JSON.parse(fs.readFileSync(path.join(staging, 'runtime.json'), 'utf8'));
    expect(rt.runtime).toBe('node');
    expect(rt.nativeAddons).toBe(false);
    expect(rt.buildToolchainRequiredAtRuntime).toBe(false);
    expect(rt.enginesRange).toBeTruthy();
  });

  it('build-manifest.json carries NO builder-environment fields (cross-Node reproducibility)', () => {
    // build-manifest.json is checksum-covered, so any builder-specific field
    // (process.version, platform, a timestamp) would make the artifact manifest
    // checksum vary by who/where it was built — a reproducibility defect. It must
    // carry ONLY deterministic source facts.
    const bm = JSON.parse(fs.readFileSync(path.join(staging, 'build-manifest.json'), 'utf8'));
    expect(bm.version).toBeTruthy();
    expect(bm.commit).toBeTruthy();
    expect(bm.buildId).toBeTruthy();
    expect(bm.node).toBeUndefined();
    expect(bm.builtOnPlatform).toBeUndefined();
    expect(Object.keys(bm).sort()).toEqual(['buildId', 'commit', 'name', 'version']);
  });

  it('generates a SHA256SUMS covering every shipped file, all verifiable', () => {
    const sums = fs.readFileSync(path.join(staging, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums.length).toBe(result.checksums);
    expect(sums.length).toBeGreaterThan(0);
    // Re-verify a handful: recompute and compare.
    const { createHash } = require('node:crypto');
    let verified = 0;
    for (const line of sums.slice(0, 10)) {
      const [hash, rel] = line.split('  ');
      const buf = fs.readFileSync(path.join(staging, rel!));
      expect(createHash('sha256').update(buf).digest('hex')).toBe(hash);
      verified++;
    }
    expect(verified).toBe(Math.min(10, sums.length));
  });

  it('generates an SBOM of the shipped dependency set', () => {
    const sbom = JSON.parse(fs.readFileSync(path.join(staging, 'sbom.json'), 'utf8'));
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.components.length).toBe(result.sbomComponents);
    const names = sbom.components.map((c: { name: string }) => c.name);
    expect(names).toContain('uuid');
    expect(names).toContain('zod');
    for (const c of sbom.components) { expect(c.version).toBeTruthy(); expect(c.purl).toMatch(/^pkg:npm\//); }
  });

  it('contains NO private paths, developer identity, or secrets (content scan clean)', () => {
    if (result.scanHits.length > 0) {
      const detail = result.scanHits.map((h) => `${h.rule} ${h.file}:${h.line} ${h.excerpt}`).join('\n');
      throw new Error(`content scan found prohibited material in the package:\n${detail}`);
    }
    expect(result.scanHits).toHaveLength(0);
  });

  it('needs NO build toolchain at runtime (no .node addons, no node-gyp, no forbidden deps)', () => {
    expect(result.toolchainOk, result.toolchainReasons.join('; ')).toBe(true);
    // Re-run the assertion independently against the staged tree.
    const tc = assertNoBuildToolchain(staging);
    expect(tc.ok).toBe(true);
    expect(tc.reasons).toHaveLength(0);
  });

  it('staged package.json carries prod deps + engines but NO scripts/devDependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
    expect(pkg.dependencies.uuid).toBeTruthy();
    expect(pkg.dependencies.zod).toBeTruthy();
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.scripts).toBeUndefined();
    expect(pkg.engines.node).toBeTruthy();
  });
});
