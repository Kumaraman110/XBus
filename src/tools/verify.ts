/**
 * Beta.9 (ADR 0029): `agentel verify` — the ONE frictionless verification command.
 *
 * Goal: after cloning AgenTel, a developer or Claude Code runs a single command that
 * automatically locates an approved Node runtime (no dependence on global Node/npm/NVM/PATH
 * ordering), installs dependencies on it, and runs the FULL gate — build, lint, typecheck, all
 * test shards, security tests, npm audit, clean-machine + identity-reclaim acceptance — then
 * builds the release artifact, proves deterministic ZIP output, prints the artifact SHA-256,
 * emits a machine-readable report, and fails closed with a precise remediation message.
 *
 * FAILURE TAXONOMY (the report tags every stage): a caller can tell WHY it failed without
 * reading logs.
 *   - environment  : no approved runtime, npm install could not fetch, etc. (fix your machine)
 *   - repo-policy  : lint / typecheck / format / shard-coverage (fix the code to policy)
 *   - test         : a test shard failed (a behavior regressed)
 *   - security     : npm audit found a vulnerability
 *   - product      : clean-machine / identity-reclaim acceptance failed (the shipped product is wrong)
 *   - packaging    : artifact build / determinism / SHA
 *
 * IDEMPOTENT: writes only into `<repo>/.agentel/` (gitignored) and OS temp dirs, so a rerun
 * never dirties the working tree. Windows-first: uses the resolved runtime for every spawn.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveApprovedRuntime, realProbes, type RuntimeResolution } from './runtime-resolver.js';
import { isGovernanceEnabled, emitPreflightEvidence } from './governance.js';

export type FailureClass = 'environment' | 'repo-policy' | 'test' | 'security' | 'product' | 'packaging';

export interface VerifyStage {
  stage: string;
  class: FailureClass;
  ok: boolean;
  detail: string;
  /** Wall-clock ms for the stage (diagnostic only; excluded from determinism). */
  ms?: number;
}

export interface VerifyReport {
  ok: boolean;
  repoRoot: string;
  runtime: { source?: string; version?: string; nodePath?: string };
  artifactSha256?: string;
  stages: VerifyStage[];
  /** When !ok: the first failing class + its remediation. */
  failure?: { class: FailureClass; stage: string; remediation: string };
}

export interface VerifyOptions {
  repoRoot: string;
  /** Skip the slow install-heavy acceptance stages (used by `release-check --fast` / CI split). */
  skipAcceptance?: boolean;
  /** Sniff a node binary's version (spawns it with --version). Injectable for tests. */
  nodeVersion?: (nodeBinary: string) => string | null;
  /** Progress line sink (defaults to stdout). */
  log?: (s: string) => void;
}

/** Spawn `node <version-flag>` and parse the version. Real implementation for realProbes. */
export function sniffNodeVersion(nodeBinary: string): string | null {
  try {
    const r = spawnSync(nodeBinary, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    if (r.status !== 0) return null;
    const v = (r.stdout ?? '').trim();
    return /^v\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch { return null; }
}

/** Remediation text per failure class (appended with the concrete failing stage). */
function remediationFor(cls: FailureClass): string {
  switch (cls) {
    case 'environment': return 'Environment problem: fix the runtime/dependencies, then rerun `agentel verify`. See the runtime-resolution note above.';
    case 'repo-policy': return 'Repository-policy failure (lint/typecheck/coverage): fix the code to satisfy policy, then rerun.';
    case 'test': return 'A test failed: a behavior regressed. Inspect the failing shard output, fix the code or the test, then rerun.';
    case 'security': return 'npm audit found a vulnerability: run `npm audit --omit=dev` for detail and upgrade/patch the flagged package.';
    case 'product': return 'Product acceptance failed (clean-machine / identity-reclaim): the SHIPPED product is wrong. Do NOT publish. Fix and rerun.';
    case 'packaging': return 'Packaging/determinism failure: the release artifact could not be built reproducibly. Inspect the packaging stage output.';
  }
}

/**
 * Run the full verify pipeline. Returns a VerifyReport (never throws for a stage failure — the
 * failure is captured in the report). Only genuinely-exceptional conditions (bad repoRoot) throw.
 */
export function runVerify(opts: VerifyOptions): VerifyReport {
  const log = opts.log ?? ((s: string) => process.stdout.write(s + '\n'));
  const repoRoot = path.resolve(opts.repoRoot);
  const nodeVersion = opts.nodeVersion ?? sniffNodeVersion;
  const stages: VerifyStage[] = [];

  const outDir = path.join(repoRoot, '.agentel');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* best-effort */ }

  const record = (stage: string, cls: FailureClass, ok: boolean, detail: string, ms?: number): void => {
    stages.push({ stage, class: cls, ok, detail, ...(ms !== undefined ? { ms } : {}) });
    log(`  [${ok ? 'PASS' : 'FAIL'}] (${cls}) ${stage}${detail ? ' — ' + detail : ''}`);
  };

  const finalize = (): VerifyReport => {
    const firstFail = stages.find((s) => !s.ok);
    const report: VerifyReport = {
      ok: !firstFail,
      repoRoot,
      runtime: {
        ...(resolution.source !== undefined ? { source: resolution.source } : {}),
        ...(resolution.version !== undefined ? { version: resolution.version } : {}),
        ...(resolution.nodePath !== undefined ? { nodePath: resolution.nodePath } : {}),
      },
      ...(artifactSha ? { artifactSha256: artifactSha } : {}),
      stages,
      ...(firstFail ? { failure: { class: firstFail.class, stage: firstFail.stage, remediation: remediationFor(firstFail.class) } } : {}),
    };
    try { fs.writeFileSync(path.join(outDir, 'verify-report.json'), JSON.stringify(report, null, 2)); } catch { /* best-effort */ }
    return report;
  };

  // ── Stage 0: resolve an approved runtime (environment class). Fail closed with remediation.
  const resolution: RuntimeResolution = resolveApprovedRuntime(repoRoot, realProbes(nodeVersion));
  let artifactSha: string | undefined;
  if (!resolution.ok) {
    log(resolution.error ?? 'no approved runtime');
    record('resolve-approved-runtime', 'environment', false, resolution.error ?? 'no approved runtime');
    return finalize();
  }
  const node = resolution.nodePath!;
  const npmCli = resolution.npmCliPath!;
  record('resolve-approved-runtime', 'environment', true, `${resolution.source} → ${resolution.version} (${node})${resolution.runtimeComplete === false ? ' [INCOMPLETE dist — see runtime-completeness stage]' : ''}`);

  // ── Stage 0b: runtime completeness. `npm ci`/`npm audit`/build run via `node npm-cli.js` and
  //    need NO CLI shims, but the integration/acceptance FIXTURES spawn children that shell out to
  //    `npm`/`npx` by name — so on a machine with no other Node, an INCOMPLETE vendored dist
  //    (node.exe without npm.cmd/npx.cmd) passes deps+build then fails deep in the test shard.
  //    Surface it HERE, upfront + actionable, instead of as a confusing shard failure. Only a
  //    blocker when acceptance/tests will run (i.e. not --skip-acceptance AND the full gate runs).
  if (resolution.runtimeComplete === false) {
    const willRunFixtures = !opts.skipAcceptance;
    const detail = `resolved runtime (${resolution.source}) lacks the CLI shims (npm/npx) that test/acceptance fixtures spawn by name. Deps + build work, but the full test shards need a COMPLETE Node dist. Fix: point AGENTEL_VERIFY_NODE at a complete Node dist, or vendor a COMPLETE dist (all files, incl npm.cmd/npx.cmd) into .agentel/node/.`;
    record('runtime-completeness', 'environment', !willRunFixtures, willRunFixtures ? detail : `incomplete dist accepted (--skip-acceptance: no fixtures spawn npm/npx)`);
    if (willRunFixtures) return finalize();
  } else {
    record('runtime-completeness', 'environment', true, 'complete Node dist (node + npm/npx shims present)');
  }

  // Helper: spawn the resolved node with args in repoRoot; returns {code, out}.
  const runNode = (args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 600_000): { code: number; out: string } => {
    const r = spawnSync(node, args, {
      cwd: repoRoot, encoding: 'utf8', timeout: timeoutMs,
      // 64 MiB: the release-gate captures ALL of verify-release.js output; a FAILING vitest shard
      // can dump far past the 1 MiB spawnSync default, which would truncate the stream + set an
      // ENOBUFS error and make us misreport a pass/fail. Give it generous headroom.
      maxBuffer: 64 * 1024 * 1024,
      // Pin the child to the resolved runtime: put its dir FIRST on PATH so any nested
      // `node`/`npm` resolves to the approved one, not ambient PATH.
      env: { ...process.env, ...extraEnv, PATH: path.dirname(node) + path.delimiter + (process.env.PATH ?? '') },
    });
    return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  const runNpm = (args: string[], timeoutMs = 600_000) => runNode([npmCli, ...args], {}, timeoutMs);

  // ── Stage 1: install dependencies on the APPROVED runtime (environment class).
  {
    const hasLock = fs.existsSync(path.join(repoRoot, 'package-lock.json'));
    const t = Number(process.hrtime.bigint() / 1_000_000n);
    const r = runNpm(hasLock ? ['ci'] : ['install'], 900_000);
    const ms = Number(process.hrtime.bigint() / 1_000_000n) - t;
    record(`npm ${hasLock ? 'ci' : 'install'}`, 'environment', r.code === 0, r.code === 0 ? 'dependencies installed on the approved runtime' : `exit ${r.code}: ${r.out.slice(-300)}`, ms);
    if (r.code !== 0) return finalize();
  }

  // ── Stage 2: the full release gate (build/lint/typecheck/shards/tests/packaging/det-zip).
  //    Reuse the authoritative verify:release tool under the approved runtime. First ensure the
  //    tool itself is built (chicken-and-egg: it lives in dist/).
  {
    const b = runNpm(['run', 'build'], 300_000);
    record('build (tsc)', 'repo-policy', b.code === 0, b.code === 0 ? 'dist/ built' : `exit ${b.code}: ${b.out.slice(-300)}`);
    if (b.code !== 0) return finalize();
  }
  {
    const t = Number(process.hrtime.bigint() / 1_000_000n);
    const vr = runNode([path.join('dist', 'tools', 'verify-release.js')], { XBUS_REPO_ROOT: repoRoot }, 1_800_000);
    const ms = Number(process.hrtime.bigint() / 1_000_000n) - t;
    // Capture the reproducible zip SHA. Prefer the FULL machine-parseable line (ARTIFACT_SHA256=…)
    // so the report prints the complete SHA-256; fall back to the truncated human detail only if an
    // older verify-release didn't emit the full line.
    const fullSha = /ARTIFACT_SHA256=([0-9a-f]{64})/i.exec(vr.out);
    const shaMatch = /release-zip-deterministic.*SHA ([0-9a-f]{12})/i.exec(vr.out);
    if (fullSha?.[1]) artifactSha = fullSha[1];
    else if (shaMatch?.[1]) artifactSha = shaMatch[1];
    // Classify: a FAIL line naming lint/typecheck/coverage is repo-policy; naming a test shard is
    // test; naming packaging/zip is packaging. Default to test (the broadest gate).
    const failLine = /\[FAIL\]\s+(\S+)/.exec(vr.out);
    let cls: FailureClass = 'test';
    if (failLine?.[1]) {
      const s = failLine[1];
      if (/lint|typecheck|shard-coverage|dependency-lock/.test(s)) cls = 'repo-policy';
      else if (/packaging|release-zip|artifact|doc-commands/.test(s)) cls = 'packaging';
      else cls = 'test';
    }
    const passed = vr.code === 0 && /RELEASE VERIFICATION PASSED/.test(vr.out);
    const summary = /verify:release summary: (\d+\/\d+) stages passed/.exec(vr.out)?.[1] ?? '?';
    record('release-gate (verify:release)', cls, passed, passed ? `${summary} stages; artifact SHA ${artifactSha ?? '—'}` : `${summary} stages; ${failLine ? 'failing: ' + failLine[1] : `exit ${vr.code}`}`, ms);
    if (!passed) return finalize();
  }

  // ── Stage 3: dependency vulnerability audit (security class).
  {
    const r = runNpm(['audit', '--omit=dev', '--audit-level=high'], 180_000);
    // npm audit exits nonzero when it finds >= the audit level. Report honestly.
    const zero = /found 0 vulnerabilities/.test(r.out) || r.code === 0;
    record('npm audit --omit=dev', 'security', zero, zero ? '0 vulnerabilities' : `vulnerabilities found: ${r.out.slice(-300)}`);
    if (!zero) return finalize();
  }

  // ── Stage 4: product acceptance — clean-machine (includes identity-reclaim [6b]) (product class).
  if (!opts.skipAcceptance) {
    const t = Number(process.hrtime.bigint() / 1_000_000n);
    const r = runNode([path.join('scripts', 'clean-machine-accept.mjs')], {}, 900_000);
    const ms = Number(process.hrtime.bigint() / 1_000_000n) - t;
    const passed = r.code === 0 && /BETA3_CLEAN_MACHINE_PASS/.test(r.out);
    const reclaim = /IDENTITY_RECLAIM_ACCEPT_PASS/.test(r.out);
    record('clean-machine acceptance', 'product', passed, passed ? `install→doctor→two-session→reclaim(${reclaim ? 'PASS' : 'MISSING'})→uninstall` : `exit ${r.code}: ${r.out.slice(-400)}`, ms);
    if (!passed) return finalize();
  } else {
    record('clean-machine acceptance', 'product', true, 'skipped (--skip-acceptance)');
  }

  // ── Stage 5: governed-repo evidence (opt-in only). For a repo that opted in via
  //    .agentel/governance.json, stamp preflight gate evidence so its push gate recognizes THIS
  //    verification. INERT for any repo without the opt-in file (never gates a foreign repo).
  if (isGovernanceEnabled(repoRoot)) {
    const allPassed = !stages.some((s) => !s.ok);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    const headSha = (head.stdout ?? '').trim() || 'unknown';
    // new Date() is available here (CLI runtime, not a resumable workflow script).
    const ev = emitPreflightEvidence(repoRoot, { verifyPassed: allPassed, headSha, nowIso: new Date().toISOString() });
    record('governance evidence', 'repo-policy', ev.ok, ev.ok ? `stamped ${ev.written.length} gate file(s) for ${headSha.slice(0, 12)}` : (ev.skippedReason ?? 'not written'));
  }

  return finalize();
}
