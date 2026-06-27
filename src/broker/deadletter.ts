/**
 * Dead-letter inspection + safe redrive (reliability contract §9). A dead letter
 * is never an uninspectable dump: each record exposes safe metadata + a
 * recommended recovery action. Redrive is explicit, revalidates everything, and
 * allocates a NEW delivery identity (never silently duplicates an injected request).
 */
import type { SqliteDriver } from '../database/connection.js';
import type { Clock, IdGen } from '../shared/clock.js';
import { DeliveryState } from '../protocol/states.js';
import { safeField } from '../observability/redaction.js';

export interface DeadLetterRecord {
  messageId: string;
  sender: string;
  recipient: string;
  receiveMode: string;
  lastKnownState: string;
  failureCategory: string;
  attempts: { transport: number; injection: number; ackTimeout: number; reply: number };
  createdAt: string;
  lastAttemptAt: string | null;
  expiredAt: string | null;
  lastError: string | null;
  recommendedRecovery: string;
}

export interface RedriveResult {
  ok: boolean;
  newDeliveryId?: string;
  warning?: string;
  reason?: string;
}

export class DeadLetterStore {
  constructor(private readonly db: SqliteDriver, private readonly clock: Clock, private readonly ids: IdGen) {}

  list(): DeadLetterRecord[] {
    const rows = this.db
      .prepare(
        `SELECT d.message_id, d.state, d.failure_category, d.attempt_transport, d.attempt_injection, d.attempt_ack_timeout, d.attempt_reply, d.created_at, d.updated_at, d.last_error_code, d.next_attempt_at,
                m.sender_alias, m.recipient_alias, m.expires_at, s.receive_mode
         FROM deliveries d JOIN messages m ON m.message_id=d.message_id LEFT JOIN sessions s ON s.session_id=d.recipient_session_id
         WHERE d.state='${DeliveryState.DEAD_LETTER}' ORDER BY d.updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRecord(r));
  }

  inspect(messageId: string): DeadLetterRecord | null {
    const r = this.db
      .prepare(
        `SELECT d.message_id, d.state, d.failure_category, d.attempt_transport, d.attempt_injection, d.attempt_ack_timeout, d.attempt_reply, d.created_at, d.updated_at, d.last_error_code, d.next_attempt_at,
                m.sender_alias, m.recipient_alias, m.expires_at, s.receive_mode
         FROM deliveries d JOIN messages m ON m.message_id=d.message_id LEFT JOIN sessions s ON s.session_id=d.recipient_session_id
         WHERE d.state='${DeliveryState.DEAD_LETTER}' AND d.message_id=?`,
      )
      .get(messageId) as Record<string, unknown> | undefined;
    return r ? this.toRecord(r) : null;
  }

  private toRecord(r: Record<string, unknown>): DeadLetterRecord {
    const cat = (r.failure_category as string) ?? 'unknown';
    return {
      messageId: r.message_id as string,
      sender: r.sender_alias as string,
      recipient: r.recipient_alias as string,
      receiveMode: (r.receive_mode as string) ?? 'unknown',
      lastKnownState: r.state as string,
      failureCategory: cat,
      attempts: {
        transport: (r.attempt_transport as number) ?? 0,
        injection: (r.attempt_injection as number) ?? 0,
        ackTimeout: (r.attempt_ack_timeout as number) ?? 0,
        reply: (r.attempt_reply as number) ?? 0,
      },
      createdAt: r.created_at as string,
      lastAttemptAt: (r.updated_at as string) ?? null,
      expiredAt: (r.expires_at as string) ?? null,
      lastError: r.last_error_code ? safeField(r.last_error_code as string) : null,
      recommendedRecovery: this.recommend(cat),
    };
  }

  private recommend(category: string): string {
    switch (category) {
      case 'max_attempts': return 'Transient failures exhausted retries. Use: xbus dead-letter retry <id> (revalidated).';
      case 'recipient_gone': return 'Recipient session no longer exists. Confirm the recipient is running, then retry.';
      case 'expired': return 'Message passed its acceptance TTL. Resend a fresh message if still relevant.';
      default: return 'Inspect the failure, then retry or discard explicitly.';
    }
  }

  /**
   * Redrive a dead-lettered message: revalidate recipient/block/TTL/protocol/epoch,
   * allocate a NEW delivery attempt identity, preserve causation/audit. Never
   * silently duplicates an already-injected request — warns if history is ambiguous.
   */
  redrive(messageId: string, validate: (recipientSessionId: string, senderAliasCi: string) => { ok: boolean; reason?: string }): RedriveResult {
    return this.db.transaction(() => {
      const msg = this.db.prepare(`SELECT recipient_session_id, sender_alias, recipient_alias FROM messages WHERE message_id=?`).get(messageId) as { recipient_session_id: string; sender_alias: string; recipient_alias: string } | undefined;
      if (!msg) return { ok: false, reason: 'message not found' };
      const d = this.db.prepare(`SELECT delivery_id, state, attempt, attempt_transport, attempt_injection, attempt_ack_timeout, attempt_reply, failure_category FROM deliveries WHERE message_id=?`).get(messageId) as
        | { delivery_id: string; state: string; attempt: number; attempt_transport: number; attempt_injection: number; attempt_ack_timeout: number; attempt_reply: number; failure_category: string | null } | undefined;
      if (!d || d.state !== DeliveryState.DEAD_LETTER) return { ok: false, reason: 'not in dead_letter state' };

      const v = validate(msg.recipient_session_id, msg.sender_alias.toLowerCase());
      if (!v.ok) return { ok: false, reason: v.reason ?? 'revalidation failed' };

      // Ambiguity warning: was this message ever context-injected? If so, redrive
      // risks a duplicate in the model's context (window #7).
      const injected = this.db.prepare(`SELECT COUNT(*) n FROM context_injections WHERE message_id=?`).get(messageId) as { n: number };
      const warning = injected.n > 0 ? 'this message was previously context-injected; redrive may duplicate it in the recipient context' : undefined;

      // New delivery identity; reset to queued; preserve message + causation.
      // A redrive is a NEW delivery attempt, so its OWN attempt counters reset
      // to 0 — otherwise a message dead-lettered via
      // ack_timeout_exhausted carries attempt_ack_timeout>=maxAttempts and would
      // be re-dead-lettered on the first ack timeout, defeating the retry command.
      // The PRIOR counters are NOT erased: they are recorded immutably in the
      // DEAD_LETTER_REDRIVE audit event (history preserved).
      const now = this.clock.nowIso();
      const newDeliveryId = this.ids.next();
      this.db.prepare(`UPDATE deliveries SET delivery_id=?, state='${DeliveryState.QUEUED}', failure_category=NULL, next_attempt_at=NULL, transport_written_at=NULL, application_accepted_at=NULL, application_completed_at=NULL, lease_expires_at=NULL, lease_acquired_at=NULL, target_instance_id=NULL, target_generation=NULL, attempt=0, attempt_transport=0, attempt_injection=0, attempt_ack_timeout=0, attempt_reply=0, updated_at=? WHERE message_id=?`).run(newDeliveryId, now, messageId);
      this.db.prepare('INSERT INTO audit_events (audit_id, event_type, actor_session_id, actor_instance_id, message_id, trace_id, safe_metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)').run(this.ids.next(), 'DEAD_LETTER_REDRIVE', null, null, messageId, null, JSON.stringify({ newDeliveryId, priorDeliveryId: d.delivery_id, priorAttempts: { attempt: d.attempt, transport: d.attempt_transport, injection: d.attempt_injection, ackTimeout: d.attempt_ack_timeout, reply: d.attempt_reply }, priorFailureCategory: d.failure_category, warning }), now);
      return warning ? { ok: true, newDeliveryId, warning } : { ok: true, newDeliveryId };
    });
  }

  discard(messageId: string): boolean {
    const now = this.clock.nowIso();
    const res = this.db.prepare(`UPDATE deliveries SET state='${DeliveryState.CANCELLED}', failure_category='discarded', updated_at=? WHERE message_id=? AND state='${DeliveryState.DEAD_LETTER}'`).run(now, messageId);
    if (res.changes > 0) {
      this.db.prepare('INSERT INTO audit_events (audit_id, event_type, message_id, safe_metadata_json, created_at) VALUES (?,?,?,?,?)').run(this.ids.next(), 'DEAD_LETTER_DISCARD', messageId, '{}', now);
    }
    return res.changes > 0;
  }
}
