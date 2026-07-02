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
import { validateSessionName, type NormalizedSessionName } from '../identity/session-name.js';
import type { SendInput } from '../protocol/schemas.js';
import { ComponentRole } from '../identity/components.js';
import { ControlsStore } from './controls.js';
import { resolveReadiness, isReadiness, type Readiness, type ReadinessHints } from './readiness.js';

/** 15 EXACT days (not "15 calendar dates") — ADR 0012 Decision 5. A session's
 *  routing expires this long after its last MEANINGFUL activity. */
export const MEANINGFUL_ACTIVITY_RETENTION_MS = 15 * 24 * 60 * 60_000;

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
  /** Beta.4: a human-readable name the session would like to hold. Valid +
   *  unclaimed ⇒ 'active'; taken/invalid ⇒ 'pending' (registration still succeeds,
   *  the session is just unroutable-by-name until the user picks one). */
  requestedSessionName?: string;
  /** Beta.4: adapter/agent type captured for diagnostics (NOT trust evidence). */
  agentType?: string;
}

/** Beta.4: outcome of a name claim (register or rename). */
export interface SessionNameStatus {
  state: 'unnamed' | 'pending' | 'active' | 'retired';
  name: string | null;
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
  /** Beta.4 (ADR 0012): the session's name lifecycle state at registration.
   *  Additive + optional — the frozen ack fields above are unchanged; clients that
   *  predate beta.4 ignore these. */
  sessionNameState?: 'unnamed' | 'pending' | 'active' | 'retired';
  /** Beta.4: the held display name when sessionNameState==='active', else null. */
  awardedSessionName?: string | null;
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

  /**
   * Refresh `last_meaningful_activity_at` (+ recompute the 15-day `expires_at`)
   * for a session. Call ONLY from genuinely meaningful, model-visible ops
   * (register, name op, send, ack/reject/reply, redeliver, body-injecting
   * checkpoint pull, intentional control change) — NEVER from passive liveness
   * (signalReadiness, reconnect, sweeps, health checks). Idempotent. Must run
   * inside the caller's transaction. ADR 0012 Decision 5.
   */
  refreshMeaningfulActivity(sessionId: string, nowIso?: string): void {
    const now = nowIso ?? this.clock.nowIso();
    const expiresAt = new Date(this.clock.nowMs() + MEANINGFUL_ACTIVITY_RETENTION_MS).toISOString();
    // Guard `expired_at IS NULL` (matching delivery.ts refreshActivity): activity must
    // NEVER silently revive a tombstoned session into an expired-yet-active row. Paths
    // that legitimately bring an expired session back (register-resume, rename-resume)
    // clear expired_at FIRST, so this update then applies; a stray refresh on a still-
    // expired row is a no-op. ADR 0012 D6 (tombstone not revived by activity).
    this.db.prepare('UPDATE sessions SET last_meaningful_activity_at=?, expires_at=?, updated_at=? WHERE session_id=? AND expired_at IS NULL').run(now, expiresAt, now, sessionId);
  }

  /**
   * Attempt to claim a session name during the register/rename transaction.
   * Returns the resulting status. A valid + unclaimed name is acquired ('active');
   * a TAKEN or INVALID name leaves the session 'pending' (caller must NOT fail
   * registration over it — the session is just unroutable-by-name until chosen).
   * The DB unique index `ux_session_name_active` is the authoritative race guard;
   * this pre-check produces the friendly state, and the index backstops a race.
   */
  private claimNameForRegister(sessionId: string, requested: string | undefined, now: string): SessionNameStatus {
    if (requested === undefined) return { state: 'unnamed', name: null };
    let norm: NormalizedSessionName;
    try {
      norm = validateSessionName(requested);
    } catch {
      // Invalid name → register as pending (unroutable) with a short reservation TTL.
      this.markPending(sessionId, now);
      return { state: 'pending', name: null };
    }
    const taken = this.db
      .prepare(`SELECT session_id FROM sessions WHERE normalized_session_name=? AND session_name_state IN ('active','pending') AND session_id<>?`)
      .get(norm.normalized, sessionId) as { session_id: string } | undefined;
    if (taken) {
      this.markPending(sessionId, now);
      return { state: 'pending', name: null };
    }
    try {
      this.db.prepare(`UPDATE sessions SET session_name=?, normalized_session_name=?, session_name_state='active', pending_name_expires_at=NULL, updated_at=? WHERE session_id=?`)
        .run(norm.display, norm.normalized, now, sessionId);
    } catch {
      // Lost a race to the unique index — fall back to pending, never throw.
      this.markPending(sessionId, now);
      return { state: 'pending', name: null };
    }
    return { state: 'active', name: norm.display };
  }

  /**
   * Put a session into the unroutable 'pending' name state with a reservation TTL.
   *
   * By design (ADR 0012 D4) a pending session holds NO name — normalized_session_name is
   * NULL, so it is unroutable AND it does NOT reserve the contested name for later. A
   * duplicate-name registrant is told, in effect, "that name is taken; you are pending —
   * choose another via rename." It has no claim on the contested name, so if the active
   * holder later renames/expires and a fresh session takes that name, that is correct, not
   * a lost reservation: pending is an escape-hatch state, not a FIFO queue for the name.
   * The pending session's ONLY route to a name is an explicit xbus_rename to a free one.
   * (Truly-invalid names also land here; same semantics.)
   */
  private markPending(sessionId: string, now: string): void {
    const pendingTtl = new Date(this.clock.nowMs() + 5 * 60_000).toISOString();
    this.db.prepare(`UPDATE sessions SET session_name=NULL, normalized_session_name=NULL, session_name_state='pending', pending_name_expires_at=?, updated_at=? WHERE session_id=?`)
      .run(pendingTtl, now, sessionId);
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
        .prepare('SELECT session_id, active_epoch, expired_at FROM sessions WHERE session_id = ?')
        .get(input.sessionId) as { session_id: string; active_epoch: number; expired_at: string | null } | undefined;

      // Beta.4 (ADR 0012 D6): an EXPIRED session resuming under its (stable)
      // CLAUDE_CODE_SESSION_ID must come back as a FRESH lifecycle — a new epoch with
      // its expiry tombstone cleared and its name re-claimed — NOT a passive join into
      // the dead epoch (which would leave expired_at set: a zombie whose sends are all
      // rejected and whose name stays 'retired'). The normal MCP reconnect never sets
      // supersede, so we detect the expired-resume here and route it through the same
      // fresh-lifecycle reset. The old queue stays dead-lettered (no resurrection).
      const isExpiredResume = !!existing && existing.expired_at !== null;
      const freshLifecycle = !!input.supersede || isExpiredResume;

      let epoch: number;
      if (!existing) {
        // First time: epoch 1.
        epoch = 1;
        const auto = automaticAlias(input.sessionId);
        this.db
          .prepare(
            `INSERT INTO sessions (session_id, active_instance_id, generation, high_water_generation, active_epoch, fencing_token, bound_connection_id, automatic_alias, project_id, cwd, repository_root, claude_code_version, xbus_version, capabilities_json, receive_mode, state, agent_type, connected_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'connected', ?,?,?,?,?)`,
          )
          .run(
            input.sessionId, componentInstanceId, epoch, epoch, epoch, epoch, input.connectionId,
            auto.display, input.projectId, input.cwd, input.repositoryRoot ?? null, input.claudeCodeVersion ?? null,
            XBUS_VERSION, JSON.stringify(input.capabilities), input.receiveMode, input.agentType ?? null, now, now, now, now,
          );
        this.db.prepare('INSERT OR IGNORE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, 1)').run(input.sessionId);
        this.upsertAliasRow(auto, 'global', null, input.sessionId, now);
        this.db.prepare('INSERT INTO session_epochs (session_id, epoch, epoch_token_hash, started_at) VALUES (?,?,?,?)').run(input.sessionId, epoch, this.nextEpochToken(), now);
      } else if (freshLifecycle) {
        // Genuine takeover (supersede) OR an expired session resuming: advance the epoch.
        epoch = existing.active_epoch + 1;
        this.db.prepare('UPDATE session_epochs SET superseded_at=?, supersede_reason=? WHERE session_id=? AND epoch=? AND superseded_at IS NULL').run(now, isExpiredResume ? 'expired_resume' : 'supersede', input.sessionId, existing.active_epoch);
        this.db.prepare('INSERT INTO session_epochs (session_id, epoch, epoch_token_hash, started_at) VALUES (?,?,?,?)').run(input.sessionId, epoch, this.nextEpochToken(), now);
        // New epoch ⇒ new owner: readiness resets to initializing until it signals (§2).
        // Beta.4: a fresh lifecycle clears any prior expiry tombstone fields + name
        // binding so the new epoch is routable again and the name is re-claimed below
        // (ADR 0012). The old queue is NOT resurrected for an EXPIRED resume — the
        // expiry sweep already dead-lettered it, and we only re-home transport_written
        // rows (in-flight to the prior live owner), which an expired session has none of.
        this.db.prepare(`UPDATE sessions SET active_epoch=?, generation=?, high_water_generation=?, fencing_token=?, state='connected', readiness='initializing', readiness_updated_at=?, expired_at=NULL, expiration_reason=NULL, session_name_state='unnamed', session_name=NULL, normalized_session_name=NULL, pending_name_expires_at=NULL, last_seen_at=?, updated_at=? WHERE session_id=?`).run(epoch, epoch, epoch, epoch, now, now, now, input.sessionId);
        this.db.prepare(`UPDATE component_instances SET state='superseded', disconnected_at=? WHERE session_id=? AND state='live'`).run(now, input.sessionId);
        // Re-queue any in-flight injection of the PRIOR (now replaced) live owner.
        // For an expired resume there are none (the sweep dead-lettered the queue),
        // so this is a no-op there — old dead_letter rows are NOT touched.
        this.db.prepare(`UPDATE deliveries SET state='${DeliveryState.QUEUED}', transport_written_at=NULL, target_instance_id=NULL, updated_at=? WHERE recipient_session_id=? AND state='${DeliveryState.TRANSPORT_WRITTEN}'`).run(now, input.sessionId);
        if (isExpiredResume) {
          // The expiry sweep retired ALL of this session's alias rows (active=0),
          // including the broker-minted automatic_alias (session-<8hex>) — the
          // always-present fallback address. A resumed session must be routable by
          // that alias again (ADR 0012 / reaper.ts: 'still routable by its
          // automatic_alias'); reactivate it (re-upsert if the row was pruned). The
          // session's prior USER name stays released (re-claimed below if requested).
          const auto = automaticAlias(input.sessionId);
          const reactivated = this.db.prepare(`UPDATE aliases SET active=1, retired_at=NULL WHERE session_id=? AND alias_ci=? AND scope='global'`).run(input.sessionId, auto.ci);
          if (reactivated.changes === 0) this.upsertAliasRow(auto, 'global', null, input.sessionId, now);
          this.audit('EXPIRED_SESSION_RESUMED', { sessionId: input.sessionId, epoch });
        }
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

      // Beta.4 (ADR 0012): name claim + meaningful-activity stamp happen only on a
      // GENUINELY NEW session lifecycle (first registration, a true supersede, or an
      // expired session resuming) — never on a passive component join/reconnect, where
      // joining is not "activity" and a reconnecting hook must not re-roll the name or
      // extend the idle timer.
      const isNewLifecycle = !existing || freshLifecycle;
      let nameStatus: SessionNameStatus;
      if (isNewLifecycle) {
        nameStatus = this.claimNameForRegister(input.sessionId, input.requestedSessionName, now);
        this.refreshMeaningfulActivity(input.sessionId, now);
      } else {
        const cur = this.db.prepare(`SELECT session_name_state AS s, session_name AS n FROM sessions WHERE session_id=?`).get(input.sessionId) as { s: SessionNameStatus['state']; n: string | null };
        // First-name-on-reconnect (registration-order race fix): the lifecycle hook can
        // register a session as `unnamed` (projectId 'proj-hook', no requestedSessionName)
        // BEFORE the MCP server's named registration arrives. That MCP register is a
        // reconnect (not a new lifecycle), so historically it left the session unnamed
        // forever. Claiming a name for a still-`unnamed` session is NOT a disruptive
        // "re-roll" (the guard above protects `active`/`pending` names) — it is the FIRST
        // name the session ever gets, so do it here when a name was requested. This makes
        // auto-naming deterministic regardless of hook-vs-MCP registration order.
        if (cur.s === 'unnamed' && input.requestedSessionName !== undefined) {
          nameStatus = this.claimNameForRegister(input.sessionId, input.requestedSessionName, now);
          // Backfill agent_type when the first (hook) registration left it null, so the
          // named session reports its real agent, not the hook placeholder.
          if (input.agentType !== undefined) {
            this.db.prepare(`UPDATE sessions SET agent_type=COALESCE(agent_type, ?) WHERE session_id=?`).run(input.agentType, input.sessionId);
          }
        } else {
          nameStatus = { state: cur.s, name: cur.n };
        }
      }

      this.audit('COMPONENT_REGISTERED', { sessionId: input.sessionId, instanceId: componentInstanceId, role, epoch, sessionNameState: nameStatus.state });
      return {
        sessionId: input.sessionId, instanceId: componentInstanceId, componentInstanceId, role, epoch,
        generation: epoch, fencingToken: epochToken, connectionId: input.connectionId,
        sessionNameState: nameStatus.state, awardedSessionName: nameStatus.name,
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
   * Beta.4 (ADR 0012 Decision 4): atomically (re)name the authenticated session.
   * Validates the new name, acquires it via the unique index (case-insensitive,
   * reserve-on-claim), releases the old name, refreshes meaningful activity, and
   * audits. Promotes a 'pending' session to 'active'. Throws SESSION_NAME_TAKEN if
   * another active/pending session holds it, INVALID_SESSION_NAME if malformed.
   * mcp-role only (a hook must not rename). All in one transaction so a failure
   * leaves the prior name binding intact.
   */
  renameSession(auth: SessionAuthority, rawName: string): SessionNameStatus {
    if (auth.role !== ComponentRole.MCP) {
      throw new XBusError(XBusErrorCode.FORBIDDEN_ROLE, 'only the mcp component may name/rename a session');
    }
    const norm = validateSessionName(rawName); // throws INVALID_SESSION_NAME
    return this.db.transaction(() => {
      const s = this.db.prepare('SELECT active_epoch, session_name_state AS state, expired_at AS expiredAt FROM sessions WHERE session_id=?').get(auth.sessionId) as { active_epoch: number; state: string; expiredAt: string | null } | undefined;
      if (!s) throw new XBusError(XBusErrorCode.SESSION_NOT_REGISTERED, 'session not registered');
      if (s.active_epoch !== auth.epoch) throw new XBusError(XBusErrorCode.EPOCH_MISMATCH, 'stale epoch; re-register');
      const taken = this.db
        .prepare(`SELECT session_id FROM sessions WHERE normalized_session_name=? AND session_name_state IN ('active','pending') AND session_id<>?`)
        .get(norm.normalized, auth.sessionId) as { session_id: string } | undefined;
      if (taken) throw new XBusError(XBusErrorCode.SESSION_NAME_TAKEN, 'session name already in use', { name: norm.display });
      const now = this.clock.nowIso();
      // Beta.4 (ADR 0012 D6): if this session was EXPIRED (the reaper set expired_at +
      // 'retired' while its connection stayed alive on non-meaningful heartbeats), a
      // rename must RESURRECT it — clear the tombstone — not half-revive it. Leaving
      // expired_at set while flipping session_name_state='active' would create an
      // unroutable-yet-name-holding row that permanently locks the name (the reaper
      // never re-expires it). Clearing expired_at here also makes the subsequent
      // refreshMeaningfulActivity (guarded on expired_at IS NULL) apply. The live
      // connection keeps the current epoch — naming is the meaningful activity that
      // brings the session back.
      const wasExpired = s.expiredAt !== null;
      try {
        this.db.prepare(`UPDATE sessions SET session_name=?, normalized_session_name=?, session_name_state='active', pending_name_expires_at=NULL, expired_at=NULL, expiration_reason=NULL, updated_at=? WHERE session_id=?`)
          .run(norm.display, norm.normalized, now, auth.sessionId);
      } catch {
        // Unique-index race: someone else acquired it between the check and the write.
        throw new XBusError(XBusErrorCode.SESSION_NAME_TAKEN, 'session name already in use', { name: norm.display });
      }
      this.refreshMeaningfulActivity(auth.sessionId, now); // now applies (expired_at cleared above)
      this.audit(wasExpired ? 'EXPIRED_SESSION_RESUMED_VIA_RENAME' : 'SESSION_RENAMED', { sessionId: auth.sessionId, name: norm.display });
      return { state: 'active', name: norm.display };
    });
  }

  /** Beta.4: discoverable active-named sessions (excludes pending/unnamed/retired
   *  and any session that has expired). Used by the discovery / list-sessions path. */
  listActiveNamedSessions(): Array<{ sessionId: string; name: string; projectId: string; agentType: string | null }> {
    return this.db
      .prepare(`SELECT session_id AS sessionId, session_name AS name, project_id AS projectId, agent_type AS agentType FROM sessions WHERE session_name_state='active' AND expired_at IS NULL ORDER BY normalized_session_name`)
      .all() as Array<{ sessionId: string; name: string; projectId: string; agentType: string | null }>;
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
      const want = ref.alias.toLowerCase();
      // Beta.4: a bare recipient may name a SESSION NAME (active only) or a routing
      // alias — distinct pools, both valid `to:` targets. Match both, dedup by
      // session, and reject ambiguity. Pending/unnamed/retired names are NOT routable.
      const byName = this.db.prepare(`SELECT session_id, session_name AS alias FROM sessions WHERE normalized_session_name=? AND session_name_state='active' AND expired_at IS NULL`).all(want) as Array<{ session_id: string; alias: string }>;
      const byAlias = this.db.prepare(`SELECT session_id, alias FROM aliases WHERE alias_ci=? AND active=1`).all(want) as Array<{ session_id: string; alias: string }>;
      const merged = new Map<string, { session_id: string; alias: string }>();
      for (const r of [...byName, ...byAlias]) merged.set(r.session_id, r);
      const rows = [...merged.values()];
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
      //
      // Idempotency × expiry contract (ADR 0012 Decision 6): a retry with a KNOWN key
      // must NEVER create new routing to — or revive/requeue a delivery for — a recipient
      // that has since expired. It returns the ALREADY-RECORDED result. Two sub-cases:
      //   • the original delivery is TERMINAL (completed / dead_letter / rejected /
      //     expired): return that terminal result verbatim (deduplicated). This is a
      //     faithful replay of the recorded outcome, not new routing — nothing is
      //     re-queued, no body is resurrected. (After the recipient expires, the reaper
      //     has already moved a queued delivery to dead_letter, so a retry reports
      //     dead_letter — the honest terminal state.)
      //   • the original delivery is NON-terminal (still live: queued / retry_wait /
      //     transport_written) BUT the recipient is now expired: returning success would
      //     imply live routing to an unroutable session, so reject FINAL with
      //     RECIPIENT_SESSION_EXPIRED — uniform with the fresh-send path below.
      // The recipient-expiry read + delivery-state read happen in THIS transaction, so
      // the decision is consistent with a concurrent expiry sweep (serialized by SQLite).
      if (input.idempotencyKey) {
        const dup = this.db
          .prepare('SELECT message_id, correlation_id, recipient_session_id, recipient_alias, recipient_sequence FROM messages WHERE sender_session_id=? AND idempotency_key=?')
          .get(auth.sessionId, input.idempotencyKey) as
          | { message_id: string; correlation_id: string; recipient_session_id: string; recipient_alias: string; recipient_sequence: number }
          | undefined;
        if (dup) {
          const d = this.db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(dup.message_id) as { state: string } | undefined;
          const state = d?.state ?? DeliveryState.QUEUED;
          const terminal = state === DeliveryState.COMPLETED || state === DeliveryState.DEAD_LETTER || state === DeliveryState.REJECTED || state === DeliveryState.EXPIRED;
          if (!terminal) {
            const dupExp = this.db.prepare('SELECT expired_at FROM sessions WHERE session_id=?').get(dup.recipient_session_id) as { expired_at: string | null } | undefined;
            if (dupExp?.expired_at) {
              // Live delivery to a now-expired recipient — do not report success on retry.
              this.audit('SEND_REJECTED_RECIPIENT_EXPIRED', { sessionId: auth.sessionId, recipient: dup.recipient_alias, idempotent: true });
              throw new XBusError(XBusErrorCode.RECIPIENT_SESSION_EXPIRED, 'recipient session expired (no activity for 15 days); it must re-register', { recipient: dup.recipient_alias });
            }
          }
          return {
            messageId: dup.message_id, correlationId: dup.correlation_id, recipientSessionId: dup.recipient_session_id,
            recipientAlias: dup.recipient_alias, sequence: dup.recipient_sequence, state, deduplicated: true,
          };
        }
      }

      const recipient = this.resolveRecipient(input.to);

      // Beta.4 (ADR 0012 Decision 6): a recipient that has expired (>15 days idle)
      // is unroutable. Reject the send FINAL / non-retryable — never queue silently
      // for a session whose name was released. This is AFTER the idempotency
      // short-circuit (above), so a retried send to an expired recipient does not
      // quietly "succeed" off a prior row. Resolving an expired session is only
      // possible by raw session id (its name was released); guard it explicitly.
      const exp = this.db.prepare('SELECT expired_at FROM sessions WHERE session_id=?').get(recipient.sessionId) as { expired_at: string | null } | undefined;
      if (exp?.expired_at) {
        this.audit('SEND_REJECTED_RECIPIENT_EXPIRED', { sessionId: auth.sessionId, recipient: recipient.alias });
        throw new XBusError(XBusErrorCode.RECIPIENT_SESSION_EXPIRED, 'recipient session expired (no activity for 15 days); it must re-register', { recipient: recipient.alias });
      }

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

      // Beta.4: sending is meaningful activity for the SENDER (ADR 0012 Decision 5).
      this.refreshMeaningfulActivity(auth.sessionId, now);
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
