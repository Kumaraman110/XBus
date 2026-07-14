/**
 * The XBus-owned bundled Node runtime (beta.7 Phase 3, ADR 0022).
 *
 * XBus ships its OWN Node runtime inside the Windows artifact (`runtime/node.exe`) so a user
 * never installs, selects, downgrades, or configures Node. Every installed entry point — the
 * broker, CLI, hooks, launcher, doctor, repair, uninstall — is launched by THIS binary via the
 * user-scope Claude config `command` (the bundled path), NOT the ambient system Node/PATH.
 *
 * The runtime is a plain interpreter binary, not a build tool or a to-be-compiled native addon
 * (`.exe`, not `.node`), so the toolchain-free artifact contract still holds
 * (`buildToolchainRequiredAtRuntime: false`). It lives INSIDE the installed plugin dir
 * (`<pluginDir>/runtime/node.exe`), so the existing atomic stage->rename install swap + the
 * DB-snapshot rollback upgrade it atomically and preserve data on failure with NO new machinery.
 *
 * Determinism: the pinned binary is byte-identical across builds, so the reproducible STORE zip
 * + whole-tree SHA256SUMS cover it without breaking determinism. The builder supplies the vetted
 * binary via `XBUS_BUNDLED_NODE`; the packager asserts its version is in-range and (when a SHA is
 * pinned) that its bytes match — recording `bundledNodeVersion` (deterministic constant) in
 * provenance, never the builder's own `process.version`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { evaluateNodeSupport } from './node-support.js';

/**
 * The PINNED bundled runtime version. Deterministic — embedded in provenance + reported by
 * doctor. Must satisfy the Node floor [22.13, 25) (node:sqlite readOnly + not-yet-validated 25).
 * Bumping the bundled runtime is a deliberate, reviewed act: change this literal + re-vet the
 * binary supplied via XBUS_BUNDLED_NODE.
 */
export const BUNDLED_NODE_VERSION = '22.23.1';

/**
 * Optional pinned SHA-256 of the exact `node.exe` bytes for supply-chain integrity. When set,
 * the packager asserts the supplied binary matches; when empty, only the version is asserted
 * (a maintainer bootstrapping a new pin). Recorded out-of-band in the ADR, not required at
 * runtime (the installed contract's whole-tree SHA256SUMS already fixes the installed bytes).
 */
export const BUNDLED_NODE_SHA256 = 'f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed';

/** The artifact-relative + installed-relative location of the bundled runtime binary. */
export const BUNDLED_RUNTIME_REL = 'runtime/node.exe';

/** The bundled runtime's absolute path inside an installed/artifact plugin root. */
export function bundledNodePath(pluginRoot: string): string {
  return path.join(pluginRoot, 'runtime', 'node.exe');
}

/** Is a bundled runtime present at this plugin root? */
export function hasBundledRuntime(pluginRoot: string): boolean {
  try { return fs.statSync(bundledNodePath(pluginRoot)).isFile(); } catch { return false; }
}

/** Assert the PINNED bundled version satisfies the supported Node floor (build-time guard). */
export function assertPinnedRuntimeInRange(): void {
  const s = evaluateNodeSupport('v' + BUNDLED_NODE_VERSION);
  if (!s.ok) {
    throw new Error(`bundled runtime version ${BUNDLED_NODE_VERSION} is outside the supported Node floor: ${s.message}`);
  }
}
