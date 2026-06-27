/**
 * Alias validation + normalization (routing identity).
 *
 * Hardened per security cross-review F8/F9/F10 (consolidated v3, I20):
 *  - ASCII charset only: [A-Za-z0-9_-], length 1..128. This structurally
 *    eliminates Unicode homoglyph impersonation (Cyrillic/Greek/fullwidth),
 *    bidi-override and zero-width tricks — no normalization heuristics needed.
 *  - Case-INSENSITIVE uniqueness (display preserves case; collisions decided on
 *    the lowercased `alias_ci`).
 *  - `session-` prefix is RESERVED to broker-minted auto-aliases; a user/peer
 *    alias matching it is rejected.
 */
import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import { LIMITS } from '../protocol/schemas.js';

const ALIAS_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_PREFIX = 'session-';

/** Reserved standalone names that must never be user-claimable. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'all', 'broadcast', 'self', 'main', 'system', 'everyone', 'none',
]);

export interface NormalizedAlias {
  /** As supplied (case preserved) — used for display. */
  display: string;
  /** Lowercased — used for uniqueness checks and lookups (`alias_ci`). */
  ci: string;
}

/**
 * Validate + normalize a USER-supplied alias. Throws XBusError on any rule
 * violation. The `session-` prefix is rejected here (broker-only).
 */
export function validateUserAlias(raw: string): NormalizedAlias {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new XBusError(XBusErrorCode.INVALID_ALIAS, 'alias must be a non-empty string');
  }
  if (raw.length > LIMITS.ALIAS_CHARS) {
    throw new XBusError(XBusErrorCode.INVALID_ALIAS, 'alias too long', { limit: LIMITS.ALIAS_CHARS });
  }
  if (!ALIAS_RE.test(raw)) {
    throw new XBusError(
      XBusErrorCode.INVALID_ALIAS,
      'alias must match [A-Za-z0-9_-] (ASCII only)',
    );
  }
  const ci = raw.toLowerCase();
  if (ci.startsWith(SESSION_PREFIX)) {
    throw new XBusError(XBusErrorCode.INVALID_ALIAS, 'the "session-" prefix is reserved');
  }
  if (RESERVED_NAMES.has(ci)) {
    throw new XBusError(XBusErrorCode.INVALID_ALIAS, `reserved alias: ${ci}`);
  }
  return { display: raw, ci };
}

/**
 * Mint the automatic fallback alias for a session. Broker-only path; bypasses
 * the `session-` prefix rejection by construction.
 */
export function automaticAlias(sessionId: string): NormalizedAlias {
  const safe = sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'unknown0';
  const display = `${SESSION_PREFIX}${safe}`;
  return { display, ci: display.toLowerCase() };
}

/**
 * Parse a recipient string into its routing form. NO fuzzy matching.
 *   "<sessionId>"            -> { kind: 'session' }  (looks like a UUID)
 *   "<project>/<alias>"      -> { kind: 'qualified' }
 *   "<alias>"                -> { kind: 'alias' }
 */
export type RecipientRef =
  | { kind: 'session'; sessionId: string }
  | { kind: 'qualified'; projectAlias: string; alias: string }
  | { kind: 'alias'; alias: string };

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function parseRecipient(raw: string): RecipientRef {
  const r = raw.trim();
  if (r.length === 0) throw new XBusError(XBusErrorCode.UNKNOWN_RECIPIENT, 'empty recipient');
  if (UUID_RE.test(r)) return { kind: 'session', sessionId: r };
  const slash = r.indexOf('/');
  if (slash >= 0) {
    const projectAlias = r.slice(0, slash);
    const alias = r.slice(slash + 1);
    if (r.indexOf('/', slash + 1) >= 0) {
      throw new XBusError(XBusErrorCode.INVALID_ALIAS, 'qualified recipient allows exactly one "/"');
    }
    // Validate both halves as aliases (ASCII rule applies).
    validateRecipientAliasPart(projectAlias);
    validateRecipientAliasPart(alias);
    return { kind: 'qualified', projectAlias, alias };
  }
  validateRecipientAliasPart(r);
  return { kind: 'alias', alias: r };
}

/** Recipient alias parts may reference broker-minted `session-` aliases, so the
 *  prefix rule does NOT apply here — only the charset/length rules do. */
function validateRecipientAliasPart(part: string): void {
  if (!ALIAS_RE.test(part)) {
    throw new XBusError(XBusErrorCode.INVALID_ALIAS, `invalid alias in recipient: charset/length`);
  }
}
