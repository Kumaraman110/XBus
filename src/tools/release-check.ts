/**
 * Beta.9 (ADR 0029): `agentel release-check` — pre-tag readiness with REPRODUCIBLE hashes.
 *
 * Distinct from `agentel verify` (which runs the whole gate): release-check answers "is this
 * commit publishable, and what EXACT artifact SHA-256 will the tag carry?" It:
 *   1. confirms the working tree is clean (a dirty tree ⇒ the SHA is not attributable to a commit)
 *   2. builds the release artifact staging TWICE and proves the deterministic ZIP is byte-identical
 *      across both builds (the reproducibility guarantee the release identity rests on)
 *   3. prints BOTH the runtime-free and the bundled-runtime SHA-256 (the bundled one is the
 *      publishable asset; the runtime-free one is what a bare verify:release reports)
 *   4. emits a machine-readable readiness report
 *
 * It does NOT run the full test suite (that is `agentel verify`); it is the fast "am I ready to
 * tag, and what is the hash" check. Idempotent: builds into OS temp, never dirties the tree.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BUNDLED_NODE_SHA256, BUNDLED_NODE_VERSION } from '../shared/bundled-runtime.js';

export interface ReleaseCheckReport {
  ok: boolean;
  repoRoot: string;
  commit?: string;
  treeClean: boolean;
  runtimeFree?: { sha256: string; bytes: number; reproducible: boolean };
  bundled?: { sha256: string; bytes: number; reproducible: boolean; bundledNodeVersion: string; bundledNodeShaMatched: boolean };
  problems: string[];
}

export interface ReleaseCheckOptions {
  repoRoot: string;
  /** Path to the vetted bundled node.exe (its SHA must match the pin). Omit to skip the bundled build. */
  bundledNode?: string;
  log?: (s: string) => void;
}

function sh(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}, timeoutMs = 300_000): { code: number; out: string } {
  // 64 MiB maxBuffer: a build/package failure can emit large output; the 1 MiB spawnSync default
  // would truncate + error and corrupt the pass/fail read.
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function sha256File(p: string): string { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

/**
 * Build a staging dir + package the deterministic zip TWICE; return the SHA + byte-identical flag.
 * `bundledNode` (when set) is passed as XBUS_BUNDLED_NODE so the staging includes runtime/node.exe.
 */
function buildAndHashTwice(node: string, repoRoot: string, tmp: string, label: string, bundledNode?: string): { sha256: string; bytes: number; reproducible: boolean; error?: string } {
  const stage = path.join(tmp, `stage-${label}`);
  const zip1 = path.join(tmp, `${label}-1.zip`);
  const zip2 = path.join(tmp, `${label}-2.zip`);
  const env: Record<string, string> = bundledNode ? { XBUS_BUNDLED_NODE: bundledNode } : {};
  const pkgWin = path.join(repoRoot, 'dist', 'tools', 'package-win.js');
  const pkgZip = path.join(repoRoot, 'dist', 'tools', 'package-release-zip.js');
  const b = sh(node, [pkgWin, stage], repoRoot, env);
  if (b.code !== 0) return { sha256: '', bytes: 0, reproducible: false, error: `package-win failed: ${b.out.slice(-300)}` };
  const r1 = sh(node, [pkgZip, stage, zip1], repoRoot, env);
  const r2 = sh(node, [pkgZip, stage, zip2], repoRoot, env);
  if (r1.code !== 0 || r2.code !== 0) return { sha256: '', bytes: 0, reproducible: false, error: `package-release-zip failed: ${(r1.out + r2.out).slice(-300)}` };
  const s1 = sha256File(zip1); const s2 = sha256File(zip2);
  const bytes = fs.statSync(zip1).size;
  return { sha256: s1, bytes, reproducible: s1 === s2 };
}

export function runReleaseCheck(opts: ReleaseCheckOptions): ReleaseCheckReport {
  const log = opts.log ?? ((s: string) => process.stdout.write(s + '\n'));
  const repoRoot = path.resolve(opts.repoRoot);
  const node = process.execPath;
  const problems: string[] = [];

  const commit = sh('git', ['rev-parse', 'HEAD'], repoRoot).out.trim() || undefined;
  const treeClean = sh('git', ['status', '--porcelain'], repoRoot).out.trim() === '';
  if (!treeClean) problems.push('working tree is dirty — build the artifact from a committed tree so its SHA is attributable to a commit');
  log(`commit ${commit ?? '(unknown)'}  tree-clean ${treeClean}`);

  // Ensure the packaging tools are built.
  const build = sh(node, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], repoRoot);
  if (build.code !== 0) { problems.push(`build failed: ${build.out.slice(-300)}`); return { ok: false, repoRoot, ...(commit ? { commit } : {}), treeClean, problems }; }
  // package-win needs postbuild static assets; run the postbuild step too.
  sh(node, [path.join(repoRoot, 'dist', 'tools', 'copy-static.js')], repoRoot);
  sh(node, [path.join(repoRoot, 'dist', 'tools', 'write-provenance.js')], repoRoot);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentel-relcheck-'));
  try {
    // Runtime-free zip (what a bare verify:release reports).
    log('building runtime-free artifact (×2 for determinism)…');
    const rf = buildAndHashTwice(node, repoRoot, tmp, 'runtime-free');
    if (rf.error) problems.push(`runtime-free: ${rf.error}`);
    else {
      if (!rf.reproducible) problems.push('runtime-free zip is NOT reproducible (two builds differ)');
      log(`  runtime-free SHA-256: ${rf.sha256}  (${rf.bytes} bytes, reproducible=${rf.reproducible})`);
    }

    // Bundled-runtime zip (the PUBLISHABLE asset). Only when a vetted node is supplied.
    let bundled: ReleaseCheckReport['bundled'];
    if (opts.bundledNode) {
      const bundledSha = sha256File(opts.bundledNode);
      const shaMatched = !BUNDLED_NODE_SHA256 || bundledSha === BUNDLED_NODE_SHA256;
      if (!shaMatched) problems.push(`supplied bundled node.exe SHA ${bundledSha} != pinned ${BUNDLED_NODE_SHA256}`);
      log(`building bundled artifact with node ${opts.bundledNode} (sha match=${shaMatched}) …`);
      const bz = buildAndHashTwice(node, repoRoot, tmp, 'bundled', opts.bundledNode);
      if (bz.error) problems.push(`bundled: ${bz.error}`);
      else {
        if (!bz.reproducible) problems.push('bundled zip is NOT reproducible (two builds differ)');
        bundled = { sha256: bz.sha256, bytes: bz.bytes, reproducible: bz.reproducible, bundledNodeVersion: BUNDLED_NODE_VERSION, bundledNodeShaMatched: shaMatched };
        log(`  bundled (PUBLISHABLE) SHA-256: ${bz.sha256}  (${bz.bytes} bytes, reproducible=${bz.reproducible})`);
      }
    } else {
      log('  (bundled artifact skipped — pass --bundled-node <path> to compute the publishable SHA)');
    }

    const ok = problems.length === 0;
    return {
      ok, repoRoot, ...(commit ? { commit } : {}), treeClean,
      ...(rf.error ? {} : { runtimeFree: { sha256: rf.sha256, bytes: rf.bytes, reproducible: rf.reproducible } }),
      ...(bundled ? { bundled } : {}),
      problems,
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
