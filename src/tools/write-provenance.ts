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

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/write-provenance.js')) {
  const out = writeProvenance();
  process.stdout.write(`wrote ${out}\n`);
}
