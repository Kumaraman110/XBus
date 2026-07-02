/**
 * Delivery + checkpoint + ack + reply operations on the broker store.
 * Kept separate from registration/send (store.ts) for file-ownership clarity.
 *
 * Checkpoint semantics (hook_checkpoint transport): when a recipient session
 * reaches a supported checkpoint, the broker hands it the pending messages in
 * recipient-sequence order and marks them transport_written (the ack deadline
 * starts HERE — at injection — not at enqueue). The receiver then calls
 * xbus_ack / xbus_reply.
 */
import { createHash } from 'node:crypto';
import type { SqliteDriver } from '../database/connection.js';
import type { Clock, IdGen } from '../shared/clock.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import { DeliveryState } from '../protocol/states.js';
import type { SessionAuthority, SendResult } from './store.js';
import { MEANINGFUL_ACTIVITY_RETENTION_MS } from './store.js';
import { ReceiptStore } from './receipts.js';
import { ControlsStore } from './controls.js';
import { assertAllowed, Operation, ComponentRole } from '../identity/components.js';
import { acceptsInjection, isReadiness, type Readiness } from './readiness.js';

/** Non-secret injection reference surfaced to Claude (ADR 0006). Authorization is
 *  bound to the authenticated connection, so this id is safe in transcripts. */
export const INJECTION_METADATA_KEY = 'xbus_injection_id';

/** Inbox entry state (reliability contract §1) — distinguishes whether the body
 *  has already been presented to the model, so a recovery pull never re-shows it. */
export type InboxEntryState =
  | 'queued_not_injected'
  | 'context_injected_unacknowledged'
  | 'application_accepted'
  | 'application_completed';

/**
 * Model-visible inbox entry. The full body is included ONLY for a message being
 * presented for the FIRST time (queued_not_injected). An already-presented
 * (context_injected_unacknowledged) entry returns metadata + bodyIncluded:false,
 * so a normal recovery pull does not repeat the request body.
 */
export interface InboxEntry {
  messageId: string;
  injectionId: string | null;
  senderAlias: string;
  recipientAlias: string;
  kind: string;
  correlationId: string;
  causationId: string | null;
  sequence: number;
  requiresAck: boolean;
  requiresReply: boolean;
  state: InboxEntryState;
  bodyAlreadyPresented: boolean;
  bodyIncluded: boolean;
  /** Present ONLY when bodyIncluded === true. */
  text?: string;
  metadata?: Record<string, string> | null;
  createdAt: string;
  expiresAt: string | null;
  allowedActions: string[];
}

export interface PendingMessage {
  messageId: string;
  senderAlias: string;
  recipientAlias: string;
  kind: string;
  correlationId: string;
  causationId: string | null;
  sequence: number;
  requiresAck: boolean;
  requiresReply: boolean;
  text: string;
  metadata: Record<string, string> | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface AckInput {
  messageId: string;
  status: 'accepted' | 'rejected';
  note?: string;
  /** Non-secret injection reference (ADR 0006). Optional — the broker can resolve
   *  the injection from the authenticated (session, epoch) + messageId. */
  injectionId?: string;
}

export interface ReplyInput {
  messageId: string;
  text: string;
  outcome: 'completed' | 'failed' | 'partial';
  idempotencyKey?: string;
  metadata?: Record<string, string>;
  injectionId?: string;
}

function hashBody(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class DeliveryOps {
  private readonly receipts: ReceiptStore;
  private readonly controls: ControlsStore;
  /** When true, ack/reply require a valid one-time receipt capability (ADR 0003).
   *  Enabled in the real daemon; off for the legacy in-process contract tests. */
  private readonly requireReceipt: boolean;
  constructor(
    private readonly db: SqliteDriver,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    private readonly ackDeadlineMs: number = 5 * 60_000,
    receipts?: ReceiptStore,
    opts: { requireReceipt?: boolean } = {},
  ) {
    this.receipts = receipts ?? new ReceiptStore(db, clock, ids);
    this.controls = new ControlsStore(db, clock);
    this.requireReceipt = opts.requireReceipt ?? false;
  }

  private audit(eventType: string, fields: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO audit_events (audit_id, event_type, actor_session_id, actor_instance_id, message_id, trace_id, safe_metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(this.ids.next(), eventType, fields.sessionId ?? null, fields.instanceId ?? null, fields.messageId ?? null, null, JSON.stringify(fields), this.clock.nowIso());
  }

  /**
   * Beta.4 (ADR 0012 Decision 5): refresh the RECIPIENT's meaningful-activity
   * timestamp (+ recompute the 15-day expiry). Called from genuinely meaningful
   * recipient ops — ack, reject, reply, explicit redelivery, and a body-injecting
   * checkpoint pull — but NEVER from a body-suppressed re-injection, a deferred
   * (not-ready) pull, or any passive path. Idempotent; runs in the caller's txn.
   * Skips an already-expired session (a tombstone must not be revived by activity).
   */
  private refreshActivity(sessionId: string, now: string): void {
    const expiresAt = new Date(this.clock.nowMs() + MEANINGFUL_ACTIVITY_RETENTION_MS).toISOString();
    this.db.prepare('UPDATE sessions SET last_meaningful_activity_at=?, expires_at=?, updated_at=? WHERE session_id=? AND expired_at IS NULL').run(now, expiresAt, now, sessionId);
  }

  /**
   * The ACK deadline anchored at injection time. ONLY a message that requires an
   * ack gets one — a non-ack message has nothing to time out, so it must never
   * carry a lease_expires_at (which is exactly what the ack-timeout reaper keys
   * on). Returns the ISO deadline for an ack-required message, else null.
   */
  private ackDeadlineFor(requiresAck: boolean): string | null {
    return requiresAck ? new Date(this.clock.nowMs() + this.ackDeadlineMs).toISOString() : null;
  }

  /**
   * Reliability lifecycle close-out for a message that has JUST been successfully
   * injected (selected, marked transport_written, transport-logged, injection
   * recorded, and ABOUT TO BE returned in the checkpoint response). MUST be called
   * only after the body is committed to the returned output.
   *
   * A message that requires NEITHER ack NOR reply is terminal the moment its body
   * reaches the checkpoint: it transitions transport_written -> completed
   * atomically (CAS guarded on state + requires_ack=0 via the state machine's
   * `complete` edge), records application_completed_at, and clears the ack timer +
   * any stale retry fields. A message that requires a reply (with or without ack)
   * is left in its post-injection state to await the correlated reply; only the
   * ack-required variant keeps an armed lease_expires_at.
   *
   * Returns true if it completed the delivery (fire-and-forget), else false.
   */
  private completeIfNoResponseRequired(messageId: string, requiresAck: boolean, requiresReply: boolean, now: string): boolean {
    if (requiresAck || requiresReply) return false;
    // CAS: transport_written -> completed, guarded so it can ONLY complete a
    // non-ack delivery and only from the just-written state. Clears the ack timer
    // and any stale retry fields (a fresh injection should carry none, but this
    // makes the terminal row unambiguous and reaper-inert).
    const res = this.db
      .prepare(
        `UPDATE deliveries SET state='${DeliveryState.COMPLETED}', application_completed_at=?, lease_expires_at=NULL, next_attempt_at=NULL, failure_category=NULL, updated_at=? WHERE message_id=? AND state='${DeliveryState.TRANSPORT_WRITTEN}' AND (SELECT requires_ack FROM messages WHERE message_id=?)=0`,
      )
      .run(now, now, messageId, messageId);
    if (res.changes > 0) {
      this.audit('DELIVERY_COMPLETED_NO_RESPONSE_REQUIRED', { messageId });
      return true;
    }
    return false;
  }

  /**
   * Verify the caller's EPOCH is the session's current epoch (ADR 0003). This
   * replaces the connection-pinned fence: many components (mcp/hook) share one
   * epoch on different connections, so authority is epoch-scoped, not
   * connection-scoped. A superseded epoch is rejected.
   */
  private assertCurrentEpoch(auth: SessionAuthority): void {
    const s = this.db.prepare('SELECT active_epoch, state FROM sessions WHERE session_id=?').get(auth.sessionId) as { active_epoch: number; state: string } | undefined;
    if (!s) throw new XBusError(XBusErrorCode.SESSION_NOT_REGISTERED, 'session not registered');
    if (s.active_epoch !== auth.epoch) {
      this.audit('EPOCH_MISMATCH_REJECTED', { sessionId: auth.sessionId, instanceId: auth.componentInstanceId });
      throw new XBusError(XBusErrorCode.EPOCH_MISMATCH, 'stale epoch; re-register');
    }
  }

  /** The non-secret injection id for a message's CURRENT (highest-logical)
   *  injection in an epoch, or null if it was never injected for that epoch. Used
   *  to surface a valid injection reference on a returned body (never an empty id). */
  injectionIdFor(messageId: string, epoch: number): string | null {
    const r = this.db
      .prepare('SELECT injection_id FROM context_injections WHERE message_id=? AND recipient_epoch=? ORDER BY logical_injection_number DESC LIMIT 1')
      .get(messageId, epoch) as { injection_id: string } | undefined;
    return r?.injection_id ?? null;
  }

  /** Current readiness of a session (defaults to 'disconnected' if unknown/legacy). */
  readinessOf(sessionId: string): Readiness {
    const r = this.db.prepare('SELECT readiness FROM sessions WHERE session_id=?').get(sessionId) as { readiness: string } | undefined;
    return (r && isReadiness(r.readiness)) ? r.readiness : 'disconnected';
  }

  /** §2 — may the broker inject a fresh request to this session right now? */
  private sessionAcceptsInjection(sessionId: string): boolean {
    return acceptsInjection(this.readinessOf(sessionId));
  }

  /**
   * Ephemeral checkpoint pull by sessionId (used by the per-checkpoint hook,
   * which is NOT the registered live instance and must not claim the binding).
   * Authorized by sessionId under the same-OS-user trust boundary (the hook runs
   * in that session's process tree, with CLAUDE_CODE_SESSION_ID set by Claude
   * Code). Uses the session's stored current fence to mark injection.
   */
  /**
   * Hook checkpoint pull (ADR 0003/0004). The session + epoch are derived from
   * the AUTHENTICATED HOOK CONNECTION's authority (caller-supplied sessionId is
   * NOT trusted). Role must be `hook`. Issues a one-time receipt capability per
   * injected message and embeds it in the message metadata under
   * RECEIPT_METADATA_KEY. `checkpointId` scopes replay protection.
   */
  checkpointPull(auth: SessionAuthority, checkpointId: string, limit = 10): PendingMessage[] {
    assertAllowed(auth.role, Operation.PULL_HOOK_CHECKPOINT);
    this.assertCurrentEpoch(auth);
    // §2 readiness gate: a session that has not signalled it is ready (e.g. still
    // initializing, or degraded so it cannot ack) must NOT be injected a fresh
    // request. No transport_written, no ack deadline armed, no attempt consumed —
    // the message stays durably queued until the session becomes ready.
    if (!this.sessionAcceptsInjection(auth.sessionId)) {
      this.audit('INJECTION_DEFERRED_NOT_READY', { sessionId: auth.sessionId, readiness: this.readinessOf(auth.sessionId) });
      return [];
    }
    // Scheduling policy (ADR 0009): automatic checkpoint delivery flows ONLY when
    // the receiver is 'active'. Paused / DND / manual_checkpoint suppress
    // automatic injection — messages stay durably queued (queued_paused), no
    // delivery attempt is consumed, no retry backoff advances.
    if (!this.controls.autoDeliveryEnabled(auth.sessionId)) {
      return [];
    }
    const cappedLimit = Math.min(Math.max(1, limit), 50);
    return this.db.transaction(() => {
      const pending = this.pendingForSessionId(auth.sessionId, cappedLimit);
      const now = this.clock.nowIso();
      const out: PendingMessage[] = [];
      for (const m of pending) {
        // ONLY an ack-required message gets an ack deadline (lease_expires_at).
        const deadline = this.ackDeadlineFor(m.requiresAck);
        const res = this.db
          .prepare(`UPDATE deliveries SET state='${DeliveryState.TRANSPORT_WRITTEN}', transport_written_at=?, lease_expires_at=?, target_instance_id=?, target_generation=?, updated_at=? WHERE message_id=? AND state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}')`)
          .run(now, deadline, auth.componentInstanceId, auth.epoch, now, m.messageId);
        if (res.changes === 0) continue; // already injected (dedup)
        this.db.prepare('INSERT INTO transport_write_log (write_id, delivery_id, message_id, recipient_instance_id, attempt, bytes_written, ts) SELECT ?, delivery_id, ?, ?, attempt, ?, ? FROM deliveries WHERE message_id=?').run(this.ids.next(), m.messageId, auth.componentInstanceId, 0, now, m.messageId);
        const injection = this.receipts.issue({ messageId: m.messageId, recipientSessionId: auth.sessionId, recipientEpoch: auth.epoch, checkpointId, componentId: auth.componentInstanceId });
        this.audit('TRANSPORT_WRITTEN', { sessionId: auth.sessionId, instanceId: auth.componentInstanceId, messageId: m.messageId });
        // LAYER-3 INVARIANT (docs/delivery-semantics.md): a normal automatic
        // checkpoint must NEVER re-present a body, and must NEVER return a
        // checkpoint message without a valid injection id. `issue()` returns null
        // when an injection ALREADY exists for this (message, epoch, logical#1) —
        // i.e. the body was already presented this epoch. This happens when the
        // ack-timeout reaper requeued an already-injected ack message: the re-mark
        // re-arms the ack deadline (so dead-letter escalation still proceeds), but
        // the body must NOT be presented again here. Only explicit redelivery may
        // re-present a body (under a new logical number, with a valid id).
        if (!injection) {
          this.audit('REINJECTION_BODY_SUPPRESSED', { sessionId: auth.sessionId, instanceId: auth.componentInstanceId, messageId: m.messageId });
          continue;
        }
        const md = { ...(m.metadata ?? {}) } as Record<string, string>;
        // Non-secret reference only (ADR 0006): safe in transcripts/exports/logs.
        md[INJECTION_METADATA_KEY] = injection.injectionId;
        out.push({ ...m, metadata: md });
        // Body is now committed to the returned response → a fire-and-forget
        // message (no ack, no reply) becomes terminal immediately.
        this.completeIfNoResponseRequired(m.messageId, m.requiresAck, m.requiresReply, now);
      }
      // Beta.4: receiving a body at a checkpoint is meaningful RECIPIENT activity —
      // but ONLY when a body was actually presented (a body-suppressed re-injection
      // or an empty pull is not activity). ADR 0012 Decision 5.
      if (out.length > 0) this.refreshActivity(auth.sessionId, now);
      return out;
    });
  }

  /** Manual single-step (`xbus process-next`): inject exactly the next queued
   *  message. Bypasses the pause/DND/manual SCHEDULING controls (explicit user
   *  action, ADR 0009) but NOT the §2 readiness gate — a manual step must still
   *  never inject a request the receiver cannot acknowledge. */
  processNext(auth: SessionAuthority, checkpointId: string): PendingMessage[] {
    assertAllowed(auth.role, Operation.PULL_HOOK_CHECKPOINT);
    this.assertCurrentEpoch(auth);
    if (!this.sessionAcceptsInjection(auth.sessionId)) {
      this.audit('INJECTION_DEFERRED_NOT_READY', { sessionId: auth.sessionId, readiness: this.readinessOf(auth.sessionId), via: 'process_next' });
      return [];
    }
    return this.checkpointPullForced(auth, checkpointId, 1);
  }

  /** checkpointPull WITHOUT the scheduling-control gate (manual / explicit path). */
  private checkpointPullForced(auth: SessionAuthority, checkpointId: string, limit: number): PendingMessage[] {
    const cappedLimit = Math.min(Math.max(1, limit), 50);
    return this.db.transaction(() => {
      const pending = this.pendingForSessionId(auth.sessionId, cappedLimit);
      const now = this.clock.nowIso();
      const out: PendingMessage[] = [];
      for (const m of pending) {
        // ONLY an ack-required message gets an ack deadline (lease_expires_at).
        const deadline = this.ackDeadlineFor(m.requiresAck);
        const res = this.db
          .prepare(`UPDATE deliveries SET state='${DeliveryState.TRANSPORT_WRITTEN}', transport_written_at=?, lease_expires_at=?, target_instance_id=?, target_generation=?, updated_at=? WHERE message_id=? AND state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}')`)
          .run(now, deadline, auth.componentInstanceId, auth.epoch, now, m.messageId);
        if (res.changes === 0) continue;
        this.db.prepare('INSERT INTO transport_write_log (write_id, delivery_id, message_id, recipient_instance_id, attempt, bytes_written, ts) SELECT ?, delivery_id, ?, ?, attempt, ?, ? FROM deliveries WHERE message_id=?').run(this.ids.next(), m.messageId, auth.componentInstanceId, 0, now, m.messageId);
        const injection = this.receipts.issue({ messageId: m.messageId, recipientSessionId: auth.sessionId, recipientEpoch: auth.epoch, checkpointId, componentId: auth.componentInstanceId });
        // LAYER-3 INVARIANT (see checkpointPull): null issue() == already injected
        // this epoch. Re-arm proceeds (escalation), but never re-present the body
        // or return an empty injection id. Explicit redelivery is the only re-show.
        if (!injection) {
          this.audit('REINJECTION_BODY_SUPPRESSED', { sessionId: auth.sessionId, instanceId: auth.componentInstanceId, messageId: m.messageId });
          continue;
        }
        const md = { ...(m.metadata ?? {}) } as Record<string, string>;
        md[INJECTION_METADATA_KEY] = injection.injectionId;
        out.push({ ...m, metadata: md });
        this.completeIfNoResponseRequired(m.messageId, m.requiresAck, m.requiresReply, now);
      }
      if (out.length > 0) this.refreshActivity(auth.sessionId, now); // ADR 0012 D5
      return out;
    });
  }

  /**
   * Inbox pull for the MCP component (the model reading its own inbox). Reading
   * the inbox in-context IS delivery, so it marks messages injected and issues a
   * receipt per message (same as the hook checkpoint), enabling the model to ack/
   * reply with the returned capability. Role must allow LIST_INBOX.
   */
  inboxPull(auth: SessionAuthority, checkpointId: string, limit = 50): PendingMessage[] {
    // Legacy shape retained for callers expecting PendingMessage[]. Prefer inboxView.
    return this.checkpointPull({ ...auth, role: ComponentRole.HOOK }, checkpointId, limit);
  }

  /**
   * Model-visible inbox view (reliability contract §1). Returns the full body ONLY
   * for messages presented for the FIRST time (queued -> injected now). Messages
   * already presented (context_injected_unacknowledged) return metadata +
   * bodyIncluded:false — a normal recovery pull NEVER repeats the request body.
   * Body re-presentation requires explicit redelivery (see `redeliver`).
   */
  inboxView(auth: SessionAuthority, checkpointId: string, limit = 50): InboxEntry[] {
    assertAllowed(auth.role, Operation.LIST_INBOX);
    this.assertCurrentEpoch(auth);
    const now = this.clock.nowIso();
    // 1) inject NEW queued messages (issues fresh injection ids) — body INCLUDED.
    const fresh = this.checkpointPull({ ...auth, role: ComponentRole.HOOK }, checkpointId, limit);
    const freshIds = new Set(fresh.map((m) => m.messageId));
    const entries: InboxEntry[] = fresh.map((m) => ({
      messageId: m.messageId, injectionId: m.metadata?.[INJECTION_METADATA_KEY] ?? null,
      senderAlias: m.senderAlias, recipientAlias: m.recipientAlias, kind: m.kind,
      correlationId: m.correlationId, causationId: m.causationId, sequence: m.sequence,
      requiresAck: m.requiresAck, requiresReply: m.requiresReply,
      state: 'queued_not_injected', bodyAlreadyPresented: false, bodyIncluded: true,
      text: m.text, metadata: m.metadata, createdAt: m.createdAt, expiresAt: m.expiresAt,
      allowedActions: m.requiresAck ? ['ack', 'reject', 'reply'] : ['reply'],
    }));
    // 2) already-injected-but-unacked for THIS epoch — body NOT repeated.
    // The injection id is resolved via a CORRELATED SUBQUERY that pins the CURRENT
    // (highest logical_injection_number) injection for THIS (message, epoch) — not a
    // multi-row LEFT JOIN. A plain LEFT JOIN on context_injections returns one row PER
    // injection, so a message with >1 injection for the epoch (e.g. after an explicit
    // redelivery bumps logical_injection_number) would (a) be listed multiple times and
    // (b) surface an arbitrary/stale injection id. Mirrors injectionIdFor(); one row per
    // transport_written delivery, always carrying the current epoch-bound injection id.
    const rows = this.db
      .prepare(
        `SELECT m.message_id, m.sender_alias, m.recipient_alias, m.kind, m.correlation_id, m.causation_id, m.recipient_sequence, m.requires_ack, m.requires_reply, m.created_at, m.expires_at,
                (SELECT ci.injection_id FROM context_injections ci
                   WHERE ci.message_id=m.message_id AND ci.recipient_epoch=?
                   ORDER BY ci.logical_injection_number DESC LIMIT 1) AS injection_id
         FROM deliveries d JOIN messages m ON m.message_id=d.message_id
         WHERE d.recipient_session_id=? AND d.state='${DeliveryState.TRANSPORT_WRITTEN}'
           AND (m.expires_at IS NULL OR m.expires_at > ?)
         ORDER BY m.recipient_sequence ASC LIMIT ?`,
      )
      .all(auth.epoch, auth.sessionId, now, limit) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (freshIds.has(r.message_id as string)) continue;
      const requiresAck = (r.requires_ack as number) === 1;
      const requiresReply = (r.requires_reply as number) === 1;
      // A non-ack message in transport_written is NOT "unacknowledged" — it is
      // never going to be acked. (Fire-and-forget messages have already left
      // transport_written for `completed`, so any non-ack row here is awaiting a
      // reply.) Don't offer ack/reject for it, and don't label it as awaiting an
      // ack the contract never required.
      const state: InboxEntryState = requiresAck ? 'context_injected_unacknowledged' : 'application_accepted';
      const allowedActions = requiresAck
        ? ['ack', 'reject', 'reply', 'request-explicit-redelivery']
        : [...(requiresReply ? ['reply'] : []), 'request-explicit-redelivery'];
      entries.push({
        messageId: r.message_id as string, injectionId: (r.injection_id as string) ?? null,
        senderAlias: r.sender_alias as string, recipientAlias: r.recipient_alias as string, kind: r.kind as string,
        correlationId: r.correlation_id as string, causationId: (r.causation_id as string) ?? null, sequence: r.recipient_sequence as number,
        requiresAck, requiresReply,
        state, bodyAlreadyPresented: true, bodyIncluded: false,
        createdAt: r.created_at as string, expiresAt: (r.expires_at as string) ?? null,
        allowedActions,
      });
    }
    return entries;
  }

  /**
   * Explicit redelivery (reliability contract §1) — re-present the body of an
   * already-injected message under a NEW logical injection number. NEVER automatic;
   * requires an explicit caller request. Preserves prior injection history; audits.
   */
  redeliver(auth: SessionAuthority, messageId: string, reason: string): InboxEntry | null {
    assertAllowed(auth.role, Operation.LIST_INBOX);
    this.assertCurrentEpoch(auth);
    return this.db.transaction(() => {
      const m = this.db.prepare(`SELECT message_id, sender_alias, recipient_alias, kind, correlation_id, causation_id, recipient_sequence, requires_ack, requires_reply, body_text, metadata_json, created_at, expires_at, recipient_session_id FROM messages WHERE message_id=?`).get(messageId) as Record<string, unknown> | undefined;
      if (!m || m.recipient_session_id !== auth.sessionId) return null;
      const maxLogical = (this.db.prepare('SELECT MAX(logical_injection_number) AS n FROM context_injections WHERE message_id=? AND recipient_epoch=?').get(messageId, auth.epoch) as { n: number | null }).n ?? 0;
      // Redelivery RE-presents an already-injected body. A message never
      // injected for this epoch (maxLogical === 0) must NOT be
      // "redelivered" — doing so would (a) be a normal first injection mislabeled
      // as a redelivery, and (b) let a subsequent normal checkpoint pull present
      // the body a SECOND time, unannounced and without an injection id. The
      // first presentation is the job of the normal inbox/checkpoint path.
      if (maxLogical === 0) {
        this.audit('REDELIVERY_REFUSED_NOT_INJECTED', { sessionId: auth.sessionId, messageId });
        return null;
      }
      const injection = this.receipts.issue({ messageId, recipientSessionId: auth.sessionId, recipientEpoch: auth.epoch, checkpointId: `redeliver-${this.ids.next()}`, componentId: auth.componentInstanceId, logicalInjectionNumber: maxLogical + 1 });
      // Invariant (delivery §1): a returned/injected body ALWAYS carries a valid injection
      // id. If issue() could not mint one (e.g. a concurrent redelivery already took this
      // logical number → UNIQUE collision), do NOT return a body with a null id — throw so
      // the whole txn rolls back (no orphaned injection, no bodiless-id presentation). The
      // caller can retry; the model never sees an un-referenced body.
      if (!injection?.injectionId) {
        throw new XBusError(XBusErrorCode.INVALID_RECEIPT, 'redelivery could not allocate an injection id (concurrent redelivery); retry');
      }
      this.refreshActivity(auth.sessionId, this.clock.nowIso()); // ADR 0012 D5: explicit redelivery is meaningful
      this.audit('EXPLICIT_REDELIVERY', { sessionId: auth.sessionId, messageId, reason: reason.slice(0, 120), logical: maxLogical + 1 });
      const pm = this.rowToPending(m);
      return {
        messageId, injectionId: injection.injectionId, senderAlias: pm.senderAlias, recipientAlias: pm.recipientAlias,
        kind: pm.kind, correlationId: pm.correlationId, causationId: pm.causationId, sequence: pm.sequence,
        requiresAck: pm.requiresAck, requiresReply: pm.requiresReply, state: 'context_injected_unacknowledged',
        bodyAlreadyPresented: true, bodyIncluded: true, text: pm.text, metadata: pm.metadata,
        createdAt: pm.createdAt, expiresAt: pm.expiresAt,
        allowedActions: pm.requiresAck ? ['ack', 'reject', 'reply'] : ['reply'],
      };
    });
  }

  /** @deprecated legacy path retained for the in-process broker contract tests
   *  that don't model the hook as a separate component. */
  checkpointPullBySessionId(sessionId: string, limit = 50): PendingMessage[] {
    const s = this.db.prepare('SELECT fencing_token, active_epoch FROM sessions WHERE session_id=?').get(sessionId) as
      | { fencing_token: number | null; active_epoch: number } | undefined;
    if (!s || s.fencing_token === null) return [];
    const auth: SessionAuthority = {
      sessionId, instanceId: `hook-${sessionId.slice(0, 8)}`, componentInstanceId: `hook-${sessionId.slice(0, 8)}`,
      role: ComponentRole.HOOK, epoch: s.active_epoch, generation: s.active_epoch, fencingToken: s.fencing_token, connectionId: 'checkpoint-hook',
    };
    const pending = this.pendingForSessionId(sessionId, limit);
    // markInjectedFor reports only NEWLY-injected ids (a re-selected, already-
    // injected message is re-armed but not reported), so returning only those
    // bodies upholds the Layer-3 no-repeat-body invariant on this path too.
    const newlyInjected = new Set(this.markInjectedFor(auth, pending.map((m) => m.messageId)));
    return pending.filter((m) => newlyInjected.has(m.messageId));
  }

  private pendingForSessionId(sessionId: string, limit: number): PendingMessage[] {
    const now = this.clock.nowIso();
    const rows = this.db
      .prepare(
        `SELECT m.message_id, m.sender_alias, m.recipient_alias, m.kind, m.correlation_id, m.causation_id, m.recipient_sequence, m.requires_ack, m.requires_reply, m.body_text, m.metadata_json, m.created_at, m.expires_at
         FROM deliveries d JOIN messages m ON m.message_id=d.message_id
         WHERE d.recipient_session_id=? AND d.state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}')
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
         ORDER BY m.recipient_sequence ASC LIMIT ?`,
      )
      .all(sessionId, now, now, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToPending(r));
  }

  private rowToPending(r: Record<string, unknown>): PendingMessage {
    return {
      messageId: r.message_id as string,
      senderAlias: r.sender_alias as string,
      recipientAlias: r.recipient_alias as string,
      kind: r.kind as string,
      correlationId: r.correlation_id as string,
      causationId: (r.causation_id as string) ?? null,
      sequence: r.recipient_sequence as number,
      requiresAck: (r.requires_ack as number) === 1,
      requiresReply: (r.requires_reply as number) === 1,
      text: r.body_text as string,
      metadata: r.metadata_json ? (JSON.parse(r.metadata_json as string) as Record<string, string>) : null,
      createdAt: r.created_at as string,
      expiresAt: (r.expires_at as string) ?? null,
    };
  }

  /** Messages eligible for delivery to a session's CURRENT epoch, in order. */
  pendingForSession(auth: SessionAuthority, opts: { limit?: number } = {}): PendingMessage[] {
    this.assertCurrentEpoch(auth);
    const now = this.clock.nowIso();
    const limit = opts.limit ?? 50;
    const rows = this.db
      .prepare(
        `SELECT m.message_id, m.sender_alias, m.recipient_alias, m.kind, m.correlation_id, m.causation_id, m.recipient_sequence, m.requires_ack, m.requires_reply, m.body_text, m.metadata_json, m.created_at, m.expires_at
         FROM deliveries d JOIN messages m ON m.message_id=d.message_id
         WHERE d.recipient_session_id=? AND d.state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}')
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
         ORDER BY m.recipient_sequence ASC LIMIT ?`,
      )
      .all(auth.sessionId, now, now, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      messageId: r.message_id as string,
      senderAlias: r.sender_alias as string,
      recipientAlias: r.recipient_alias as string,
      kind: r.kind as string,
      correlationId: r.correlation_id as string,
      causationId: (r.causation_id as string) ?? null,
      sequence: r.recipient_sequence as number,
      requiresAck: (r.requires_ack as number) === 1,
      requiresReply: (r.requires_reply as number) === 1,
      text: r.body_text as string,
      metadata: r.metadata_json ? (JSON.parse(r.metadata_json as string) as Record<string, string>) : null,
      createdAt: r.created_at as string,
      expiresAt: (r.expires_at as string) ?? null,
    }));
  }

  /**
   * Mark a batch of messages as transport_written at checkpoint injection time.
   * This is where the ack deadline begins. Idempotent: a message already past
   * transport_written is skipped (dedup across duplicate checkpoint firings).
   * Returns the messageIds newly marked.
   */
  markInjected(auth: SessionAuthority, messageIds: string[]): string[] {
    this.assertCurrentEpoch(auth);
    return this.markInjectedFor(auth, messageIds);
  }

  /** Same as markInjected but without the connection-fence assert (used by the
   *  ephemeral checkpoint hook, which already resolved the session's authority).
   *  Returns the messageIds that were NEWLY injected (a fresh body presentation).
   *  A message re-selected after an ack-timeout requeue is RE-MARKED (so the ack
   *  deadline re-arms and dead-letter escalation proceeds) but is NOT reported as
   *  newly injected — so a caller that returns bodies for the reported ids never
   *  re-presents a body (Layer-3 invariant, docs/delivery-semantics.md). */
  markInjectedFor(auth: SessionAuthority, messageIds: string[], checkpointId?: string): string[] {
    return this.db.transaction(() => {
      const now = this.clock.nowIso();
      const marked: string[] = [];
      for (const messageId of messageIds) {
        // The message's response requirements decide whether an ack timer is armed
        // and whether the delivery completes on injection. Read them once here.
        const flags = this.db.prepare('SELECT requires_ack, requires_reply FROM messages WHERE message_id=?').get(messageId) as { requires_ack: number; requires_reply: number } | undefined;
        if (!flags) continue; // unknown message id — nothing to inject
        const requiresAck = flags.requires_ack === 1;
        const requiresReply = flags.requires_reply === 1;
        // ONLY an ack-required message gets an ack deadline (lease_expires_at).
        const deadline = this.ackDeadlineFor(requiresAck);
        // CAS: only from queued/retry_wait -> transport_written.
        const res = this.db
          .prepare(
            `UPDATE deliveries SET state='${DeliveryState.TRANSPORT_WRITTEN}', transport_written_at=?, lease_expires_at=?, target_instance_id=?, target_generation=?, fencing_token=?, updated_at=? WHERE message_id=? AND state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}')`,
          )
          .run(now, deadline, auth.instanceId, auth.epoch, auth.fencingToken, now, messageId);
        if (res.changes > 0) {
          this.db
            .prepare('INSERT INTO transport_write_log (write_id, delivery_id, message_id, recipient_instance_id, attempt, bytes_written, ts) SELECT ?, delivery_id, ?, ?, attempt, ?, ? FROM deliveries WHERE message_id=?')
            .run(this.ids.next(), messageId, auth.instanceId, 0, now, messageId);
          this.audit('TRANSPORT_WRITTEN', { sessionId: auth.sessionId, instanceId: auth.instanceId, messageId });
          // Record the injection. A null result means this body was already
          // injected this epoch (e.g. an ack-timeout requeue): the delivery is
          // re-armed above, but it must NOT be reported as a fresh presentation —
          // the only re-show path is explicit redelivery.
          const injection = this.receipts.issue({ messageId, recipientSessionId: auth.sessionId, recipientEpoch: auth.epoch, checkpointId: checkpointId ?? `mark-${this.ids.next()}`, componentId: auth.instanceId });
          if (injection) {
            marked.push(messageId);
            // A fire-and-forget message (no ack, no reply) becomes terminal
            // immediately on its (first) injection.
            this.completeIfNoResponseRequired(messageId, requiresAck, requiresReply, now);
          } else {
            this.audit('REINJECTION_BODY_SUPPRESSED', { sessionId: auth.sessionId, instanceId: auth.instanceId, messageId });
          }
        }
      }
      return marked;
    });
  }

  /** xbus_ack: the authenticated receiver accepts/rejects a delivered message.
   *  Role must be `mcp`; authority flows through the one-time receipt capability
   *  (ADR 0003) when `requireReceipt` is set. */
  ack(auth: SessionAuthority, input: AckInput): { state: string; duplicate: boolean } {
    assertAllowed(auth.role, Operation.ACK);
    this.assertCurrentEpoch(auth);
    return this.db.transaction(() => {
      const now = this.clock.nowIso();
      const msg = this.db.prepare('SELECT recipient_session_id, body_hash FROM messages WHERE message_id=?').get(input.messageId) as { recipient_session_id: string; body_hash: string } | undefined;
      if (!msg) throw new XBusError(XBusErrorCode.MESSAGE_NOT_FOUND, 'no such message');
      if (msg.recipient_session_id !== auth.sessionId) throw new XBusError(XBusErrorCode.NOT_RECIPIENT, 'not the recipient of this message');

      // Idempotent ack check FIRST (before capability validation): a genuine
      // identical retry is a no-op regardless of receipt-replay state; a
      // conflicting status is rejected. This avoids a benign retry being
      // mis-flagged as a receipt replay.
      const existing = this.db.prepare(`SELECT status FROM receipts WHERE message_id=? AND receiver_session_id=? AND receipt_type='ack'`).get(input.messageId, auth.sessionId) as { status: string } | undefined;
      if (existing) {
        if (existing.status !== input.status) {
          this.audit('CONFLICTING_ACK_REJECTED', { sessionId: auth.sessionId, messageId: input.messageId });
          throw new XBusError(XBusErrorCode.ILLEGAL_STATE_TRANSITION, 'conflicting acknowledgement');
        }
        const cur = this.db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(input.messageId) as { state: string };
        return { state: cur.state, duplicate: true };
      }

      // Connection-bound authorization (ADR 0006): authority comes from the
      // authenticated session+epoch + a recorded injection, NOT a bearer token.
      // The optional injectionId is a non-secret disambiguator.
      let injectionId: string | null = null;
      if (this.requireReceipt) {
        const v = this.receipts.authorize('ack', { messageId: input.messageId, sessionId: auth.sessionId, epoch: auth.epoch, ...(input.injectionId !== undefined ? { injectionId: input.injectionId } : {}) });
        injectionId = v.injectionId;
      }

      const target = input.status === 'accepted' ? DeliveryState.ACCEPTED : DeliveryState.REJECTED;
      // Authority verified above (current epoch + one-time receipt). The CAS gates
      // on state only — the delivery's injector token (often the hook's)
      // legitimately differs from the acker's (the MCP server) in one epoch.
      const res = this.db
        .prepare(`UPDATE deliveries SET state=?, application_accepted_at=?, rejected_reason=?, updated_at=? WHERE message_id=? AND state='${DeliveryState.TRANSPORT_WRITTEN}'`)
        .run(target, input.status === 'accepted' ? now : null, input.status === 'rejected' ? (input.note ?? 'rejected') : null, now, input.messageId);
      if (res.changes === 0) {
        this.audit('CAS_CONFLICT', { sessionId: auth.sessionId, messageId: input.messageId, op: 'ack' });
        const cur = this.db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(input.messageId) as { state: string } | undefined;
        throw new XBusError(XBusErrorCode.ILLEGAL_STATE_TRANSITION, `cannot ack from state ${cur?.state ?? 'unknown'}`);
      }
      this.db
        .prepare('INSERT INTO receipts (receipt_id, message_id, receiver_session_id, receiver_instance_id, receiver_generation, receipt_type, status, note, body_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(this.ids.next(), input.messageId, auth.sessionId, auth.instanceId, auth.epoch, 'ack', input.status, input.note ?? null, msg.body_hash, now);
      if (injectionId) this.receipts.consume(injectionId, 'ack');
      this.refreshActivity(auth.sessionId, now); // ADR 0012 D5: ack/reject is meaningful
      this.audit('ACK', { sessionId: auth.sessionId, messageId: input.messageId, status: input.status });
      return { state: target, duplicate: false };
    });
  }

  /**
   * xbus_reply: creates a correlated reply addressed back to the original
   * sender, records a completion receipt, and completes the original delivery.
   * Idempotent on (receiver, idempotencyKey).
   */
  reply(auth: SessionAuthority, input: ReplyInput, allocSequence: (recipientSessionId: string) => number): SendResult & { replyMessageId: string } {
    assertAllowed(auth.role, Operation.REPLY);
    this.assertCurrentEpoch(auth);
    return this.db.transaction(() => {
      const now = this.clock.nowIso();
      const orig = this.db.prepare('SELECT sender_session_id, sender_alias, recipient_alias, correlation_id, trace_id, recipient_session_id, body_hash FROM messages WHERE message_id=?').get(input.messageId) as
        | { sender_session_id: string; sender_alias: string; recipient_alias: string; correlation_id: string; trace_id: string; recipient_session_id: string; body_hash: string }
        | undefined;
      if (!orig) throw new XBusError(XBusErrorCode.MESSAGE_NOT_FOUND, 'no such message');
      if (orig.recipient_session_id !== auth.sessionId) throw new XBusError(XBusErrorCode.NOT_RECIPIENT, 'not the recipient of this message');

      let injectionId: string | null = null;
      if (this.requireReceipt) {
        const v = this.receipts.authorize('reply', { messageId: input.messageId, sessionId: auth.sessionId, epoch: auth.epoch, ...(input.injectionId !== undefined ? { injectionId: input.injectionId } : {}) });
        injectionId = v.injectionId;
      }

      // Idempotency: a repeated reply with the same key returns the same reply.
      if (input.idempotencyKey) {
        const dup = this.db.prepare('SELECT message_id, correlation_id, recipient_session_id, recipient_alias, recipient_sequence FROM messages WHERE sender_session_id=? AND idempotency_key=?').get(auth.sessionId, input.idempotencyKey) as
          | { message_id: string; correlation_id: string; recipient_session_id: string; recipient_alias: string; recipient_sequence: number } | undefined;
        if (dup) {
          return { messageId: dup.message_id, replyMessageId: dup.message_id, correlationId: dup.correlation_id, recipientSessionId: dup.recipient_session_id, recipientAlias: dup.recipient_alias, sequence: dup.recipient_sequence, state: 'completed', deduplicated: true };
        }
      }

      // Beta.4 (ADR 0012 D6): the reply's recipient is the ORIGINAL SENDER. If that
      // session has expired (>15d idle), it is unroutable — queuing a reply to it
      // would create a permanent orphan the sweep won't reclaim (its CAS requires
      // expired_at IS NULL). Reject FINAL, symmetric with store.send()'s guard. This
      // is AFTER the idempotency short-circuit, so a genuine duplicate still no-ops.
      const origExpired = this.db.prepare('SELECT expired_at FROM sessions WHERE session_id=?').get(orig.sender_session_id) as { expired_at: string | null } | undefined;
      if (origExpired?.expired_at) {
        this.audit('REPLY_REJECTED_RECIPIENT_EXPIRED', { sessionId: auth.sessionId, messageId: input.messageId });
        throw new XBusError(XBusErrorCode.RECIPIENT_SESSION_EXPIRED, 'the original sender session has expired (no activity for 15 days); cannot deliver the reply');
      }

      const replyId = this.ids.next();
      const sequence = allocSequence(orig.sender_session_id);
      this.db
        .prepare(
          `INSERT INTO messages (message_id, protocol_version, sender_session_id, sender_alias, recipient_session_id, recipient_alias, kind, correlation_id, causation_id, parent_message_id, recipient_sequence, idempotency_key, body_text, body_hash, metadata_json, requires_ack, requires_reply, created_at, trace_id) VALUES (?,?,?,?,?,?, 'reply', ?,?,?,?,?,?,?,?,0,0,?,?)`,
        )
        .run(replyId, 1, auth.sessionId, orig.recipient_alias, orig.sender_session_id, orig.sender_alias, orig.correlation_id, input.messageId, input.messageId, sequence, input.idempotencyKey ?? null, input.text, hashBody(input.text), input.metadata ? JSON.stringify(input.metadata) : null, now, orig.trace_id);
      this.db.prepare(`INSERT INTO deliveries (delivery_id, message_id, recipient_session_id, state, created_at, updated_at) VALUES (?,?,?, '${DeliveryState.QUEUED}', ?, ?)`).run(this.ids.next(), replyId, orig.sender_session_id, now, now);

      // Complete the original delivery (from accepted, or transport_written if no ack required).
      this.db
        .prepare(`UPDATE deliveries SET state='${DeliveryState.COMPLETED}', application_completed_at=?, updated_at=? WHERE message_id=? AND state IN ('${DeliveryState.ACCEPTED}','${DeliveryState.TRANSPORT_WRITTEN}')`)
        .run(now, now, input.messageId);
      this.db
        .prepare('INSERT OR IGNORE INTO receipts (receipt_id, message_id, receiver_session_id, receiver_instance_id, receiver_generation, receipt_type, status, body_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(this.ids.next(), input.messageId, auth.sessionId, auth.instanceId, auth.epoch, 'reply', input.outcome, orig.body_hash, now);
      if (injectionId) this.receipts.consume(injectionId, 'reply');
      this.refreshActivity(auth.sessionId, now); // ADR 0012 D5: replying is meaningful
      this.audit('REPLY', { sessionId: auth.sessionId, messageId: input.messageId, replyMessageId: replyId });
      return { messageId: input.messageId, replyMessageId: replyId, correlationId: orig.correlation_id, recipientSessionId: orig.sender_session_id, recipientAlias: orig.sender_alias, sequence, state: DeliveryState.QUEUED, deduplicated: false };
    });
  }
}
