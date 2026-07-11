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
 * Atomically create the secret file if and only if it does not already exist, and
 * return the secret that is NOW authoritative on disk.
 *
 * CONCURRENCY (first-writer-wins): two brokers racing a genuine first-run create — both
 * passed checkSingleton before either bound, an explicitly designed-for race (ensure.ts)
 * — MUST converge on ONE on-disk secret. The old tmp-write + `renameSync` was
 * last-writer-wins: the bind winner could hold secret S_B in memory while a loser's
 * rename left S_C on disk, so every client (which derives keys from the DISK secret)
 * would fail the handshake against the winner's in-memory S_B — all auth broken until a
 * manual restart. Fix: tmp-write + hard-`linkSync` (NOT rename). `link` fails EEXIST when
 * the path already exists, so the FIRST writer wins; any loser deletes its tmp, reads the
 * winner's secret, and returns THAT. Every racer — including the eventual bind winner —
 * therefore ends holding the exact secret that is on disk. Preserves the old atomic
 * no-partial-file guarantee (the final path only ever appears via link of a fully-written
 * tmp). tmp is per-pid so two racers never collide on the tmp name itself.
 */
export function writeSecretExclusive(p: string, authDir: string, secret: Buffer): Buffer {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, secret, { mode: 0o600 });
  const winner = secret;
  try {
    fs.linkSync(tmp, p); // atomic create-if-absent; EEXIST if another writer already won
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      // A concurrent create won the race — ADOPT its secret; never overwrite it.
      const existing = fs.readFileSync(p);
      if (existing.length !== ROOT_SECRET_BYTES) {
        throw new XBusError(
          XBusErrorCode.AUTH_FAILED,
          `root secret at ${p} appeared malformed (${existing.length} bytes) after a concurrent create; stop XBus and re-initialize`,
        );
      }
      return existing;
    }
    throw e;
  }
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  // Real restriction (Windows ACL / Unix mode). This runs ONLY on create/re-init (rare —
  // first use), so the icacls spawns are off the hot path. The auth DIRECTORY is hardened
  // with hardenDir (0700 on Unix / inheritance-strip + recursive re-grant on Windows) —
  // NOT hardenFile, which would chmod a directory to 0600 and drop the traversal bit.
  try { hardenDir(authDir); } catch { /* best effort */ }
  try { hardenFile(p); } catch { /* best effort */ }
  return winner;
}

/**
 * Try to read an existing, well-formed secret. Returns the bytes, or null if the file
 * is genuinely absent. Throws on a present-but-malformed file (unless forceReinit).
 *
 * Cheap by design: NO icacls on this path. It is called on EVERY handshake
 * (verifyCompatible → loadOrCreateRootSecret), so it must not spawn subprocesses.
 */
function tryReadSecret(p: string, forceReinit: boolean): Buffer | null {
  if (!fs.existsSync(p)) return null;
  assertNotReparse(p);
  const b = fs.readFileSync(p);
  if (b.length === ROOT_SECRET_BYTES) return b;
  if (!forceReinit) {
    throw new XBusError(
      XBusErrorCode.AUTH_FAILED,
      `root secret at ${p} is malformed (${b.length} bytes, expected ${ROOT_SECRET_BYTES}); refusing to silently regenerate. Stop XBus and re-initialize the secret explicitly.`,
    );
  }
  return null; // forceReinit: treat malformed as "recreate"
}

/**
 * Load the root secret, creating it (hardened) on FIRST use only.
 *
 * Performance contract: the COMMON path (secret already exists) does a plain read with
 * NO icacls subprocess — it is on every handshake, so it must stay cheap and
 * concurrency-safe. The recursive ACL re-grant (which spawns icacls) runs ONLY as
 * RECOVERY when access is actually broken, and hardening runs ONLY on create/re-init.
 *
 * A present-but-malformed secret file is NOT silently overwritten. Doing so on an
 * ordinary diagnostic/admin CLI invocation (doctor / status) would silently invalidate
 * a running broker's sessions. Instead we fail closed with an actionable error;
 * replacing a corrupt secret is an explicit act via `forceReinit`, never a side effect.
 */
export function loadOrCreateRootSecret(dataDir: string, opts: { forceReinit?: boolean } = {}): Buffer {
  const p = secretPath(dataDir);
  const authDir = path.dirname(p);
  const forceReinit = opts.forceReinit === true;
  fs.mkdirSync(authDir, { recursive: true });
  try { assertNotReparse(authDir); } catch { /* created fresh above */ }

  // Hot path: read an existing secret with NO icacls. On the common case (secret
  // present + readable) this is the ONLY work done — no subprocess spawned. Every path
  // that does NOT return here falls through to the ACL-recovery + create branch below.
  try {
    const existing = tryReadSecret(p, forceReinit);
    if (existing) return existing;
    // existsSync said "not there" — but on Windows an ACL-orphan can LIE (below).
  } catch (e) {
    // A Windows ACL-orphan (parent `/inheritance:r` stripped a pre-existing auth/'s
    // inherited grant) surfaces as EPERM on open/scandir. RECOVER: recursively re-grant
    // access to auth/ (icacls, only now), then retry the read once. Any non-permission
    // error (e.g. the malformed-secret XBusError) rethrows unchanged.
    const code = (e as { code?: string }).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
    try { hardenDir(authDir); } catch { /* best effort */ }
    const recovered = tryReadSecret(p, forceReinit);
    if (recovered) return recovered;
  }

  // We only get here when the fast read reported ABSENCE (or an EPERM we couldn't
  // recover-read above). On Windows an orphaned pre-existing secret can read as absent
  // to existsSync, so before creating we re-grant access and re-read ONCE — if a valid
  // secret reappears it MUST be loaded, never overwritten (that would silently rotate a
  // live broker's key / regenerate a planted secret). This icacls is OFF the hot path:
  // it runs only after the cheap read already failed to find a usable secret.
  try { hardenDir(authDir); } catch { /* best effort */ }
  if (!forceReinit) {
    const reappeared = tryReadSecret(p, false);
    if (reappeared) return reappeared;
  }

  // Create branch. auth/ access was just re-granted above, so the tmp write cannot
  // EPERM on an orphaned dir.
  //  - genuine first use: exclusive create (first-writer-wins) so two racing first-run
  //    brokers converge on ONE on-disk secret and every racer returns THAT (see
  //    writeSecretExclusive). This is the concurrent-create fix.
  //  - forceReinit: an EXPLICIT operator replace of a malformed secret — it MUST
  //    overwrite (last-writer), never adopt the malformed/existing file, so it keeps the
  //    deliberate rename path.
  if (forceReinit) {
    const tmp = `${p}.tmp-${process.pid}`;
    const secret = generateRootSecret();
    fs.writeFileSync(tmp, secret, { mode: 0o600 });
    fs.renameSync(tmp, p);
    try { hardenDir(authDir); } catch { /* best effort */ }
    try { hardenFile(p); } catch { /* best effort */ }
    return secret;
  }
  return writeSecretExclusive(p, authDir, generateRootSecret());
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
