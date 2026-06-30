/**
 * Write the repo-root provenance.json at build time (see ADR 0011).
 *
 * `provenance.json` is a REQUIRED plugin-payload file (the installer + contract
 * require it, and installed binaries read the EXACT build identity from it with no
 * git). The packager generates its own copy into the artifact; this build step
 * writes the equivalent file to the repo root so that:
 *   - a dev install from a built repo (`xbus install` with source = repo) is a
 *     valid plugin payload, and
 *   - `xbus version` / `doctor` run from a built repo report a real (commit-bearing)
 *     identity rather than the 'source' fallback.
 *
 * Deterministic: version + git commit + compatibility tuple only — no timestamp,
 * username, path, hostname, or random value. Run as the `postbuild` script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { XBUS_VERSION, PROTOCOL_VERSION } from '../protocol/version.js';
import { SCHEMA_VERSION, WIRE_COMPATIBILITY_ID } from '../protocol/handshake.js';
import { exactBuildId, SECURE_TRANSPORT_VERSION } from '../shared/build-identity.js';

const REPO = process.env.XBUS_REPO_ROOT ?? process.cwd();

function gitCommit(): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); }
  catch { return 'source'; }
}

export function writeProvenance(repo = REPO): string {
  const commit = gitCommit();
  const provenance = {
    productVersion: XBUS_VERSION,
    buildId: exactBuildId(XBUS_VERSION, commit),
    sourceCommit: commit,
    compatibilityId: WIRE_COMPATIBILITY_ID,
    applicationProtocolVersion: PROTOCOL_VERSION,
    secureTransportProtocolVersion: SECURE_TRANSPORT_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
  const out = path.join(repo, 'provenance.json');
  fs.writeFileSync(out, JSON.stringify(provenance, null, 2) + '\n');
  return out;
}

/**
 * §8 — build-time version-consistency gate. The product version is consumed in three
 * tracked places that MUST agree, or a clean install fails contract validation
 * (metadata-version-disagree) and rolls back. Fail the BUILD here (postbuild, before
 * any install/package can mutate user state) on any disagreement. XBUS_VERSION is the
 * authoritative source; package.json and .claude-plugin/plugin.json are validated
 * consumers, and provenance.json is GENERATED from XBUS_VERSION above.
 */
export function assertVersionConsistency(repo = REPO): void {
  const read = (rel: string): string => (JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8')) as { version?: string }).version ?? '';
  const pkg = read('package.json');
  const plugin = read(path.join('.claude-plugin', 'plugin.json'));
  const disagreements: string[] = [];
  if (pkg !== XBUS_VERSION) disagreements.push(`package.json (${pkg}) != XBUS_VERSION (${XBUS_VERSION})`);
  if (plugin !== XBUS_VERSION) disagreements.push(`.claude-plugin/plugin.json (${plugin}) != XBUS_VERSION (${XBUS_VERSION})`);
  if (disagreements.length) {
    throw new Error(
      `BUILD FAILED — product version disagreement (a clean install would fail contract validation and roll back):\n  - ${disagreements.join('\n  - ')}\n`
      + `Reconcile all of: src/protocol/version.ts XBUS_VERSION, package.json "version", .claude-plugin/plugin.json "version".`,
    );
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/write-provenance.js')) {
  assertVersionConsistency();           // fail the build BEFORE writing provenance on a mismatch
  const out = writeProvenance();
  process.stdout.write(`wrote ${out} (version ${XBUS_VERSION}; consistency OK)\n`);
}
