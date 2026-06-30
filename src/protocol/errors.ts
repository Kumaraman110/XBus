/**
 * Stable, machine-readable error codes for XBus.
 *
 * These codes are part of the public contract (MCP tool errors, CLI exit
 * mapping, IPC `error` frames). Details attached to an error must be
 * actionable but never sensitive (no secrets, bodies, tokens, full repo URLs).
 */

export const XBusErrorCode = {
  // Routing / recipients
  UNKNOWN_RECIPIENT: 'XBUS_UNKNOWN_RECIPIENT',
  AMBIGUOUS_RECIPIENT: 'XBUS_AMBIGUOUS_RECIPIENT',
  INVALID_ALIAS: 'XBUS_INVALID_ALIAS',
  // Sessions / identity / fencing
  /** A human-readable session name was rejected (charset, reserved, generic,
   *  UUID-like, path-like, length). Beta.4 named-session validation. */
  INVALID_SESSION_NAME: 'XBUS_INVALID_SESSION_NAME',
  /** The requested name is already owned by another ACTIVE session. Beta.4. */
  SESSION_NAME_TAKEN: 'XBUS_SESSION_NAME_TAKEN',
  /** A send targeted a session that has expired (>15 days without meaningful
   *  activity); its name was released. FINAL / non-retryable. Beta.4 retention. */
  RECIPIENT_SESSION_EXPIRED: 'XBUS_RECIPIENT_SESSION_EXPIRED',
  SESSION_NOT_REGISTERED: 'XBUS_SESSION_NOT_REGISTERED',
  SESSION_ALREADY_BOUND: 'XBUS_SESSION_ALREADY_BOUND',
  SESSION_FENCED: 'XBUS_SESSION_FENCED',
  IDENTITY_MISMATCH: 'XBUS_IDENTITY_MISMATCH',
  // Messages / lifecycle
  MESSAGE_EXPIRED: 'XBUS_MESSAGE_EXPIRED',
  MESSAGE_NOT_FOUND: 'XBUS_MESSAGE_NOT_FOUND',
  NOT_RECIPIENT: 'XBUS_NOT_RECIPIENT',
  ILLEGAL_STATE_TRANSITION: 'XBUS_ILLEGAL_STATE_TRANSITION',
  // Limits / protocol
  PAYLOAD_TOO_LARGE: 'XBUS_PAYLOAD_TOO_LARGE',
  PROTOCOL_MISMATCH: 'XBUS_PROTOCOL_MISMATCH',
  PROTOCOL_VIOLATION: 'XBUS_PROTOCOL_VIOLATION',
  FRAME_TOO_LARGE: 'XBUS_FRAME_TOO_LARGE',
  // Security / validation
  RESERVED_METADATA_KEY: 'XBUS_RESERVED_METADATA_KEY',
  RESERVED_KIND: 'XBUS_RESERVED_KIND',
  AUTH_FAILED: 'XBUS_AUTH_FAILED',
  PEERCRED_REFUSED: 'XBUS_PEERCRED_REFUSED',
  PERMISSION_RELAY_FORBIDDEN: 'XBUS_PERMISSION_RELAY_FORBIDDEN',
  FORBIDDEN_ROLE: 'XBUS_FORBIDDEN_ROLE',
  INVALID_RECEIPT: 'XBUS_INVALID_RECEIPT',
  INJECTION_NOT_FOUND: 'XBUS_INJECTION_NOT_FOUND',
  RECEIPT_EXPIRED: 'XBUS_RECEIPT_EXPIRED',
  RECEIPT_REPLAYED: 'XBUS_RECEIPT_REPLAYED',
  SESSION_ALREADY_ACTIVE: 'XBUS_SESSION_ALREADY_ACTIVE',
  BLOCKED: 'XBUS_BLOCKED',
  BROKER_ALREADY_RUNNING: 'XBUS_BROKER_ALREADY_RUNNING',
  BROKER_CONTENDED: 'XBUS_BROKER_CONTENDED',
  EPOCH_MISMATCH: 'XBUS_EPOCH_MISMATCH',
  VERSION_INCOMPATIBLE: 'XBUS_VERSION_INCOMPATIBLE',
  // Infra / capacity
  BROKER_UNAVAILABLE: 'XBUS_BROKER_UNAVAILABLE',
  CHANNEL_BLOCKED: 'XBUS_CHANNEL_BLOCKED',
  POLICY_BLOCKED: 'XBUS_POLICY_BLOCKED',
  DATABASE_ERROR: 'XBUS_DATABASE_ERROR',
  RATE_LIMITED: 'XBUS_RATE_LIMITED',
  CONN_LIMIT: 'XBUS_CONN_LIMIT',
  SLOWLORIS_TIMEOUT: 'XBUS_SLOWLORIS_TIMEOUT',
  BUFFER_BUDGET_EXCEEDED: 'XBUS_BUFFER_BUDGET_EXCEEDED',
} as const;

export type XBusErrorCode = (typeof XBusErrorCode)[keyof typeof XBusErrorCode];

/** Structured, safe-to-surface XBus error. */
export class XBusError extends Error {
  readonly code: XBusErrorCode;
  /** Optional non-sensitive structured detail (e.g. limit values, counts). */
  readonly detail?: Record<string, string | number | boolean>;

  constructor(code: XBusErrorCode, message: string, detail?: Record<string, string | number | boolean>) {
    super(message);
    this.name = 'XBusError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** Serialize to the IPC `error` frame payload / MCP error result. */
  toWire(): { code: XBusErrorCode; message: string; detail?: Record<string, string | number | boolean> } {
    return this.detail !== undefined
      ? { code: this.code, message: this.message, detail: this.detail }
      : { code: this.code, message: this.message };
  }
}

/** Type guard. */
export function isXBusError(e: unknown): e is XBusError {
  return e instanceof XBusError;
}
