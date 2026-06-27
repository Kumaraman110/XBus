/**
 * Centralized retry taxonomy + bounded backoff (reliability contract §7).
 *
 * Three disjoint dispositions:
 *  - TRANSIENT  → retry with bounded exponential backoff + full jitter.
 *  - PERMANENT  → never retry (dead-letter or reject).
 *  - WAITING    → NOT a failure and NOT an attempt; no retry budget consumed
 *                 (offline / paused / dnd / manual / waiting-for-checkpoint).
 *
 * Backoff is deterministic given an injected RNG (seeded in tests).
 */
import { XBusErrorCode } from '../protocol/errors.js';

export type RetryDisposition = 'transient' | 'permanent' | 'waiting';

/** Map an XBus error code to its retry disposition. */
const PERMANENT: ReadonlySet<string> = new Set([
  XBusErrorCode.UNKNOWN_RECIPIENT,
  XBusErrorCode.BLOCKED,
  XBusErrorCode.PROTOCOL_VIOLATION,
  XBusErrorCode.PROTOCOL_MISMATCH,
  XBusErrorCode.VERSION_INCOMPATIBLE,
  XBusErrorCode.FORBIDDEN_ROLE,
  XBusErrorCode.INVALID_RECEIPT,
  XBusErrorCode.INJECTION_NOT_FOUND,
  XBusErrorCode.RESERVED_METADATA_KEY,
  XBusErrorCode.RESERVED_KIND,
  XBusErrorCode.MESSAGE_EXPIRED,
  XBusErrorCode.PAYLOAD_TOO_LARGE,
  XBusErrorCode.INVALID_ALIAS,
  XBusErrorCode.POLICY_BLOCKED,
  XBusErrorCode.PERMISSION_RELAY_FORBIDDEN,
]);

const TRANSIENT: ReadonlySet<string> = new Set([
  XBusErrorCode.BROKER_UNAVAILABLE,
  XBusErrorCode.DATABASE_ERROR, // SQLITE_BUSY within bounded policy
  XBusErrorCode.RATE_LIMITED,
]);

/** Waiting reasons are NEITHER retryable failures NOR attempts. */
export const WAITING_REASONS = ['offline', 'paused', 'dnd', 'manual_checkpoint', 'waiting_for_human_checkpoint'] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

export function dispositionForError(code: string): RetryDisposition {
  if (PERMANENT.has(code)) return 'permanent';
  if (TRANSIENT.has(code)) return 'transient';
  // Unknown codes default to PERMANENT (fail closed — never retry-storm on an
  // unclassified error).
  return 'permanent';
}

export interface BackoffConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  /** Multiplier per attempt (2 = double). */
  factor: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  maxAttempts: 6,
  factor: 2,
};

/**
 * Compute the next delay (ms) for a TRANSIENT failure. Full jitter:
 * delay = random in [0, min(maxDelay, initial * factor^attempt)].
 * `attempt` is 0-based (0 = first retry). `rng` returns [0,1); inject for tests.
 */
export function nextBackoffMs(attempt: number, cfg: BackoffConfig, rng: () => number): number {
  const ceil = Math.min(cfg.maxDelayMs, cfg.initialDelayMs * Math.pow(cfg.factor, attempt));
  return Math.floor(rng() * ceil);
}

export function attemptsExhausted(attempt: number, cfg: BackoffConfig): boolean {
  return attempt >= cfg.maxAttempts;
}

/**
 * Per-category attempt counters (reliability contract §4 — retry counters must
 * distinguish transport vs context-injection vs ack-timeout vs reply-delivery).
 */
export interface AttemptCounters {
  transport: number;
  contextInjection: number;
  ackTimeout: number;
  replyDelivery: number;
}

export function emptyCounters(): AttemptCounters {
  return { transport: 0, contextInjection: 0, ackTimeout: 0, replyDelivery: 0 };
}
