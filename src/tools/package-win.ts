/**
 * §7 — isolated Windows packaging. Assembles a self-contained XBus distribution
 * into a STAGING directory (never the real user profile, never PATH/registry).
 * Produces:
 *   - dist/        compiled JS (no TypeScript, no source maps required at runtime)
 *   - node_modules/ pinned PRODUCTION deps only (uuid, zod) — no dev/build tooling
 *   - package.json  with the pinned runtime requirement
 *   - SHA256SUMS    checksum of every shipped file
 *   - sbom.json     CycloneDX-ish SBOM of the shipped dependency set
 *   - runtime.json  the pinned Node runtime requirement (no compiler after install)
 *
 * Verification (assertNoBuildToolchain) proves the package needs NO npm / Bun /
 * node-gyp / compiler at runtime: every dependency is pure-JS and pre-installed,
 * and node:sqlite is a Node built-in (ADR 0002) — there is nothing to compile.
 *
 * This script is reversible: it only writes under the staging dir it is given.
 * Run: `npx vite-node scripts/package-win.ts <stagingDir>`
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanTree, type ScanHit } from './content-scan.js';
import { BUILD_ID, SCHEMA_VERSION, WIRE_COMPATIBILITY_ID } from '../protocol/handshake.js';
import { PROTOCOL_VERSION, XBUS_VERSION } from '../protocol/version.js';
import { exactBuildId, SECURE_TRANSPORT_VERSION } from '../shared/build-identity.js';
import { validateArtifact, validateChecksumCoverage, type ContractViolation } from '../shared/artifact-contract.js';

// Repo root: npm sets cwd to the package root for `npm run`; allow an override
// for tests. (NOT derived from import.meta.url, which is unreliable under some
// loaders.)
const REPO = process.env.XBUS_REPO_ROOT ?? process.cwd();

/** Production runtime dependencies (must be pure-JS — no native addons). */
const PROD_DEPS = ['uuid', 'zod'];
/** Anything in this set appearing in the package's deps is a packaging defect. */
const FORBIDDEN_RUNTIME = ['better-sqlite3', 'node-gyp', 'typescript', 'vitest', 'esbuild', 'bun'];

/** Best-effort git commit of the repo (embedded in the artifact). */
function gitCommit(repo: string): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

/** A staging dir is safe to wipe if it does not exist, is empty, or carries our
 *  marker file (never recursive-delete arbitrary user data). */
function assertSafeStaging(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir);
  if (entries.length === 0) return;
  if (entries.includes('.xbus-staging')) return; // a prior package build — ours to replace
  throw new Error(`refusing to delete non-empty staging dir that is not an XBus staging dir: ${dir} (create it empty, or remove it yourself)`);
}

export interface PackageResult {
  stagingDir: string;
  version: string;
  commit: string;
  buildId: string;
  fileCount: number;
  checksums: number;
  manifestChecksum: string;
  sbomComponents: number;
  scanHits: ScanHit[];
  toolchainOk: boolean;
  toolchainReasons: string[];
  missingOutputs: string[];
  /** Normative artifact-contract violations (empty = installable). */
  contractViolations: ContractViolation[];
  /** Checksum-coverage report. */
  checksumCoverage: { ok: boolean; total: number; checksummed: number; missing: string[]; extra: string[]; collisions: string[] };
}

function copyDir(src: string, dst: string, skipTop?: (relName: string) => boolean): number {
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      // skip nested node_modules of deps' own dev junk + test dirs to keep it lean
      if (/^(test|tests|\.github|\.bin)$/.test(ent.name)) continue;
      if (skipTop && skipTop(ent.name)) continue; // caller-excluded top-level dir
      n += copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function* walkFiles(dir: string): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

/** Verify the staged package needs no build toolchain at runtime. */
export function assertNoBuildToolchain(stagingDir: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const pkgPath = path.join(stagingDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const f of FORBIDDEN_RUNTIME) {
    if (deps.includes(f)) reasons.push(`forbidden runtime dependency present: ${f}`);
    if (fs.existsSync(path.join(stagingDir, 'node_modules', f))) reasons.push(`forbidden module staged: ${f}`);
  }
  // No native build artifacts (.node) anywhere in the staged tree.
  for (const file of walkFiles(stagingDir)) {
    if (file.endsWith('.node')) reasons.push(`native addon present (needs a compiler): ${path.relative(stagingDir, file)}`);
    if (/binding\.gyp$/.test(file)) reasons.push(`node-gyp binding present: ${path.relative(stagingDir, file)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function buildPackage(stagingDir: string): PackageResult {
  // 0) Clean staging — but NEVER recursive-delete arbitrary user data (F-pkgrm).
  assertSafeStaging(stagingDir);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(path.join(stagingDir, '.xbus-staging'), 'xbus package staging dir\n');

  const repoPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    name: string; version: string; bin: Record<string, string>;
    dependencies: Record<string, string>; engines: { node: string }; license: string;
  };
  // package.json version and the in-code XBUS_VERSION are the SAME product
  // version from two sources — they MUST agree, or provenance.json (built from
  // repoPkg.version) would disagree with what the running product reports (from
  // XBUS_VERSION). Fail closed on drift.
  if (repoPkg.version !== XBUS_VERSION) {
    throw new Error(`version drift: package.json ${repoPkg.version} != XBUS_VERSION ${XBUS_VERSION} (keep them in sync)`);
  }
  const commit = gitCommit(REPO);

  // 1) Compiled RUNTIME output (build first via `npm run build`). The dev/CI
  //    tools (dist/tools: packaging, bench, verify-release, content-scan, shards)
  //    are NOT runtime code and are NOT shipped — excluding them keeps the
  //    artifact lean and avoids shipping the scanner's literal detection patterns.
  const distSrc = path.join(REPO, 'dist');
  if (!fs.existsSync(distSrc)) throw new Error('dist/ not found — run `npm run build` first');
  const fileCount = copyDir(distSrc, path.join(stagingDir, 'dist'), (rel) => rel === 'tools');

  // 1b) Plugin METADATA: a usable `--plugin-dir` target
  //     needs the plugin manifest + MCP registration + hooks. These reference
  //     ${CLAUDE_PLUGIN_ROOT}/dist/... and ./.mcp.json / ./hooks/hooks.json —
  //     all artifact-relative — so they resolve INSIDE the installed plugin dir,
  //     never the source repo. The contract validator (step 8b) proves it.
  copyDir(path.join(REPO, '.claude-plugin'), path.join(stagingDir, '.claude-plugin'));
  fs.copyFileSync(path.join(REPO, '.mcp.json'), path.join(stagingDir, '.mcp.json'));
  copyDir(path.join(REPO, 'hooks'), path.join(stagingDir, 'hooks'));

  // 2) Pinned PRODUCTION deps only.
  for (const dep of PROD_DEPS) {
    const src = path.join(REPO, 'node_modules', dep);
    if (!fs.existsSync(src)) throw new Error(`prod dep not installed: ${dep}`);
    copyDir(src, path.join(stagingDir, 'node_modules', dep));
  }

  // 3) Runtime package.json (prod deps + pinned runtime; no dev deps, no scripts).
  const stagedPkg = {
    name: repoPkg.name,
    version: repoPkg.version,
    type: 'module',
    bin: repoPkg.bin,
    dependencies: Object.fromEntries(PROD_DEPS.map((d) => [d, repoPkg.dependencies[d]])),
    engines: repoPkg.engines,
    license: repoPkg.license,
  };
  fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify(stagedPkg, null, 2) + '\n');

  // 4) Pinned runtime descriptor — the package runs on this Node, no compiler.
  //    Embeds version + git commit + build id.
  fs.writeFileSync(path.join(stagingDir, 'runtime.json'), JSON.stringify({
    runtime: 'node',
    enginesRange: repoPkg.engines.node,
    nativeAddons: false,
    buildToolchainRequiredAtRuntime: false,
    version: repoPkg.version,
    commit,
    buildId: BUILD_ID,
    notes: 'node:sqlite is a Node built-in (ADR 0002); all deps are pure-JS and pre-installed. No npm/Bun/node-gyp/compiler needed after install.',
  }, null, 2) + '\n');

  // 4b) Build manifest — provenance of THIS artifact. NOTE: `buildId`
  //     here is the legacy COMPATIBILITY tuple (wire value); the EXACT build id is
  //     in provenance.json (4c). builtOnPlatform/node are NON-deterministic build
  //     facts — kept for human provenance but NOT part of the deterministic
  //     identity (provenance.json is the deterministic, checksum-covered one).
  fs.writeFileSync(path.join(stagingDir, 'build-manifest.json'), JSON.stringify({
    name: repoPkg.name, version: repoPkg.version, commit, buildId: BUILD_ID,
    builtOnPlatform: `${process.platform}/${process.arch}`, node: process.version,
  }, null, 2) + '\n');

  // 4c) The NORMATIVE provenance manifest (ADR 0011). DETERMINISTIC: only
  //     version + commit + the compatibility tuple — NO timestamp, username, path,
  //     hostname, or random value. Checksum-covered (step 6), contract-validated
  //     (8b), installer-validated, and read by the installed binaries (version/
  //     doctor/registration). A missing/malformed copy fails closed at install.
  const provenance = {
    productVersion: repoPkg.version,
    buildId: exactBuildId(repoPkg.version, commit),
    sourceCommit: commit,
    compatibilityId: WIRE_COMPATIBILITY_ID,
    applicationProtocolVersion: PROTOCOL_VERSION,
    secureTransportProtocolVersion: SECURE_TRANSPORT_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
  fs.writeFileSync(path.join(stagingDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');

  // 5) Minimal SBOM (CycloneDX-ish) of the shipped dependency set.
  const components = PROD_DEPS.map((d) => {
    const dp = JSON.parse(fs.readFileSync(path.join(stagingDir, 'node_modules', d, 'package.json'), 'utf8')) as { name: string; version: string; license?: string };
    return { type: 'library', name: dp.name, version: dp.version, purl: `pkg:npm/${dp.name}@${dp.version}`, licenses: dp.license ? [{ license: { id: dp.license } }] : [] };
  });
  const sbom = { bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { type: 'application', name: stagedPkg.name, version: stagedPkg.version } }, components };
  fs.writeFileSync(path.join(stagingDir, 'sbom.json'), JSON.stringify(sbom, null, 2) + '\n');

  // 6) SHA256SUMS over every shipped file (except the sums file + marker).
  const sumsLines: string[] = [];
  for (const file of walkFiles(stagingDir)) {
    const rel = path.relative(stagingDir, file).replace(/\\/g, '/');
    if (rel === 'SHA256SUMS' || rel === '.xbus-staging') continue;
    sumsLines.push(`${sha256(file)}  ${rel}`);
  }
  sumsLines.sort();
  const sumsBody = sumsLines.join('\n') + '\n';
  fs.writeFileSync(path.join(stagingDir, 'SHA256SUMS'), sumsBody);
  // Checksum-of-the-manifest: a single value that fixes the whole artifact.
  const manifestChecksum = createHash('sha256').update(sumsBody, 'utf8').digest('hex');

  // 7) Content scan: no private paths / dev identity / secrets in the package.
  const scanHits = scanTree(stagingDir);

  // 8) Toolchain verification.
  const tc = assertNoBuildToolchain(stagingDir);

  // 9) Verify EXPECTED outputs are present — never report success on an empty/
  //    partial dir. (Superseded by the contract validator below, kept
  //    as a fast fail-fast.)
  const expected = ['package.json', 'runtime.json', 'build-manifest.json', 'sbom.json', 'SHA256SUMS', 'dist/cli/main.js', 'dist/launcher/xclaude.js', 'node_modules/uuid', 'node_modules/zod'];
  const missingOutputs = expected.filter((e) => !fs.existsSync(path.join(stagingDir, e)));

  // 8b) NORMATIVE artifact-contract validation: the SAME validator the
  //     installer + doctor + verify:release use. Proves the package is a usable
  //     --plugin-dir target and every metadata reference resolves inside it.
  const contract = validateArtifact(stagingDir, { expectedVersion: repoPkg.version, expectedBuildId: BUILD_ID, expectedCommit: commit });
  // 8c) Checksum coverage (§7): every payload file is checksummed.
  const cc = validateChecksumCoverage(stagingDir);
  // 8d) License notices: each shipped prod dep must carry a LICENSE file + the
  //     SBOM must record its license id (§6 license validation).
  for (const dep of PROD_DEPS) {
    const depDir = path.join(stagingDir, 'node_modules', dep);
    const hasLicense = fs.existsSync(depDir) && fs.readdirSync(depDir).some((f) => /^licen[sc]e/i.test(f));
    if (!hasLicense) contract.violations.push({ rule: 'license-missing', detail: `${dep} has no LICENSE file` });
    if (!components.find((c) => c.name === dep && c.licenses.length > 0)) contract.violations.push({ rule: 'license-missing', detail: `${dep} has no SBOM license id` });
  }

  return {
    stagingDir,
    version: repoPkg.version,
    commit,
    buildId: BUILD_ID,
    fileCount,
    checksums: sumsLines.length,
    manifestChecksum,
    sbomComponents: components.length,
    scanHits,
    toolchainOk: tc.ok,
    toolchainReasons: tc.reasons,
    missingOutputs,
    contractViolations: contract.violations,
    checksumCoverage: { ok: cc.ok, total: cc.totalRegularFiles, checksummed: cc.checksummedPayloadFiles, missing: cc.missingEntries, extra: cc.extraEntries, collisions: cc.normalizedCollisions },
  };
}

// CLI entry — run via `node dist/tools/package-win.js [stagingDir]`.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/package-win.js')) {
  const staging = process.argv[2] ?? path.join(REPO, 'build', 'win-package');
  let r: PackageResult;
  try { r = buildPackage(staging); }
  catch (e) { process.stderr.write(`package:win FAILED: ${(e as Error).message}\n`); process.exit(1); }
  process.stdout.write(
    `Packaged XBus ${r.version} (commit ${r.commit.slice(0, 12)}, ${r.buildId}) -> ${r.stagingDir}\n` +
    `  files: ${r.fileCount} dist + ${PROD_DEPS.length} prod deps\n` +
    `  checksums: ${r.checksums}  manifest-checksum: ${r.manifestChecksum}\n` +
    `  checksum-coverage: ${r.checksumCoverage.checksummed}/${r.checksumCoverage.total} payload files (missing ${r.checksumCoverage.missing.length}, extra ${r.checksumCoverage.extra.length})\n` +
    `  sbom components: ${r.sbomComponents}\n` +
    `  content-scan hits: ${r.scanHits.length}\n` +
    `  toolchain-free: ${r.toolchainOk}${r.toolchainOk ? '' : ' — ' + r.toolchainReasons.join('; ')}\n` +
    `  artifact-contract: ${r.contractViolations.length === 0 ? 'VALID' : r.contractViolations.length + ' violations'}\n`,
  );
  // Fail nonzero on ANY defect — never a green exit with an incomplete/invalid artifact.
  if (r.missingOutputs.length > 0) { process.stderr.write(`MISSING OUTPUTS: ${r.missingOutputs.join(', ')}\n`); process.exit(4); }
  if (r.scanHits.length > 0) { for (const h of r.scanHits) process.stderr.write(`  SCAN ${h.rule} ${h.file}:${h.line} ${h.excerpt}\n`); process.exit(2); }
  if (!r.toolchainOk) { process.stderr.write(`TOOLCHAIN: ${r.toolchainReasons.join('; ')}\n`); process.exit(3); }
  if (r.contractViolations.length > 0) { for (const cv of r.contractViolations) process.stderr.write(`  CONTRACT ${cv.rule}: ${cv.detail}\n`); process.exit(5); }
  if (!r.checksumCoverage.ok) { process.stderr.write(`CHECKSUM-COVERAGE: missing=${r.checksumCoverage.missing.join(',')} extra=${r.checksumCoverage.extra.join(',')} collisions=${r.checksumCoverage.collisions.join(',')}\n`); process.exit(6); }
  process.exit(0);
}
