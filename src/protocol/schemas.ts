/**
 * Message envelope + validation (the inbound trust boundary).
 *
 * Enforces, BEFORE any persistence:
 *  - kind allow-list (peers may only send data kinds; `system` is broker-only) — F15/I9
 *  - reserved-metadata-key rejection (permission-relay vector) — F16/I10
 *  - byte-accurate size limits (UTF-8) — counting method documented below
 *
 * Sender identity is NEVER taken from caller input here; the broker stamps it
 * from the authenticated connection. This module validates the *payload* a
 * caller may legitimately supply.
 */
import { z } from 'zod';
import { XBusError, XBusErrorCode } from './errors.js';

/** Default limits (configurable downward). Counting = UTF-8 byte length. */
export const LIMITS = {
  TEXT_BYTES: 64 * 1024,
  METADATA_ENTRIES: 32,
  METADATA_KEY_BYTES: 64,
  METADATA_VALUE_BYTES: 1024,
  ENVELOPE_BYTES: 128 * 1024,
  FRAME_BYTES: 1024 * 1024,
  ALIAS_CHARS: 128,
  IDEMPOTENCY_KEY_BYTES: 128,
} as const;

/** Peer-sendable message kinds (data plane only). `system` is broker-authored. */
export const PEER_KINDS = ['request', 'event', 'reply', 'cancel'] as const;
export type PeerKind = (typeof PEER_KINDS)[number];

/** All message kinds (includes broker-only `system`). */
export const ALL_KINDS = ['request', 'event', 'reply', 'cancel', 'system'] as const;
export type MessageKind = (typeof ALL_KINDS)[number];

/**
 * Reserved metadata keys — rejected (not silently stripped) on inbound, so an
 * attack is auditable. Comparison is NFC + ASCII-casefold + trim.
 * Also: any key containing '/', or beginning with 'claude' or 'xbus'.
 */
export const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'permission', 'permissions', 'approve', 'approval', 'approved', 'deny', 'allow',
  'mode', 'permissionmode', 'policy', 'authority', 'grant', 'escalate', 'sudo',
  'system', 'systemprompt', 'prompt', 'credential', 'credentials', 'secret',
  'token', 'role', '__proto__', 'prototype', 'constructor',
]);

export function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function normalizeKey(key: string): string {
  return key.normalize('NFC').trim().toLowerCase();
}

/** Is a metadata key reserved? (exact set + namespace + separator rules) */
export function isReservedMetadataKey(key: string): boolean {
  const k = normalizeKey(key);
  if (RESERVED_METADATA_KEYS.has(k)) return true;
  if (k.includes('/')) return true;
  if (k.startsWith('claude') || k.startsWith('xbus')) return true;
  return false;
}

/** Input a caller may supply to xbus_send (sender identity excluded by design). */
export const SendInputSchema = z
  .object({
    to: z.string().min(1),
    text: z.string(),
    kind: z.enum(['request', 'event']).default('request'),
    requiresAck: z.boolean().default(true),
    requiresReply: z.boolean().default(false),
    ttlSeconds: z.number().int().positive().optional(),
    idempotencyKey: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type SendInput = z.infer<typeof SendInputSchema>;

/**
 * Validate a send payload against limits + security rules. Throws XBusError
 * (caught by the broker → reject + audit). Returns the parsed, safe input.
 */
export function validateSendInput(raw: unknown): SendInput {
  // SECURITY (F16): scan the RAW metadata's own-property names BEFORE Zod parses,
  // because key assignment (Zod's record reconstruction) drops a literal
  // `__proto__` key via the prototype setter — which would let a
  // prototype-pollution / reserved-key payload slip past a post-parse scan.
  if (raw !== null && typeof raw === 'object' && 'metadata' in raw) {
    const md = (raw as { metadata?: unknown }).metadata;
    if (md !== null && typeof md === 'object') {
      for (const k of Object.getOwnPropertyNames(md)) {
        if (isReservedMetadataKey(k)) {
          throw new XBusError(XBusErrorCode.RESERVED_METADATA_KEY, `reserved metadata key: ${k}`);
        }
      }
    }
  }

  const parsed = SendInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new XBusError(XBusErrorCode.PROTOCOL_VIOLATION, 'invalid send input', {
      issues: parsed.error.issues.length,
    });
  }
  const input = parsed.data;

  // Kind allow-list (peer data kinds only). xbus_send restricts to request|event.
  if (!PEER_KINDS.includes(input.kind)) {
    throw new XBusError(XBusErrorCode.RESERVED_KIND, `kind not permitted: ${input.kind}`);
  }

  // Size limits (byte-accurate).
  if (byteLen(input.text) > LIMITS.TEXT_BYTES) {
    throw new XBusError(XBusErrorCode.PAYLOAD_TOO_LARGE, 'text exceeds limit', {
      limit: LIMITS.TEXT_BYTES,
      actual: byteLen(input.text),
    });
  }
  if (input.idempotencyKey && byteLen(input.idempotencyKey) > LIMITS.IDEMPOTENCY_KEY_BYTES) {
    throw new XBusError(XBusErrorCode.PAYLOAD_TOO_LARGE, 'idempotencyKey exceeds limit', {
      limit: LIMITS.IDEMPOTENCY_KEY_BYTES,
    });
  }

  // Metadata: entry count, key/value sizes, reserved-key rejection.
  if (input.metadata) {
    const entries = Object.entries(input.metadata);
    if (entries.length > LIMITS.METADATA_ENTRIES) {
      throw new XBusError(XBusErrorCode.PAYLOAD_TOO_LARGE, 'too many metadata entries', {
        limit: LIMITS.METADATA_ENTRIES,
        actual: entries.length,
      });
    }
    for (const [k, v] of entries) {
      if (isReservedMetadataKey(k)) {
        throw new XBusError(XBusErrorCode.RESERVED_METADATA_KEY, `reserved metadata key: ${k}`);
      }
      if (byteLen(k) > LIMITS.METADATA_KEY_BYTES) {
        throw new XBusError(XBusErrorCode.PAYLOAD_TOO_LARGE, 'metadata key exceeds limit', {
          limit: LIMITS.METADATA_KEY_BYTES,
        });
      }
      if (byteLen(v) > LIMITS.METADATA_VALUE_BYTES) {
        throw new XBusError(XBusErrorCode.PAYLOAD_TOO_LARGE, 'metadata value exceeds limit', {
          limit: LIMITS.METADATA_VALUE_BYTES,
        });
      }
    }
  }

  return input;
}
