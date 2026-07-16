/**
 * Beta.9 (ADR 0029): approved-runtime resolution for `agentel verify` / `agentel release-check`.
 *
 * The frictionless-operations goal: a developer or Claude Code clones AgenTel and runs ONE
 * command, and verification locates an APPROVED Node runtime WITHOUT depending on global Node,
 * npm, NVM, or PATH ordering. This module is the single, pure decision function for that.
 *
 * "Approved" for the DEVELOPMENT pipeline (build/lint/typecheck/test/npm install) means a FULL
 * Node distribution — an interpreter PLUS npm — whose version is inside the supported floor
 * [22.13, 25). (The product's BUNDLED `runtime/node.exe` is interpreter-only — perfect for
 * running the installed broker/CLI, but it cannot build or `npm ci`, so it is NOT the dev
 * runtime.) Resolution precedence, highest first:
 *
 *   1. AGENTEL_VERIFY_NODE / XBUS_VERIFY_NODE   — explicit path to a node binary (npm resolved as
 *      its sibling dist). An operator/CI override; always wins.
 *   2. A repo-vendored pinned dist              — `<repo>/.agentel/node/node[.exe]` (convention:
 *      drop the pinned Node dist here once; committed-ignore or vendored). Zero PATH dependence.
 *   3. The CURRENT process's own runtime        — process.execPath, IFF it is in-floor AND npm is
 *      resolvable from it. This is the common clean-clone case: the developer already launched
 *      the script with an in-floor Node, so re-use it — no download, no PATH edit.
 *   4. FAIL CLOSED                              — a precise, actionable remediation message naming
 *      every place checked and exactly how to supply an approved runtime.
 *
 * PURE: takes an explicit environment + fs probes so it is fully unit-testable with no real fs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { evaluateNodeSupport } from '../shared/node-support.js';

/** The repo-relative location a project may vendor a pinned Node dist into. */
export const VENDORED_RUNTIME_DIR_REL = path.join('.agentel', 'node');

/** Outcome of a resolution attempt. Exactly one of {node} or {error} is set. */
export interface RuntimeResolution {
  ok: boolean;
  /** Absolute path to the approved `node` binary (when ok). */
  nodePath?: string;
  /** Absolute path to npm-cli.js reachable from that node (when ok). */
  npmCliPath?: string;
  /** How it was resolved (for the report): 'env' | 'vendored' | 'current'. */
  source?: 'env' | 'vendored' | 'current';
  /** The resolved runtime's version string (e.g. 'v22.23.1'), when known. */
  version?: string;
  /**
   * True when the runtime is a COMPLETE dist — its `node`/`npm-cli.js` AND the platform CLI shims
   * (`npm.cmd`/`npx.cmd` on Windows, `npm`/`npx` on POSIX) are present in the dist dir. `npm ci` /
   * `npm audit` never need the shims (they run via `node npm-cli.js`), but the integration test
   * FIXTURES spawn child processes that shell out to `npm`/`npx` by name, so a full run needs a
   * complete dist. A resolution can be `ok` (build + deps work) yet `runtimeComplete:false` (the
   * test shards may fail on a no-system-Node machine) — `agentel verify` surfaces this precisely.
   */
  runtimeComplete?: boolean;
  /** Actionable remediation (when !ok). Never a raw stack. */
  error?: string;
}

/** Injected probes so the resolver is pure + unit-testable. */
export interface ResolverProbes {
  /** Does a file exist + is it a regular file? */
  isFile: (p: string) => boolean;
  /** Report a node binary's version string, or null if it can't be run/parsed. */
  nodeVersion: (nodeBinary: string) => string | null;
  /** The current process's execPath. */
  execPath: string;
  /** The current process's version (process.version). */
  currentVersion: string;
  /** Environment map (AGENTEL_VERIFY_NODE / XBUS_VERIFY_NODE read from here). */
  env: Record<string, string | undefined>;
  /** Platform ('win32' → node.exe + Windows npm layout). */
  platform: NodeJS.Platform;
}

/** node binary file name for a platform. */
function nodeBinName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * Locate npm-cli.js reachable from a given node binary. npm ships inside the Node dist under
 * `<distRoot>/node_modules/npm/bin/npm-cli.js` (all platforms) — on Windows the binary sits at
 * `<distRoot>/node.exe`; on POSIX at `<distRoot>/bin/node`. Probe both layouts. Returns the
 * npm-cli.js path or null (interpreter-only runtime, e.g. the product's bundled node.exe).
 */
export function findNpmCli(nodeBinary: string, isFile: (p: string) => boolean): string | null {
  const dir = path.dirname(nodeBinary);
  const candidates = [
    // Windows dist: node.exe and node_modules/ are siblings.
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // POSIX dist: bin/node → ../lib/node_modules/npm/bin/npm-cli.js
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // POSIX dist (flat): bin/node → ../node_modules/...
    path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    const norm = path.normalize(c);
    if (isFile(norm)) return norm;
  }
  return null;
}

/**
 * Does the dist containing `nodeBinary` also ship the CLI SHIMS that child processes invoke by
 * name (`npm.cmd`/`npx.cmd` on Windows, `npm`/`npx` on POSIX)? `npm ci`/`npm audit` do NOT need
 * these (they run `node npm-cli.js`), but the integration test fixtures spawn children that shell
 * out to `npm`/`npx`, so a COMPLETE dist is required for the full test/acceptance run on a machine
 * with no other Node. Pure via the injected `isFile` probe.
 */
export function isRuntimeComplete(nodeBinary: string, platform: NodeJS.Platform, isFile: (p: string) => boolean): boolean {
  const dir = path.dirname(nodeBinary);
  const shims = platform === 'win32'
    ? [path.join(dir, 'npm.cmd'), path.join(dir, 'npx.cmd')]
    // POSIX: bin/node → sibling bin/npm, bin/npx (symlinks to ../lib/node_modules/npm/bin/*)
    : [path.join(dir, 'npm'), path.join(dir, 'npx')];
  return shims.every((s) => isFile(path.normalize(s)));
}

/** Validate a candidate node binary: exists, in-floor, has npm. Returns a resolution or null. */
function tryCandidate(
  nodeBinary: string,
  source: 'env' | 'vendored',
  probes: ResolverProbes,
): RuntimeResolution | { rejected: string } {
  if (!probes.isFile(nodeBinary)) return { rejected: `${source}: no node binary at ${nodeBinary}` };
  const version = probes.nodeVersion(nodeBinary);
  if (!version) return { rejected: `${source}: could not read the Node version of ${nodeBinary}` };
  const support = evaluateNodeSupport(version);
  if (!support.ok) return { rejected: `${source}: ${nodeBinary} is ${version} — ${support.message}` };
  const npmCli = findNpmCli(nodeBinary, probes.isFile);
  if (!npmCli) return { rejected: `${source}: ${nodeBinary} has no resolvable npm (interpreter-only runtime cannot build/test)` };
  const runtimeComplete = isRuntimeComplete(nodeBinary, probes.platform, probes.isFile);
  return { ok: true, nodePath: nodeBinary, npmCliPath: npmCli, source, version, runtimeComplete };
}

/**
 * Resolve an approved development runtime. Pure — drive it with real probes in production and
 * fakes in tests. `repoRoot` is the clone root (for the vendored-dist probe).
 */
export function resolveApprovedRuntime(repoRoot: string, probes: ResolverProbes): RuntimeResolution {
  const rejections: string[] = [];

  // 1) Explicit override (AGENTEL_VERIFY_NODE, then legacy XBUS_VERIFY_NODE).
  const envNode = probes.env.AGENTEL_VERIFY_NODE ?? probes.env.XBUS_VERIFY_NODE;
  if (envNode) {
    const r = tryCandidate(envNode, 'env', probes);
    if ('ok' in r) return r;
    rejections.push(r.rejected);
  }

  // 2) Repo-vendored pinned dist.
  const vendored = path.join(repoRoot, VENDORED_RUNTIME_DIR_REL, nodeBinName(probes.platform));
  {
    const r = tryCandidate(vendored, 'vendored', probes);
    if ('ok' in r) return r;
    // Only note the vendored rejection if the operator actually placed something there; a
    // simple absence is the normal case and should not clutter remediation.
    if (probes.isFile(vendored)) rejections.push(r.rejected);
  }

  // 3) The current process's own runtime (the common clean-clone case).
  {
    const support = evaluateNodeSupport(probes.currentVersion);
    if (support.ok) {
      const npmCli = findNpmCli(probes.execPath, probes.isFile);
      if (npmCli) {
        const runtimeComplete = isRuntimeComplete(probes.execPath, probes.platform, probes.isFile);
        return { ok: true, nodePath: probes.execPath, npmCliPath: npmCli, source: 'current', version: probes.currentVersion, runtimeComplete };
      }
      rejections.push(`current: the running Node ${probes.currentVersion} is in-floor but npm is not resolvable from ${probes.execPath}`);
    } else {
      rejections.push(`current: the running Node ${probes.currentVersion} is out of the supported floor — ${support.message}`);
    }
  }

  // 4) Fail closed with precise remediation.
  const remediation = [
    'AgenTel verify could not locate an APPROVED Node runtime (a full Node dist with npm, version in [22.13, 25)).',
    'Checked, in order:',
    ...rejections.map((r) => `  - ${r}`),
    'To fix, do ONE of:',
    `  1. Set AGENTEL_VERIFY_NODE to an in-floor node binary (e.g. Node 22 LTS or 24) whose dist bundles npm.`,
    `  2. Vendor a pinned Node dist into ${path.join(repoRoot, VENDORED_RUNTIME_DIR_REL)} (so it needs no PATH).`,
    `  3. Launch this command with an in-floor Node yourself (nvm use 22, or a direct path).`,
    'No PATH edit or NVM install is required if you use option 1 or 2.',
  ].join('\n');
  return { ok: false, error: remediation };
}

/** Production probes bound to the real fs + a version-sniffing spawner passed by the caller. */
export function realProbes(nodeVersion: (nodeBinary: string) => string | null): ResolverProbes {
  return {
    isFile: (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
    nodeVersion,
    execPath: process.execPath,
    currentVersion: process.version,
    env: process.env,
    platform: process.platform,
  };
}
