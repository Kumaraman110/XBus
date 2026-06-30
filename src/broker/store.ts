/**
 * Broker store — the transactional heart of XBus. All persistence for the
 * vertical slice lives here against the real SqliteDriver. Implements:
 *  - session registration + first-writer-wins binding + fencing (I13/I14)
 *  - alias registration (ASCII, case-insensitive unique, session- reserved)
 *  - send: resolve-before-insert, idempotency-before-sequence (F13/I19)
 *  - inbox query scoped to the current generation (I16)
 *  - ack / reply with current-fence enforcement
 *  - audit events (safe metadata only)
 *
 * Sender identity is ALWAYS derived from the authenticated session passed by the
 * broker connection layer — never from caller-supplied fields.
 */
import { createHash } from 'node:crypto';
import type { SqliteDriver } from '../database/connection.js';
import type { Clock, IdGen } from '../shared/clock.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import { PROTOCOL_VERSION, XBUS_VERSION } from '../protocol/version.js';
import { DeliveryState } from '../protocol/states.js';
import { validateUserAlias, automaticAlias, parseRecipient, type NormalizedAlias } from '../identity/aliases.js';
import type { SendInput } from '../protocol/schemas.js';
import { ComponentRole } from '../identity/components.js';
import { ControlsStore } from './controls.js';
import { resolveReadiness, isReadiness, type Readiness, type ReadinessHints } from './readiness.js';

export interface RegisterInput {
  sessionId: string;
  instanceId: string;
  connectionId: string;
  processId: number;
  projectId: string;
  cwd: string;
  receiveMode: string;
  capabilities: string[];
  /** Component role (ADR 0003). Defaults to 'mcp' for back-compat. */
  role?: ComponentRole;
  buildId?: string;
  repositoryRoot?: string;
  claudeCodeVersion?: string;
}

/**
 * Per-connection authority handle. `epoch` is the session lifecycle generation
 * (ADR 0003); `role` is the component role. `generation`/`fencingToken` are
 * retained as aliases of `epoch` for back-compat with earlier code paths.
 */
export interface SessionAuthority {
  sessionId: string;
  instanceId: string;
  componentInstanceId: string;
  role: ComponentRole;
  epoch: number;
  generation: number;
  fencingToken: number;
  connectionId: string;
}

export interface SendResult {
  messageId: string;
  correlationId: string;
  recipientSessionId: string;
  recipientAlias: string;
  sequence: number;
  state: string;
  deduplicated: boolean;
}

function hashBody(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class BrokerStore {
  private readonly controls: ControlsStore;
  constructor(
    private readonly db: SqliteDriver,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    private readonly brokerInstanceId: string,
  ) {
    this.controls = new ControlsStore(db, clock);
  }

  private audit(eventType: string, fields: Record<string, unknown>): void {
    this.db
      .prepare(
        'INSERT INTO audit_events (audit_id, event_type, actor_session_id, actor_instance_id, message_id, trace_id, safe_metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        this.ids.next(),
        eventType,
        fields.sessionId ?? null,
        fields.instanceId ?? null,
        fields.messageId ?? null,
        fields.traceId ?? null,
        JSON.stringify(fields),
        this.clock.nowIso(),
      );
  }

  private nextFencingToken(): number {
    this.db.prepare('UPDATE fencing_counter SET value = value + 1 WHERE id = 1').run();
    return (this.db.prepare('SELECT value FROM fencing_counter WHERE id = 1').get() as { value: number }).value;
  }

  private nextEpochToken(): string {
    this.db.prepare('UPDATE fencing_counter SET value = value + 1 WHERE id = 1').run();
    const v = (this.db.prepare('SELECT value FROM fencing_counter WHERE id = 1').get() as { value: number }).value;
    // Hash the monotonic counter into an opaque epoch token (stored as hash).
    return createHash('sha256').update(`epoch:${v}`, 'utf8').digest('hex');
  }

  /**
   * Register a COMPONENT (ADR 0003). A component joins the session's CURRENT
   * epoch — it does NOT bump the epoch. The epoch advances only when:
   *  - this is the first registration for the sessionId (epoch 1), or
   *  - `supersede` is requested AND a prior owner is gone / forced takeover.
   *
   * Many components (mcp + hook + transport) coexist in one epoch with distinct
   * componentInstanceIds and role-restricted capabilities.
   */
  register(input: RegisterInput & { supersede?: boolean }): SessionAuthority {
    return this.db.transaction(() => {
      const now = this.clock.nowIso();
      const role = input.role ?? ComponentRole.MCP;
      const componentInstanceId = this.ids.next();
      const existing = this.db
        .prepare('SELECT session_id, active_epoch FROM sessions WHERE session_id = ?')
        .get(input.sessionId) as { session_id: string; active_epoch: number } | undefined;

      let epoch: number;
      if (!existing) {
        // First time: epoch 1.
        epoch = 1;
        const auto = automaticAlias(input.sessionId);
        this.db
          .prepare(
            `INSERT INTO sessions (session_id, active_instance_id, generation, high_water_generation, active_epoch, fencing_token, bound_connection_id, automatic_alias, project_id, cwd, repository_root, claude_code_version, xbus_version, capabilities_json, receive_mode, state, connected_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'connected', ?,?,?,?)`,
          )
          .run(
            input.sessionId, componentInstanceId, epoch, epoch, epoch, epoch, input.connectionId,
            auto.display, input.projectId, input.cwd, input.repositoryRoot ?? null, input.claudeCodeVersion ?? null,
            XBUS_VERSION, JSON.stringify(input.capabilities), input.receiveMode, now, now, now, now,
          );
        this.db.prepare('INSERT OR IGNORE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, 1)').run(input.sessionId);
        this.upsertAliasRow(auto, 'global', null, input.sessionId, now);
        this.db.prepare('INSERT INTO session_epochs (session_id, epoch, epoch_token_hash, started_at) VALUES (?,?,?,?)').run(input.sessionId, epoch, this.nextEpochToken(), now);
      } else if (input.supersede) {
        // Genuine takeover: advance the epoch.
        epoch = existing.active_epoch + 1;
        this.db.prepare('UPDATE session_epochs SET superseded_at=?, supersede_reason=? WHERE session_id=? AND epoch=? AND superseded_at IS NULL').run(now, 'supersede', input.sessionId, existing.active_epoch);
        this.db.prepare('INSERT INTO session_epochs (session_id, epoch, epoch_token_hash, started_at) VALUES (?,?,?,?)').run(input.sessionId, epoch, this.nextEpochToken(), now);
        // New epoch ⇒ new owner: readiness resets to initializing until it signals (§2).
        this.db.prepare(`UPDATE sessions SET active_epoch=?, generation=?, high_water_generation=?, fencing_token=?, state='connected', readiness='initializing', readiness_updated_at=?, last_seen_at=?, updated_at=? WHERE session_id=?`).run(epoch, epoch, epoch, epoch, now, now, now, input.sessionId);
        this.db.prepare(`UPDATE component_instances SET state='superseded', disconnected_at=? WHERE session_id=? AND state='live'`).run(now, input.sessionId);
        // On a TRUE epoch change, re-queue any in-flight injection (the prior
        // owner is gone). Lease-expiry no longer matters — the epoch is replaced.
        this.db.prepare(`UPDATE deliveries SET state='${DeliveryState.QUEUED}', transport_written_at=NULL, target_instance_id=NULL, updated_at=? WHERE recipient_session_id=? AND state='${DeliveryState.TRANSPORT_WRITTEN}'`).run(now, input.sessionId);
      } else {
        // Split-brain guard (ADR 0008): at most ONE live writable (mcp) component
        // per session epoch. A SECOND concurrent mcp registration on a DIFFERENT
        // connection (e.g. the same session resumed in another terminal while the
        // first is still active) is rejected — the caller must use --fork-session,
        // close the existing owner, or run an explicit takeover (supersede).
        if (role === ComponentRole.MCP) {
          const liveMcp = this.db
            .prepare(`SELECT component_instance_id, connection_id FROM component_instances WHERE session_id=? AND epoch=? AND role='mcp' AND state='live'`)
            .all(input.sessionId, existing.active_epoch) as Array<{ component_instance_id: string; connection_id: string | null }>;
          const otherLive = liveMcp.filter((c) => c.connection_id !== input.connectionId);
          if (otherLive.length > 0) {
            this.audit('SESSION_ALREADY_ACTIVE', { sessionId: input.sessionId, epoch: existing.active_epoch });
            throw new XBusError(
              XBusErrorCode.SESSION_ALREADY_ACTIVE,
              'this session already has an active XBus owner; use --fork-session, close the existing owner, or use the `takeover <session>` command',
              { sessionId: input.sessionId },
            );
          }
        }
        // Component JOINS the current epoch (no bump). This is the common case:
        // the hook (ephemeral) and the MCP server of the same live session.
        epoch = existing.active_epoch;
        this.db.prepare(`UPDATE sessions SET state='connected', bound_connection_id=COALESCE(bound_connection_id, ?), last_seen_at=?, updated_at=? WHERE session_id=?`).run(input.connectionId, now, now, input.sessionId);
        // Reconnect recovery (component-level): re-queue only LEASE-EXPIRED
        // injections (genuinely abandoned), never fresh ones.
        this.db
          .prepare(`UPDATE deliveries SET state='${DeliveryState.QUEUED}', transport_written_at=NULL, target_instance_id=NULL, updated_at=? WHERE recipient_session_id=? AND state='${DeliveryState.TRANSPORT_WRITTEN}' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
          .run(now, input.sessionId, now);
      }

      const epochToken = (this.db.prepare('SELECT fencing_token FROM sessions WHERE session_id=?').get(input.sessionId) as { fencing_token: number }).fencing_token;

      this.db
        .prepare(
          `INSERT INTO component_instances (component_instance_id, session_id, epoch, role, process_id, connection_id, build_id, capabilities_json, connected_at, last_seen_at, state) VALUES (?,?,?,?,?,?,?,?,?,?, 'live')`,
        )
        .run(componentInstanceId, input.sessionId, epoch, role, input.processId, input.connectionId, input.buildId ?? null, JSON.stringify(input.capabilities), now, now);

      this.audit('COMPONENT_REGISTERED', { sessionId: input.sessionId, instanceId: componentInstanceId, role, epoch });
      return {
        sessionId: input.sessionId, instanceId: componentInstanceId, componentInstanceId, role, epoch,
        generation: epoch, fencingToken: epochToken, connectionId: input.connectionId,
      };
    });
  }

  /**
   * Component cleanup (ADR 0003 churn control). Marks 'live' components whose
   * connection is no longer current as 'closed', and prunes historical
   * (non-live) component rows older than retentionMs to bound DB growth. Audit
   * rows are NOT pruned here. Deterministic given the injected clock.
   */
  cleanupComponents(opts: { liveConnectionIds: ReadonlySet<string>; retentionMs?: number }): { closed: number; pruned: number } {
    const retentionMs = opts.retentionMs ?? 24 * 60 * 60_000;
    const now = this.clock.nowIso();
    const cutoff = new Date(this.clock.nowMs() - retentionMs).toISOString();
    return this.db.transaction(() => {
      // Close live components whose connection is gone (authority cannot persist).
      const live = this.db.prepare(`SELECT component_instance_id, connection_id FROM component_instances WHERE state='live'`).all() as Array<{ component_instance_id: string; connection_id: string | null }>;
      let closed = 0;
      for (const c of live) {
        if (!c.connection_id || !opts.liveConnectionIds.has(c.connection_id)) {
          this.db.prepare(`UPDATE component_instances SET state='closed', disconnected_at=? WHERE component_instance_id=?`).run(now, c.component_instance_id);
          closed += 1;
        }
      }
      // Prune old historical rows (audit-only history lives in audit_events).
      const res = this.db.prepare(`DELETE FROM component_instances WHERE state<>'live' AND connected_at < ?`).run(cutoff);
      return { closed, pruned: res.changes };
    });
  }

  /** Count of currently-live components (diagnostics + churn bound assertions). */
  liveComponentCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM component_instances WHERE state='live'`).get() as { n: number }).n;
  }

  private currentMaxSequence(sessionId: string): number {
    const row = this.db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(sessionId) as { next_sequence: number } | undefined;
    return row ? row.next_sequence - 1 : 0;
  }

  private upsertAliasRow(alias: NormalizedAlias, scope: string, projectId: string | null, sessionId: string, now: string): void {
    // Retire any prior active alias of the same identity in this scope held by this session is left intact;
    // uniqueness is enforced by the partial indexes. Insert new active row.
    this.db
      .prepare('INSERT INTO aliases (alias_id, alias, alias_ci, scope, project_id, session_id, active, created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(this.ids.next(), alias.display, alias.ci, scope, projectId, sessionId, now);
  }

  /** Register a user alias for the authenticated session (global scope for slice). */
  registerAlias(auth: SessionAuthority, rawAlias: string): { alias: string } {
    const alias = validateUserAlias(rawAlias);
    return this.db.transaction(() => {
      const now = this.clock.nowIso();
      const clash = this.db
        .prepare(`SELECT session_id FROM aliases WHERE alias_ci=? AND scope='global' AND active=1`)
        .get(alias.ci) as { session_id: string } | undefined;
      if (clash && clash.session_id !== auth.sessionId) {
        throw new XBusError(XBusErrorCode.INVALID_ALIAS, 'alias already in use');
      }
      if (!clash) this.upsertAliasRow(alias, 'global', null, auth.sessionId, now);
      this.audit('ALIAS_REGISTERED', { sessionId: auth.sessionId, alias: alias.display });
      return { alias: alias.display };
    });
  }

  /**
   * §2 — record an explicit readiness signal for the authenticated session.
   * The client supplies concrete capability hints (canAck, hookAvailable, …);
   * the broker DERIVES the readiness state (never trusts a bare "ready").
   * Returns the resolved state. Bound to (session, epoch) so a stale component
   * cannot move readiness for a superseded epoch.
   */
  signalReadiness(auth: SessionAuthority, hints: ReadinessHints): { readiness: Readiness } {
    return this.db.transaction(() => {
      const s = this.db.prepare('SELECT active_epoch, receive_mode, capabilities_json FROM sessions WHERE session_id=?').get(auth.sessionId) as
        | { active_epoch: number; receive_mode: string; capabilities_json: string } | undefined;
      if (!s) throw new XBusError(XBusErrorCode.SESSION_NOT_REGISTERED, 'session not registered');
      if (s.active_epoch !== auth.epoch) throw new XBusError(XBusErrorCode.EPOCH_MISMATCH, 'stale epoch; re-register');
      let caps: string[];
      try { caps = JSON.parse(s.capabilities_json) as string[]; } catch { caps = []; }
      const readiness = resolveReadiness({ receiveMode: s.receive_mode, capabilities: caps, hints });
      const now = this.clock.nowIso();
      this.db.prepare('UPDATE sessions SET readiness=?, readiness_updated_at=?, updated_at=? WHERE session_id=?').run(readiness, now, now, auth.sessionId);
      this.audit('READINESS_SIGNALED', { sessionId: auth.sessionId, instanceId: auth.componentInstanceId, readiness });
      return { readiness };
    });
  }

  /** Force a readiness state directly (used by degraded/disconnected transitions
   *  the broker detects, e.g. hook-unavailable). Validated against the enum. */
  setReadiness(sessionId: string, readiness: Readiness): void {
    if (!isReadiness(readiness)) throw new XBusError(XBusErrorCode.PROTOCOL_VIOLATION, 'invalid readiness');
    const now = this.clock.nowIso();
    this.db.prepare('UPDATE sessions SET readiness=?, readiness_updated_at=?, updated_at=? WHERE session_id=?').run(readiness, now, now, sessionId);
  }

  /** Current readiness of a session (defaults to 'disconnected' if unknown). */
  readinessOf(sessionId: string): Readiness {
    const r = this.db.prepare('SELECT readiness FROM sessions WHERE session_id=?').get(sessionId) as { readiness: string } | undefined;
    return (r && isReadiness(r.readiness)) ? r.readiness : 'disconnected';
  }

  /** Resolve a recipient string to exactly one session id, or throw. */
  private resolveRecipient(raw: string): { sessionId: string; alias: string } {
    const ref = parseRecipient(raw);
    if (ref.kind === 'session') {
      const s = this.db.prepare('SELECT session_id, automatic_alias FROM sessions WHERE session_id=?').get(ref.sessionId) as { session_id: string; automatic_alias: string } | undefined;
      if (!s) throw new XBusError(XBusErrorCode.UNKNOWN_RECIPIENT, 'no such session');
      return { sessionId: s.session_id, alias: s.automatic_alias };
    }
    if (ref.kind === 'alias') {
      const rows = this.db.prepare(`SELECT session_id, alias FROM aliases WHERE alias_ci=? AND active=1`).all(ref.alias.toLowerCase()) as Array<{ session_id: string; alias: string }>;
      if (rows.length === 0) throw new XBusError(XBusErrorCode.UNKNOWN_RECIPIENT, 'unknown recipient');
      if (rows.length > 1) throw new XBusError(XBusErrorCode.AMBIGUOUS_RECIPIENT, 'ambiguous recipient; supply a fully-qualified projectId/alias or exact session id');
      return { sessionId: rows[0]!.session_id, alias: rows[0]!.alias };
    }
    // qualified: project-scoped alias
    const rows = this.db
      .prepare(`SELECT a.session_id, a.alias FROM aliases a JOIN sessions s ON s.session_id=a.session_id WHERE a.alias_ci=? AND a.active=1 AND s.project_alias=?`)
      .all(ref.alias.toLowerCase(), ref.projectAlias) as Array<{ session_id: string; alias: string }>;
    if (rows.length === 0) throw new XBusError(XBusErrorCode.UNKNOWN_RECIPIENT, 'unknown recipient');
    if (rows.length > 1) throw new XBusError(XBusErrorCode.AMBIGUOUS_RECIPIENT, 'ambiguous recipient; supply an exact session id');
    return { sessionId: rows[0]!.session_id, alias: rows[0]!.alias };
  }

  /**
   * Send. Pre-insert order: (sender fence check is done by caller) → idempotency
   * short-circuit → resolve → sequence-alloc + insert (one txn). Returns the
   * result; dispatch is initiated by the caller AFTER commit.
   */
  send(auth: SessionAuthority, input: SendInput): SendResult {
    return this.db.transaction(() => {
      // Idempotency short-circuit BEFORE resolve + BEFORE sequence allocation (F13).
      if (input.idempotencyKey) {
        const dup = this.db
          .prepare('SELECT message_id, correlation_id, recipient_session_id, recipient_alias, recipient_sequence FROM messages WHERE sender_session_id=? AND idempotency_key=?')
          .get(auth.sessionId, input.idempotencyKey) as
          | { message_id: string; correlation_id: string; recipient_session_id: string; recipient_alias: string; recipient_sequence: number }
          | undefined;
        if (dup) {
          const d = this.db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(dup.message_id) as { state: string } | undefined;
          return {
            messageId: dup.message_id, correlationId: dup.correlation_id, recipientSessionId: dup.recipient_session_id,
            recipientAlias: dup.recipient_alias, sequence: dup.recipient_sequence, state: d?.state ?? DeliveryState.QUEUED, deduplicated: true,
          };
        }
      }

      const recipient = this.resolveRecipient(input.to);

      // Blocked-sender policy (ADR 0009): reject BEFORE persistence if the
      // recipient has blocked this sender's alias. Do not return normal success.
      const senderAliasCi = this.aliasForSession(auth.sessionId).toLowerCase();
      if (this.controls.isBlocked(recipient.sessionId, senderAliasCi)) {
        this.audit('BLOCKED_SEND_REJECTED', { sessionId: auth.sessionId, recipient: recipient.alias });
        throw new XBusError(XBusErrorCode.BLOCKED, 'recipient has blocked this sender');
      }
      const now = this.clock.nowIso();
      const messageId = this.ids.next();
      const correlationId = messageId;
      const traceId = this.ids.next();

      // Allocate recipient sequence in the same txn.
      const seqRow = this.db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(recipient.sessionId) as { next_sequence: number } | undefined;
      const sequence = seqRow ? seqRow.next_sequence : 1;
      this.db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(recipient.sessionId, sequence + 1);

      const ttlMs = input.ttlSeconds ? input.ttlSeconds * 1000 : undefined;
      const expiresAt = ttlMs ? new Date(this.clock.nowMs() + ttlMs).toISOString() : null;

      this.db
        .prepare(
          `INSERT INTO messages (message_id, protocol_version, sender_session_id, sender_alias, recipient_session_id, recipient_alias, kind, correlation_id, causation_id, parent_message_id, recipient_sequence, idempotency_key, body_text, body_hash, metadata_json, requires_ack, requires_reply, not_before, expires_at, created_at, trace_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          messageId, PROTOCOL_VERSION, auth.sessionId, this.aliasForSession(auth.sessionId), recipient.sessionId, recipient.alias,
          input.kind, correlationId, null, null, sequence, input.idempotencyKey ?? null, input.text, hashBody(input.text),
          input.metadata ? JSON.stringify(input.metadata) : null, input.requiresAck ? 1 : 0, input.requiresReply ? 1 : 0,
          null, expiresAt, now, traceId,
        );

      this.db
        .prepare(`INSERT INTO deliveries (delivery_id, message_id, recipient_session_id, state, created_at, updated_at) VALUES (?,?,?, '${DeliveryState.QUEUED}', ?, ?)`)
        .run(this.ids.next(), messageId, recipient.sessionId, now, now);

      this.audit('MESSAGE_SENT', { sessionId: auth.sessionId, messageId, traceId, recipient: recipient.alias, sequence });

      return { messageId, correlationId, recipientSessionId: recipient.sessionId, recipientAlias: recipient.alias, sequence, state: DeliveryState.QUEUED, deduplicated: false };
    });
  }

  private aliasForSession(sessionId: string): string {
    const r = this.db.prepare(`SELECT alias FROM aliases WHERE session_id=? AND scope='global' AND active=1 ORDER BY alias_ci='session-'||substr(?,1,8) LIMIT 1`).get(sessionId, sessionId) as { alias: string } | undefined;
    if (r) return r.alias;
    const s = this.db.prepare('SELECT automatic_alias FROM sessions WHERE session_id=?').get(sessionId) as { automatic_alias: string } | undefined;
    return s?.automatic_alias ?? 'unknown';
  }
}
