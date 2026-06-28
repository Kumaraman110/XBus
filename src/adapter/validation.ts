/**
 * Adapter loading-time security validation (§15). PR1 does NOT auto-load any
 * third-party adapter and ships no registry — these are the containment checks an
 * eventual loader MUST apply. They are pure + testable now so the contract is fixed
 * before any loader exists.
 *
 *   - manifest validation before loading (delegated to manifest.ts);
 *   - package-root + entrypoint containment (no absolute path, no `..` escape);
 *   - reparse/symlink rejection where relevant (reuses ipc/acl.ts);
 *   - explicit permission gating (default-deny);
 *   - no dynamic arbitrary module path; no automatic remote download/install.
 */

import path from 'node:path';
import { AdapterError, AdapterErrorCode } from './errors.js';
import { assertNotReparse } from '../ipc/acl.js';
import type { AdapterManifest, AdapterPermission } from './manifest.js';
import { hasPermission } from './manifest.js';

/**
 * Resolve an adapter's entrypoint to an absolute path that is PROVEN to be inside
 * the package root. Throws AdapterError(MANIFEST_INVALID) on any escape. Does not
 * read or execute anything — pure path containment.
 */
export function resolveContainedEntrypoint(packageRoot: string, entrypoint: string): string {
  const root = path.resolve(packageRoot);
  // entrypoint must be relative (manifest.ts already rejected absolute/URL/`..`),
  // but re-prove containment after resolution as defense-in-depth.
  const resolved = path.resolve(root, entrypoint);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AdapterError(AdapterErrorCode.MANIFEST_INVALID, 'entrypoint escapes the package root', { });
  }
  return resolved;
}

/**
 * Assert neither the package root nor the resolved entrypoint is a reparse point /
 * symlink (a junction could redirect loading outside the contained tree). Reuses the
 * shipping `assertNotReparse`. Skips gracefully if the path does not exist yet
 * (loader-time concern); throws AdapterError on a detected reparse.
 */
export function assertEntrypointNotReparse(packageRoot: string, resolvedEntrypoint: string): void {
  for (const target of [packageRoot, resolvedEntrypoint]) {
    try {
      assertNotReparse(target);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Only treat an actual reparse/symlink rejection as fatal; a not-found path
      // is a loader concern, not a security failure here.
      if (/reparse|symlink|junction/i.test(msg)) {
        throw new AdapterError(AdapterErrorCode.MANIFEST_INVALID, `adapter path rejected: ${msg}`, {});
      }
    }
  }
}

/**
 * Gate a capability that REQUIRES a permission. Default-deny: an adapter that did not
 * DECLARE the permission in its manifest cannot use the capability, regardless of
 * what it reports at runtime. Throws AdapterError(PERMISSION_REQUIRED).
 */
export function requirePermission(manifest: AdapterManifest, permission: AdapterPermission): void {
  if (!hasPermission(manifest, permission)) {
    throw new AdapterError(AdapterErrorCode.PERMISSION_REQUIRED,
      `adapter '${manifest.adapter.id}' requires the '${permission}' permission, which it did not declare`,
      { permission, adapter: manifest.adapter.id });
  }
}

/** True iff the manifest declared the permission (default-deny convenience reader). */
export function isPermitted(manifest: AdapterManifest, permission: AdapterPermission): boolean {
  return hasPermission(manifest, permission);
}
