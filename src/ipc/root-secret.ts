/**
 * Per-installation root secret (Design B). Stored ONLY in the ACL-restricted XBus
 * data directory; never logged; rotatable. Rotation invalidates existing derived
 * keys (components must re-handshake).
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateRootSecret, ROOT_SECRET_BYTES } from './secure-channel.js';
import { hardenDir, hardenFile, assertNotReparse } from './acl.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';

export function secretPath(dataDir: string): string {
  return path.join(dataDir, 'auth', 'root.secret');
}

/**
 * Ensure the `auth/` directory exists AND holds its OWN self-contained ACL granting
 * the current user (+ SYSTEM). This must run before any read/write inside it.
 *
 * Windows ordering hazard (proven on a real host): the data dir is hardened with
 * `icacls /inheritance:r`, which removes inherited ACEs. If `auth/` already existed
 * when the parent's inheritance was stripped, the pre-existing child is left WITHOUT
 * an effective grant for the current process — every subsequent open/scandir/write
 * inside it fails EPERM (the file even reads as "not present" to existsSync). Re-
 * hardening `auth/` re-establishes an explicit own-ACL, so it does not depend on the
 * parent's (now-removed) inheritance. Best-effort on Unix (chmod 0700, always fine).
 */
function ensureAuthDir(authDir: string): void {
  fs.mkdirSync(authDir, { recursive: true });
  // hardenDir re-establishes access to any pre-existing children orphaned by a parent
  // `/inheritance:r` (it recurses an add-only grant across the subtree — see acl.ts), so
  // a second broker start whose auth/ + root.secret pre-exist cannot be left EPERM'd.
  try { hardenDir(authDir); } catch { /* best effort */ }
}

function writeSecret(p: string, authDir: string, secret: Buffer): Buffer {
  // Re-assert the auth dir's own ACL BEFORE writing: a parent `/inheritance:r` may
  // have orphaned a pre-existing auth/ and revoked our access (Windows), which would
  // make this tmp write fail EPERM. hardenDir here restores an explicit grant.
  ensureAuthDir(authDir);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, secret, { mode: 0o600 });
  fs.renameSync(tmp, p);
  // Real restriction (Windows ACL / Unix mode). The auth dir is hardened too.
  try { hardenFile(authDir); } catch { /* best effort */ }
  try { hardenFile(p); } catch { /* best effort */ }
  return secret;
}

/**
 * Load the root secret, creating it (hardened) on FIRST use only.
 *
 * A present-but-malformed secret file is NOT silently
 * overwritten. Doing so on an ordinary diagnostic/admin CLI invocation (doctor /
 * status) would silently invalidate a running broker's sessions. Instead we fail
 * closed with an actionable error; replacing a corrupt secret is an explicit act
 * via `forceReinit` (e.g. a future `xbus reinit-secret`), never a side effect.
 */
export function loadOrCreateRootSecret(dataDir: string, opts: { forceReinit?: boolean } = {}): Buffer {
  const p = secretPath(dataDir);
  const authDir = path.dirname(p);
  // Create AND re-harden auth/ up front so a parent inheritance-removal that orphaned
  // a pre-existing auth/ cannot make the existsSync below misreport (EPERM → "absent")
  // or block the create-branch write. See ensureAuthDir.
  ensureAuthDir(authDir);
  try { assertNotReparse(authDir); } catch { /* created fresh above */ }
  if (fs.existsSync(p)) {
    assertNotReparse(p);
    const b = fs.readFileSync(p);
    if (b.length === ROOT_SECRET_BYTES) return b;
    if (!opts.forceReinit) {
      throw new XBusError(
        XBusErrorCode.AUTH_FAILED,
        `root secret at ${p} is malformed (${b.length} bytes, expected ${ROOT_SECRET_BYTES}); refusing to silently regenerate. Stop XBus and re-initialize the secret explicitly.`,
      );
    }
    // explicit re-init requested: replace the corrupt secret.
    return writeSecret(p, authDir, generateRootSecret());
  }
  // First use: no secret yet → create one.
  return writeSecret(p, authDir, generateRootSecret());
}

/** Rotate: generate a new secret, atomically replace. Existing sessions must
 *  re-handshake (their derived keys no longer match). Returns the new secret. */
export function rotateRootSecret(dataDir: string): Buffer {
  const p = secretPath(dataDir);
  const secret = generateRootSecret();
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, secret, { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { hardenFile(p); } catch { /* best effort */ }
  return secret;
}
