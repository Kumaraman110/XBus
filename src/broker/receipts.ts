/**
 * Context-injection records + connection-bound authorization (ADR 0006).
 *
 * An injection records that a specific message was context-injected for a
 * specific (session, epoch) at a checkpoint. The MODEL sees only a non-secret
 * reference (injection_id + message_id). Authorization for ack/reply is bound to
 * the AUTHENTICATED CONNECTION (session + epoch + role), NOT a bearer token, so a
 * leaked injection_id grants nothing without the matching connection.
 *
 * A capability hash column is retained (NULLABLE) for optional defense-in-depth
 * but is not the authorization path.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { SqliteDriver } from '../database/connection.js';
import type { Clock, IdGen } from '../shared/clock.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';

export function hashCapability(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface IssuedInjection {
  injectionId: string;
}

export interface InjectionValidation {
  injectionId: string;
  messageId: string;
  recipientSessionId: string;
  recipientEpoch: number;
}

export class ReceiptStore {
  constructor(
    private readonly db: SqliteDriver,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    private readonly ttlMs: number = 30 * 60_000,
    // Retained for optional defense-in-depth binding; not the auth path.
    private readonly randomFn: () => string = () => randomBytes(24).toString('base64url'),
  ) {}

  /**
   * Record a context injection (reliability contract §6). AT-MOST-ONCE per
   * (message_id, recipient_epoch, logical_injection_number=1): the unique index
   * `ux_injection_logical` is the durable guard. Idempotent per (message,
   * checkpoint) too. Returns the non-secret injectionId on first record, else null
   * (already injected for this epoch — the duplicate is BLOCKED, not re-injected).
   */
  issue(params: { messageId: string; recipientSessionId: string; recipientEpoch: number; checkpointId: string; componentId: string; logicalInjectionNumber?: number }): IssuedInjection | null {
    const logical = params.logicalInjectionNumber ?? 1;
    // Already injected for this (message, epoch, logical#)? -> at-most-once.
    const existing = this.db
      .prepare('SELECT injection_id FROM context_injections WHERE message_id=? AND recipient_epoch=? AND logical_injection_number=?')
      .get(params.messageId, params.recipientEpoch, logical) as { injection_id: string } | undefined;
    if (existing) return null;
    const injectionId = this.ids.next();
    const now = this.clock.nowIso();
    const expiresAt = new Date(this.clock.nowMs() + this.ttlMs).toISOString();
    const capHash = hashCapability(this.randomFn());
    try {
      this.db
        .prepare(
          'INSERT INTO context_injections (injection_id, message_id, recipient_session_id, recipient_epoch, checkpoint_id, injected_by_component_id, receipt_capability_hash, injected_at, expires_at, logical_injection_number) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(injectionId, params.messageId, params.recipientSessionId, params.recipientEpoch, params.checkpointId, params.componentId, capHash, now, expiresAt, logical);
    } catch (e) {
      // A concurrent insert hit the unique index first → already injected.
      if (/UNIQUE|constraint/i.test((e as Error).message)) return null;
      throw e;
    }
    return { injectionId };
  }

  /**
   * Authorize an ack/reply by CONNECTION IDENTITY (ADR 0006). The caller proves
   * session+epoch via its authenticated connection; we require a recorded
   * injection for this message to that exact session+epoch. `injectionId` (the
   * non-secret reference) disambiguates when present but is NOT the secret.
   */
  authorize(op: 'ack' | 'reply', ctx: { messageId: string; sessionId: string; epoch: number; injectionId?: string }): InjectionValidation {
    const row = (ctx.injectionId
      ? this.db.prepare('SELECT injection_id, message_id, recipient_session_id, recipient_epoch, expires_at, consumed_at, consumed_op FROM context_injections WHERE injection_id=?').get(ctx.injectionId)
      : this.db.prepare('SELECT injection_id, message_id, recipient_session_id, recipient_epoch, expires_at, consumed_at, consumed_op FROM context_injections WHERE message_id=? AND recipient_session_id=? AND recipient_epoch=? ORDER BY injected_at DESC LIMIT 1').get(ctx.messageId, ctx.sessionId, ctx.epoch)) as
      | { injection_id: string; message_id: string; recipient_session_id: string; recipient_epoch: number; expires_at: string; consumed_at: string | null; consumed_op: string | null }
      | undefined;

    if (!row) throw new XBusError(XBusErrorCode.INJECTION_NOT_FOUND, 'no context injection for this message (it must be delivered at a checkpoint first)');
    if (row.message_id !== ctx.messageId) throw new XBusError(XBusErrorCode.INJECTION_NOT_FOUND, 'injection does not match message');
    // CONNECTION-IDENTITY checks: a leaked injectionId from another session/epoch fails here.
    if (row.recipient_session_id !== ctx.sessionId) throw new XBusError(XBusErrorCode.NOT_RECIPIENT, 'injection belongs to a different session');
    if (row.recipient_epoch !== ctx.epoch) throw new XBusError(XBusErrorCode.EPOCH_MISMATCH, 'injection is for a superseded epoch');
    if (row.expires_at <= this.clock.nowIso()) throw new XBusError(XBusErrorCode.RECEIPT_EXPIRED, 'injection expired');
    if (row.consumed_op === op) throw new XBusError(XBusErrorCode.RECEIPT_REPLAYED, `injection already used for ${op}`);
    return { injectionId: row.injection_id, messageId: row.message_id, recipientSessionId: row.recipient_session_id, recipientEpoch: row.recipient_epoch };
  }

  consume(injectionId: string, op: 'ack' | 'reply'): void {
    this.db.prepare('UPDATE context_injections SET consumed_at=?, consumed_op=? WHERE injection_id=?').run(this.clock.nowIso(), op, injectionId);
  }
}
