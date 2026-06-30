/**
 * F-A — the packaging + benchmark COMMANDS must actually execute (they were
 * silent no-ops). These tests run the COMPILED entrypoints directly via
 * `node dist/tools/...` (the exact thing `npm run package:win` / `npm run bench`
 * invoke), proving the entry runs, produces output, and fails loudly — not just
 * that the imported function works.
 *
 * Requires `dist/` (suite pretest builds it).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PKG_ENTRY = path.join(REPO, 'dist', 'tools', 'package-win.js');
const BENCH_ENTRY = path.join(REPO, 'dist', 'tools', 'secure-transport-bench.js');

beforeAll(() => {
  if (!fs.existsSync(PKG_ENTRY) || !fs.existsSync(BENCH_ENTRY)) throw new Error('dist/tools missing — run `npm run build`');
});

function run(entry: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    // The bench (warmup + 30 handshakes + 500 round-trips + 2000-msg throughput) can
    // run well over 90s on a slow/contended Windows runner; give it generous headroom
    // so a slow machine is not a false non-zero exit. Bounded to catch a true hang.
    const out = execFileSync(process.execPath, [entry, ...args], { env: { ...process.env, ...env }, cwd: REPO, encoding: 'utf8', timeout: 300_000 });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('F-A — package:win entry actually produces an artifact', () => {
  it('node dist/tools/package-win.js <dir> creates a real, complete artifact and exits 0', () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-pkgcli-'));
    try {
      const r = run(PKG_ENTRY, [staging]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/Packaged XBus/);
      expect(r.out).toMatch(/manifest-checksum: [0-9a-f]{64}/);
      // The artifact really exists and is complete.
      for (const f of ['SHA256SUMS', 'runtime.json', 'build-manifest.json', 'sbom.json', 'dist/cli/main.js', 'dist/launcher/xclaude.js']) {
        expect(fs.existsSync(path.join(staging, f)), `missing ${f}`).toBe(true);
      }
      // runtime.json embeds version + commit (F-H).
      const rt = JSON.parse(fs.readFileSync(path.join(staging, 'runtime.json'), 'utf8'));
      expect(rt.version).toBeTruthy();
      expect(rt.commit).toBeTruthy();
      expect(rt.buildToolchainRequiredAtRuntime).toBe(false);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  });

  it('package-win refuses to wipe a non-empty foreign staging dir (F-pkgrm)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-foreign-'));
    const precious = path.join(dir, 'precious.txt');
    fs.writeFileSync(precious, 'do not delete');
    try {
      const r = run(PKG_ENTRY, [dir]);
      expect(r.code).not.toBe(0); // refused
      expect(r.out).toMatch(/refusing to delete/i);
      expect(fs.existsSync(precious)).toBe(true); // untouched
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('F-A — bench entry actually runs', () => {
  it('node dist/tools/secure-transport-bench.js --json emits a valid report and exits 0', () => {
    const r = run(BENCH_ENTRY, ['--json']);
    expect(r.code, r.out).toBe(0);
    // Extract the JSON object from stdout (the launcher prints only JSON in --json mode,
    // plus a trailing "All objectives met." line).
    const start = r.out.indexOf('{');
    const end = r.out.lastIndexOf('}');
    expect(start).toBeGreaterThanOrEqual(0);
    const report = JSON.parse(r.out.slice(start, end + 1));
    expect(report.secureTransport).toBe(true);
    expect(report.methodology.warmup).toBeGreaterThan(0);
    expect(report.handshakeMs.n).toBeGreaterThan(0);
    expect(report.sendThroughputPerSec).toBeGreaterThan(0); // structural (>0), NOT a perf threshold
  }, 360_000); // exceed the 300s execFileSync bench cap so vitest doesn't kill it first (slow runners)
});
