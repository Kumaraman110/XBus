/**
 * Session-name validation + normalization (beta.4, ADR 0012 Decision 3).
 *
 * A session name is the user-facing, human-readable, case-insensitively-unique
 * routing handle for an active session. It is deliberately STRICTER than a routing
 * alias (`aliases.ts`: `^[A-Za-z0-9_-]{1,128}$`):
 *
 *   ^[a-z0-9][a-z0-9._-]{1,47}$   (after NFC; length 2..48; must start alphanumeric)
 *
 * and is additionally rejected if it is reserved (`xbus`/`broker`/`admin`/`system`),
 * generic (`session`/`agent`/`claude`/`default`/`test`/`new-session`), all-numeric
 * (process-id-like), UUID-like, or filesystem-path-like.
 *
 * SECURITY: the ASCII charset is enforced on the NFC form BEFORE casefolding, so a
 * Unicode homoglyph (Cyrillic `а`, fullwidth, zero-width, bidi) can never normalize
 * INTO a name that collides with a legitimate ASCII one — the same structural
 * homoglyph defense the alias validator uses. Display case is preserved; uniqueness
 * is decided on the lowercased `normalized` form.
 */
import { XBusError, XBusErrorCode } from '../protocol/errors.js';

/** Min/max human-readable length (the `{1,47}` tail + 1 leading char ⇒ 2..48). */
export const SESSION_NAME_MIN = 2;
export const SESSION_NAME_MAX = 48;

/** ^[a-z0-9][a-z0-9._-]{1,47}$ applied to the casefolded NFC form. */
const SESSION_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,47}$/;
/** ASCII-only gate (applied BEFORE casefold) — structurally kills homoglyphs. */
const ASCII_NAME_RE = /^[A-Za-z0-9._-]+$/;
/** A name that is ENTIRELY digits (a raw process id / number). */
const ALL_NUMERIC_RE = /^[0-9]+$/;
/** Canonical UUID shape, and the looser hex-blocks-with-dashes generated-id shape. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Administrative identities that must never be user-claimable. */
export const RESERVED_SESSION_NAMES: ReadonlySet<string> = new Set([
  'xbus', 'broker', 'admin', 'system', 'root', 'all', 'broadcast', 'self', 'none',
]);

/** Low-signal placeholder names a user should be challenged to replace. */
export const GENERIC_SESSION_NAMES: ReadonlySet<string> = new Set([
  'session', 'agent', 'claude', 'codex', 'hermes', 'default', 'test', 'temp',
  'new-session', 'new', 'untitled', 'example', 'sample', 'foo', 'bar',
]);

export interface NormalizedSessionName {
  /** As supplied (case preserved) — used for display. */
  display: string;
  /** NFC + lowercased — used for uniqueness checks and lookups. */
  normalized: string;
}

/** Casefold a raw name to its uniqueness key (NFC then lowercase). Does NOT validate. */
export function normalizeSessionName(raw: string): string {
  return raw.normalize('NFC').toLowerCase();
}

/**
 * Validate + normalize a user-supplied session name. Throws
 * `XBusError(INVALID_SESSION_NAME)` on any rule violation; otherwise returns the
 * display + normalized forms. Pure — active-uniqueness is enforced separately at
 * the DB layer (`ux_session_name_active`).
 */
export function validateSessionName(raw: unknown): NormalizedSessionName {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new XBusError(XBusErrorCode.INVALID_SESSION_NAME, 'session name must be a non-empty string');
  }
  const nfc = raw.normalize('NFC');
  // ASCII gate FIRST (pre-casefold) — a homoglyph must never reach the casefold step.
  if (!ASCII_NAME_RE.test(nfc)) {
    throw new XBusError(
      XBusErrorCode.INVALID_SESSION_NAME,
      'session name must be ASCII [a-z0-9._-] (no spaces, symbols, or Unicode look-alikes)',
    );
  }
  if (nfc.length < SESSION_NAME_MIN || nfc.length > SESSION_NAME_MAX) {
    throw new XBusError(XBusErrorCode.INVALID_SESSION_NAME, 'session name length must be 2..48', {
      min: SESSION_NAME_MIN, max: SESSION_NAME_MAX,
    });
  }
  const normalized = nfc.toLowerCase();
  if (!SESSION_NAME_RE.test(normalized)) {
    throw new XBusError(
      XBusErrorCode.INVALID_SESSION_NAME,
      'session name must match [a-z0-9][a-z0-9._-]{1,47} (start with a letter or digit)',
    );
  }
  if (RESERVED_SESSION_NAMES.has(normalized)) {
    throw new XBusError(XBusErrorCode.INVALID_SESSION_NAME, `reserved session name: ${normalized}`);
  }
  if (GENERIC_SESSION_NAMES.has(normalized)) {
    throw new XBusError(
      XBusErrorCode.INVALID_SESSION_NAME,
      `"${normalized}" is too generic — choose a name that identifies this session`,
    );
  }
  if (ALL_NUMERIC_RE.test(normalized)) {
    throw new XBusError(XBusErrorCode.INVALID_SESSION_NAME, 'session name must not be all digits');
  }
  if (UUID_RE.test(normalized)) {
    throw new XBusError(XBusErrorCode.INVALID_SESSION_NAME, 'session name must not look like a generated id');
  }
  return { display: raw, normalized };
}

/** Boolean mirror of {@link validateSessionName} (no throw). */
export function isValidSessionName(raw: unknown): boolean {
  try {
    validateSessionName(raw);
    return true;
  } catch {
    return false;
  }
}
