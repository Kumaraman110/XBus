/**
 * Per-installation root secret (Design B). Stored ONLY in the ACL-restricted XBus
 * data directory; never logged; rotatable. Rotation invalidates existing derived
 * keys (components must re-handshake).
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateRootSecret, ROOT_SECRET_BYTES } from './secure-channel.js';
import { hardenFile, assertNotReparse } from './acl.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';

export function secretPath(dataDir: string): string {
  return path.join(dataDir, 'auth', 'root.secret');
}

function writeSecret(p: string, authDir: string, secret: Buffer): Buffer {
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
  fs.mkdirSync(authDir, { recursive: true });
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
