/**
 * Typed adapter-SDK errors (§13). Every error carries a stable machine-readable
 * `code`, an actionable human `message`, and OPTIONAL safe structured `details`.
 *
 * Safety invariants (enforced by `safeDetails` + the redaction tests, §16.19/20):
 *   - no secret / root-secret material;
 *   - no prompt / message body;
 *   - no private filesystem path by default;
 *   - never an arbitrary exception serialization (no stack, no `cause` chain).
 */

export const AdapterErrorCode = {
  NOT_DETECTED: 'ADAPTER_NOT_DETECTED',
  MANIFEST_INVALID: 'ADAPTER_MANIFEST_INVALID',
  INCOMPATIBLE: 'ADAPTER_INCOMPATIBLE',
  CAPABILITY_UNSUPPORTED: 'ADAPTER_CAPABILITY_UNSUPPORTED',
  NOT_READY: 'ADAPTER_NOT_READY',
  PERMISSION_REQUIRED: 'ADAPTER_PERMISSION_REQUIRED',
  HEALTH_FAILED: 'ADAPTER_HEALTH_FAILED',
  DELIVERY_FAILED: 'ADAPTER_DELIVERY_FAILED',
  ACK_FAILED: 'ADAPTER_ACK_FAILED',
  REPLY_FAILED: 'ADAPTER_REPLY_FAILED',
  SHUTDOWN_FAILED: 'ADAPTER_SHUTDOWN_FAILED',
  /** Identity could not be resolved by the adapter (replaces a hard process.exit). */
  IDENTITY_UNRESOLVED: 'ADAPTER_IDENTITY_UNRESOLVED',
} as const;
export type AdapterErrorCode = (typeof AdapterErrorCode)[keyof typeof AdapterErrorCode];

/** A key/value bag known to be safe to surface (no secret/body/path by default). */
export type SafeDetails = Readonly<Record<string, string | number | boolean | null>>;

// Heuristics that keep arbitrary values out of error details. Conservative by
// design: anything that looks secret-shaped or path-shaped is dropped, not masked.
const SECRET_KEY = /secret|token|password|passwd|key|credential|cookie|auth|bearer/i;
const PATH_VALUE = /(^|[\s"'(])(?:[A-Za-z]:[\\/]|[\\/]{1,2}[A-Za-z]|~[\\/]|\.{1,2}[\\/])/;
const LONG_HEX = /\b[0-9a-f]{16,}\b/i; // secret-shaped blobs

/** Coerce an untrusted detail bag into SafeDetails: drop secret-keyed, path-shaped,
 *  or secret-shaped values; keep only primitive, non-sensitive scalars. */
export function safeDetails(input?: Record<string, unknown>): SafeDetails {
  if (!input) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY.test(k)) continue;                          // drop secret-keyed entirely
    if (v === null) { out[k] = null; continue; }
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue; }
    if (typeof v === 'string') {
      if (PATH_VALUE.test(v) || LONG_HEX.test(v)) continue;    // drop path-shaped / secret-shaped
      out[k] = v.length > 200 ? v.slice(0, 200) : v;           // bound length (no body dumps)
      continue;
    }
    // objects/arrays/functions/symbols are never serialized into details
  }
  return Object.freeze(out);
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly details: SafeDetails;
  constructor(code: AdapterErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = safeDetails(details);
  }
  /** A safe, structured projection — never includes the stack or a cause chain. */
  toSafeJSON(): { code: AdapterErrorCode; message: string; details: SafeDetails } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
