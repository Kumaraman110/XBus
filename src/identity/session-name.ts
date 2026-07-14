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

/** The session name lifecycle (ADR 0012 Decision 2). ORTHOGONAL to connection
 *  `state` and `readiness`:
 *    'unnamed'  legacy / not-yet-named — routable by automatic_alias.
 *    'pending'  a name was requested but is unusable/taken — UNROUTABLE until chosen.
 *    'active'   a valid unique name is held — discoverable + routable by name.
 *    'retired'  name released (rename / expiry) — returns to the pool. */
export const SESSION_NAME_STATES = ['unnamed', 'pending', 'active', 'retired'] as const;
export type SessionNameState = (typeof SESSION_NAME_STATES)[number];

/** Broker-minted auto-aliases use this prefix (`aliases.ts`); a user session name
 *  must not shadow that namespace. */
const SESSION_AUTO_PREFIX = 'session-';

/** Min/max human-readable length (the `{1,47}` tail + 1 leading char ⇒ 2..48). */
export const SESSION_NAME_MIN = 2;
export const SESSION_NAME_MAX = 48;

/** ^[a-z0-9][a-z0-9._-]{1,47}$ applied to the casefolded NFC form. */
const SESSION_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,47}$/;
/** ASCII-only gate (applied BEFORE casefold) — structurally kills homoglyphs. */
const ASCII_NAME_RE = /^[A-Za-z0-9._-]+$/;
/** A name that is ENTIRELY digits (a raw process id / number). */
const ALL_NUMERIC_RE = /^[0-9]+$/;
/** Canonical UUID shape (8-4-4-4-12 hex). Other generated-id shapes are caught by the
 *  all-numeric / charset / length / reserved rules rather than this specific pattern. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Filesystem-path-like: a path separator (`/` `\`), a colon, or a `C:`-style drive
 *  letter. Redundant with the ASCII charset gate (which already excludes these), but
 *  made EXPLICIT to match ADR 0012 Decision 3's documented rejection category and to
 *  emit a specific, actionable error rather than the generic charset message. */
const PATH_LIKE_RE = /[:/\\]|^[A-Za-z]:/;

/** Administrative identities that must never be user-claimable. `local-operator` is the
 *  beta.6 reserved dashboard-operator principal (ADR 0021) — a real session must never be
 *  able to claim/shadow it. `operator` is reserved alongside it for the same reason. */
export const RESERVED_SESSION_NAMES: ReadonlySet<string> = new Set([
  'xbus', 'broker', 'admin', 'system', 'root', 'all', 'broadcast', 'self', 'none',
  'operator', 'local-operator',
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
  // Explicit path-like rejection (ADR 0012 D3) — checked BEFORE the charset gate so a
  // path gets a specific error. (The ASCII gate would also reject these, but the spec
  // calls out path-like names as their own category, so make it self-documenting.)
  if (PATH_LIKE_RE.test(nfc)) {
    throw new XBusError(
      XBusErrorCode.INVALID_SESSION_NAME,
      'session name must not be filesystem-path-like (no "/", "\\", ":", or drive letter)',
    );
  }
  // ASCII gate (pre-casefold) — a homoglyph must never reach the casefold step.
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
  if (normalized.startsWith(SESSION_AUTO_PREFIX)) {
    throw new XBusError(XBusErrorCode.INVALID_SESSION_NAME, `the "${SESSION_AUTO_PREFIX}" prefix is reserved for broker-minted aliases`);
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

/**
 * Best-effort sanitize an arbitrary label (a repo name, directory, etc.) into the
 * session-name grammar: NFC, lowercase, collapse any run of unsafe characters to a
 * single '-', drop leading non-alphanumerics, trim trailing separators, truncate to
 * the max length. Returns null when nothing usable remains. The result is NOT
 * guaranteed to pass reserved/generic checks — {@link suggestSessionName} validates.
 */
export function sanitizeToSessionName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFC').toLowerCase();
  s = s.replace(/[^a-z0-9._-]+/g, '-'); // unsafe runs -> single dash
  s = s.replace(/^[^a-z0-9]+/, '');     // must start alphanumeric
  s = s.replace(/[-._]+$/, '');         // trim trailing separators
  if (s.length > SESSION_NAME_MAX) {
    s = s.slice(0, SESSION_NAME_MAX).replace(/[-._]+$/, '');
  }
  if (s.length < SESSION_NAME_MIN) return null;
  // The sanitized form matches the charset/shape; reserved/generic are decided by
  // the caller via validateSessionName. Return it for that final check.
  return SESSION_NAME_RE.test(s) ? s : null;
}

/** Inputs for deriving a suggested session name (all optional; precedence order). */
export interface NameSuggestionInputs {
  /** A previously-saved workspace preference (highest precedence). */
  savedName?: string;
  /** The Git repository name for the workspace. */
  gitRepo?: string;
  /** The current working directory's base name. */
  dirName?: string;
  /** The agent/runtime type (claude, codex, hermes, …) for the last-resort fallback. */
  agentType?: string;
  /** A project/workspace id for the last-resort fallback. */
  projectId?: string;
}

/**
 * Derive a suggested session name (ADR 0012 Decision 3). Tries, in order: saved
 * preference → git repo → directory → `<agentType>-<projectId>`. Each candidate is
 * sanitized AND fully validated (so a reserved/generic/UUID-like candidate is
 * skipped, not suggested). Returns the first valid suggestion, or null when none
 * is usable (the caller must then enter pending_name and prompt the user).
 */
export function suggestSessionName(inp: NameSuggestionInputs): string | null {
  const candidates: Array<string | undefined> = [
    inp.savedName,
    inp.gitRepo,
    inp.dirName,
    inp.agentType && inp.projectId ? `${inp.agentType}-${inp.projectId}` : undefined,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const s = sanitizeToSessionName(c);
    if (s !== null && isValidSessionName(s)) return s;
  }
  return null;
}
