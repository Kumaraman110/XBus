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
import { ComponentRole } from '../identity/components.js';
import { ControlsStore } from './controls.js';
import { resolveReadiness, isReadiness, type Readiness, type ReadinessHints } from './readiness.js';
import { ledgerAppend, type LedgerSubject } from './ledger.js';
import type { ImportedSessionMeta } from './session-import.js';
import { OPERATOR_SESSION_ID, OPERATOR_ALIAS, OPERATOR_ACTOR_KIND, OPERATOR_LEDGER_ACTOR } from './operator.js';
import type { SendInput } from '../protocol/schemas.js';

/** Input the operator console supplies to operatorSend (identity is broker-stamped; the
 *  browser never sets sender/actor). Extends the validated SendInput with thread routing +
 *  an optional operator-set subject for a NEW thread. */
export type OperatorSendInput = SendInput & { threadId?: string; parentMessageId?: string; subject?: string };

/** 15 EXACT days (not "15 calendar dates") — ADR 0012 Decision 5. A session's
 *  routing expires this long after its last MEANINGFUL activity. */
export const MEANINGFUL_ACTIVITY_RETENTION_MS = 15 * 24 * 60 * 60_000;

/**
 * Beta.5 Phase 1 (ADR 0013 D2): SessionStart `source` → the ledger event type recorded
 * for that lifecycle transition. `fork` is not a distinct SessionStart source — a fork
 * fires `startup` with a NEW session_id (ADR 0013 D4), so it maps to the same
 * SESSION_STARTED; the NEW-identity property is what makes it a fork, not a `source` value.
 */
type LifecycleSource = 'startup' | 'resume' | 'clear' | 'compact';
const LIFECYCLE_EVENT_BY_SOURCE: Record<LifecycleSource, string> = {
  startup: 'SESSION_STARTED',
  resume: 'SESSION_RESUMED',
  clear: 'SESSION_CLEARED',
  compact: 'SESSION_COMPACTED',
};

/** Normalize an untrusted SessionStart `source` to a known lifecycle kind. Unknown /
 *  `--continue` variants collapse to `resume` (the hook contract lists resume as covering
 *  `--resume`/`--continue`/`/resume`); a genuinely unrecognized value degrades to `resume`
 *  rather than throwing — the hook must never fail Claude startup over a new source name. */
function normalizeLifecycleSource(raw: string): LifecycleSource {
  switch (raw) {
    case 'startup': return 'startup';
    case 'clear': return 'clear';
    case 'compact': return 'compact';
    case 'resume':
    case 'continue':
    default: return 'resume';
  }
}

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
   * Beta.5 Phase 1 (ADR 0016/0020 Q3): append ONE hash-chained `ledger_events` row in
   * the CALLER's transaction, so the audit projection shares the state mutation's fate
   * (no divergence). `actor` is the authenticated session id (or 'broker'/'installer').
   * `subject` carries ids only; `payload` carries SAFE metadata (states/counts/hashes),
   * never bodies/secrets. A ledger-specific failure throws AUDIT_PERSISTENCE_FAILED,
   * aborting the whole op — a deliberate availability tradeoff (Q3). MUST be called
   * inside a `this.db.transaction(...)`.
   */
  private ledger(eventType: string, actor: string, subject: LedgerSubject, payload: Record<string, unknown>): void {
    ledgerAppend(this.db, this.ids, this.clock, eventType, actor, subject, payload);
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
        this.upsertAutomaticAliasSafe(auto, input.sessionId, now);
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
          this.upsertAutomaticAliasSafe(automaticAlias(input.sessionId), input.sessionId, now);
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

  /**
   * Claim the broker-minted automatic fallback alias (`session-<8hex>`) collision-safe —
   * the SINGLE entry for acquiring the automatic alias on register/resume/rename.
   *
   * The automatic alias is derived from only the first 8 hex chars of the sessionId
   * (aliases.ts), so two DISTINCT sessions whose CLAUDE_CODE_SESSION_IDs share that
   * prefix would map to the SAME `alias_ci`. Any write that flips `active=1` on such a
   * row — a bare INSERT (first register) OR a bare reactivation `UPDATE ... active=1`
   * (expired-/rename-resume, where the sweep left this session's own row at active=0 but
   * another prefix-mate has since claimed it active) — hits the active-unique
   * `ux_alias_global` index and throws a raw `UNIQUE constraint failed`, which the daemon
   * mislabels as `DATABASE_ERROR "internal error"` and FAILS the whole registration.
   *
   * The automatic alias is a NON-ESSENTIAL convenience address: a session is always
   * routable by its exact sessionId (resolveRecipient session-kind) and its
   * sessions.automatic_alias column is set regardless. So an 8-hex-prefix collision must
   * NEVER fail registration nor leak an internal error — mirror registerAlias(): resolve
   * the CURRENT active holder first, and:
   *   - held by ANOTHER active session ⇒ skip (audited); the peer stays routable by id;
   *   - held by THIS session already     ⇒ no-op (idempotent);
   *   - held by no active session        ⇒ reactivate THIS session's retired row if it
   *                                         has one (active=0 → active=1), else insert.
   * All reads/writes here are inside the caller's register()/renameSession() transaction
   * on synchronous single-threaded node:sqlite, so there is no TOCTOU window.
   */
  private upsertAutomaticAliasSafe(alias: NormalizedAlias, sessionId: string, now: string): void {
    const clash = this.db
      .prepare(`SELECT session_id FROM aliases WHERE alias_ci=? AND scope='global' AND active=1`)
      .get(alias.ci) as { session_id: string } | undefined;
    if (clash) {
      if (clash.session_id !== sessionId) {
        this.audit('AUTOMATIC_ALIAS_COLLISION', { sessionId, alias: alias.display, heldBy: clash.session_id });
      }
      return; // already active (this session or another) — never a duplicate/constraint hit
    }
    // No active holder. Reactivate this session's own retired row if present, else insert.
    const reactivated = this.db
      .prepare(`UPDATE aliases SET active=1, retired_at=NULL WHERE session_id=? AND alias_ci=? AND scope='global'`)
      .run(sessionId, alias.ci);
    if (reactivated.changes === 0) this.upsertAliasRow(alias, 'global', null, sessionId, now);
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
   * Beta.5 Phase 1 (ADR 0013 D2 / ADR 0020): record a SessionStart lifecycle signal
   * for the AUTHENTICATED session and make it visible in the control plane. Runs in ONE
   * transaction: an idempotent UPDATE of the visibility columns + exactly one hash-chained
   * ledger event (or none, for a deduped duplicate birth) — never state without its audit
   * row (Q3). Identity is the connection's authenticated `auth.sessionId`; nothing here is
   * read from a caller-supplied session id.
   *
   * The session row already exists (the daemon enforces register_session BEFORE announce),
   * and the epoch/expiry/fork mechanics are already settled by register(): an expired
   * `resume` advanced the epoch + cleared the tombstone (fresh lifecycle, NO message
   * resurrection); a fork arrived with a DISTINCT session_id → its own epoch-1 row. So
   * announce is purely the visibility + audit layer on top.
   *
   * Idempotency (identity-level, tested): repeated announces converge the same columns,
   * never create a second session row or inflate the epoch, and the session appears
   * exactly once in the read model. A duplicate `startup` (a second "birth" of a session
   * already seen) is absorbed — state re-stamped, NO duplicate STARTED ledger event. The
   * genuinely-repeatable signals (`resume`/`clear`/`compact`) each append their own event,
   * because that is exactly the lifecycle history an append-only audit ledger exists to keep.
   */
  announceSession(
    auth: SessionAuthority,
    input: { source: string; cwd?: string; transcriptPath?: string; agentType?: string },
  ): { managementState: string; priorManagementState: string; source: string; lifecycleEvent: string; epoch: number; appended: boolean } {
    return this.db.transaction(() => {
      const now = this.clock.nowIso();
      const row = this.db
        .prepare('SELECT active_epoch AS epoch, management_state AS mgmt, expired_at AS expiredAt FROM sessions WHERE session_id=?')
        .get(auth.sessionId) as { epoch: number; mgmt: string; expiredAt: string | null } | undefined;
      if (!row) throw new XBusError(XBusErrorCode.SESSION_NOT_REGISTERED, 'session not registered');

      const source = normalizeLifecycleSource(input.source);
      const lifecycleEvent = LIFECYCLE_EVENT_BY_SOURCE[source];
      const priorManagementState = row.mgmt;

      // TOMBSTONE GUARD (ADR 0012 D6): an announce must NEVER revive an EXPIRED session.
      // Resurrection is the exclusive job of the register/rename fresh-lifecycle paths,
      // which clear expired_at + advance the epoch (no message resurrection). The normal
      // hook re-registers BEFORE announcing, so a genuinely-resumed session already has
      // expired_at cleared by the time we get here. If we still see a tombstone (e.g. a
      // long-lived connection that idled 15d on heartbeats then announced without
      // re-registering), do NOT flip management_state to 'active' and do NOT append a
      // lifecycle event claiming the session is active — that would create the
      // unroutable-yet-active anti-pattern the register/rename paths defend against.
      // Honest no-op: the session stays expired until a real re-register resurrects it.
      if (row.expiredAt !== null) {
        this.audit('SESSION_ANNOUNCE_SKIPPED_EXPIRED', { sessionId: auth.sessionId, source, epoch: row.epoch });
        return { managementState: priorManagementState, priorManagementState, source, lifecycleEvent, epoch: row.epoch, appended: false };
      }

      // Idempotent visibility update. management_state → 'active' (a live SessionStart
      // signal is the highest-confidence identification); a dormant/unmanaged row is thus
      // activated. transcript_path + agent_type are backfilled (COALESCE) so a later
      // richer signal fills gaps without clobbering an existing value. first_seen_at is
      // stamped once. identify_confidence is 'signal' (documented hook input, ADR 0020 Q1).
      this.db
        .prepare(
          `UPDATE sessions SET management_state='active', source_last=?, identify_confidence='signal',
             transcript_path=COALESCE(?, transcript_path), agent_type=COALESCE(agent_type, ?),
             cwd=COALESCE(?, cwd),
             first_seen_at=COALESCE(first_seen_at, ?), last_seen_source_at=?, updated_at=? WHERE session_id=?`,
        )
        .run(source, input.transcriptPath ?? null, input.agentType ?? null, input.cwd ?? null, now, now, now, auth.sessionId);

      this.audit('SESSION_ANNOUNCED', { sessionId: auth.sessionId, source, epoch: row.epoch, priorManagementState });

      // Exactly one ledger event per genuine lifecycle signal. Dedup a `startup` ONLY when a
      // SESSION_STARTED has ALREADY been recorded for THIS session (a meaningless second
      // birth) — keyed on the actual ledger history, NOT on first_seen_at (which is also set
      // by import + by a first resume/clear/compact, so a first_seen_at test would wrongly
      // suppress a genuine post-import/post-resume `startup`). resume/clear/compact always
      // append — that repeatable lifecycle history is exactly what the audit ledger keeps.
      let appended = true;
      if (source === 'startup') {
        const priorStart = this.db
          .prepare(`SELECT 1 FROM ledger_events WHERE event_type='SESSION_STARTED' AND subject_json=? LIMIT 1`)
          .get(JSON.stringify({ sessionId: auth.sessionId }));
        if (priorStart) appended = false;
      }
      if (appended) {
        this.ledger(lifecycleEvent, auth.sessionId, { sessionId: auth.sessionId }, {
          source, epoch: row.epoch, managementState: 'active', priorManagementState, confidence: 'signal',
        });
      }
      return { managementState: 'active', priorManagementState, source, lifecycleEvent, epoch: row.epoch, appended };
    });
  }

  /**
   * Beta.5 Phase 1 (ADR 0013 D5): import previously-existing sessions as DORMANT rows from
   * transcript-listing metadata (session-import.ts — filenames + mtime ONLY, no bodies).
   * Each becomes an UNROUTABLE `dormant` row with `identify_confidence='listing_only'`
   * (honest: known from on-disk history, not a live managed session). One ledger event per
   * newly-imported session (SESSION_IMPORTED). Idempotent + SAFE:
   *   - a session_id that ALREADY exists is SKIPPED entirely — import must never downgrade
   *     an active/dormant/expired row, overwrite its name/epoch, or reset activity;
   *   - a re-run imports only genuinely-new ids (already-imported ones are skipped).
   * Returns the count actually imported. All in one transaction.
   */
  importDormantSessions(metas: ImportedSessionMeta[]): { imported: number; skipped: number } {
    return this.db.transaction(() => {
      const now = this.clock.nowIso();
      let imported = 0; let skipped = 0;
      for (const m of metas) {
        const existing = this.db.prepare('SELECT session_id FROM sessions WHERE session_id=?').get(m.sessionId) as { session_id: string } | undefined;
        if (existing) { skipped += 1; continue; } // never touch an already-known session
        const auto = automaticAlias(m.sessionId);
        const lastSeenIso = new Date(m.lastSeenMs).toISOString();
        // Insert a minimal dormant row. It is NOT connected (state='disconnected'), NOT
        // routable (dormant + no active name), NOT counted active, and its retention clock
        // is NOT started (dormant is not meaningful activity — ADR 0013). project_id is the
        // opaque slug (we did not open the transcript to learn the real cwd).
        this.db.prepare(
          `INSERT INTO sessions (session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json, receive_mode, state, last_seen_at, created_at, updated_at,
             management_state, source_last, identify_confidence, transcript_path, first_seen_at, last_seen_source_at)
           VALUES (?,?,?,?,?,?, 'disconnected', 'disconnected', ?,?,?, 'dormant', 'import', 'listing_only', ?,?,?)`,
        ).run(
          m.sessionId, auto.display, `slug-${m.projectSlug}`, m.projectSlug, XBUS_VERSION, '[]',
          lastSeenIso, lastSeenIso, now, m.transcriptPath, now, lastSeenIso,
        );
        this.audit('SESSION_IMPORTED', { sessionId: m.sessionId, source: 'import', confidence: 'listing_only' });
        this.ledger('SESSION_IMPORTED', 'installer', { sessionId: m.sessionId }, { source: 'import', managementState: 'dormant', confidence: 'listing_only' });
        imported += 1;
      }
      return { imported, skipped };
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
        // On a rename that RESURRECTS an expired session, also restore readiness to
        // 'initializing' (mirroring the register-based expired-resume at the freshLifecycle
        // branch). The reaper forced readiness='disconnected' at expiry; if left there the
        // revived session — though now name-active and routable — would never be injected
        // queued messages until it independently re-signalled. 'initializing' is the safe
        // resume state: the live MCP's next signalReadiness (or its already-sent hints)
        // resolves it to a delivering state. A NON-expired rename must NOT touch readiness.
        if (wasExpired) {
          this.db.prepare(`UPDATE sessions SET session_name=?, normalized_session_name=?, session_name_state='active', pending_name_expires_at=NULL, expired_at=NULL, expiration_reason=NULL, readiness='initializing', readiness_updated_at=?, updated_at=? WHERE session_id=?`)
            .run(norm.display, norm.normalized, now, now, auth.sessionId);
        } else {
          this.db.prepare(`UPDATE sessions SET session_name=?, normalized_session_name=?, session_name_state='active', pending_name_expires_at=NULL, expired_at=NULL, expiration_reason=NULL, updated_at=? WHERE session_id=?`)
            .run(norm.display, norm.normalized, now, auth.sessionId);
        }
      } catch {
        // Unique-index race: someone else acquired it between the check and the write.
        throw new XBusError(XBusErrorCode.SESSION_NAME_TAKEN, 'session name already in use', { name: norm.display });
      }
      if (wasExpired) {
        // The expiry sweep retired ALL alias rows (active=0), including the broker-minted
        // automatic_alias (session-<8hex>) — the always-present fallback address. A
        // resurrected session must be routable by that alias again, exactly as the
        // register-based expired-resume path reactivates it (see register()). Reactivate
        // the row (re-upsert if it was pruned). Any user name is set above.
        this.upsertAutomaticAliasSafe(automaticAlias(auth.sessionId), auth.sessionId, now);
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

      // Beta.6 (ADR 0017/0021): a root send OPENS a degenerate thread whose id == this
      // message id == its correlation id (matches the existing convention), so every
      // message — peer or operator — is a thread turn and visible in the console timeline.
      // thread_sequence 1 is this opening turn. author_type='claude' (peer send).
      const threadId = correlationId; // == messageId for a root send
      this.ensureThread(threadId, messageId, auth.sessionId, 'claude', now);
      const threadSequence = this.allocThreadSequence(threadId);
      this.ensureParticipant(threadId, auth.sessionId, 'claude', now);
      this.ensureParticipant(threadId, recipient.sessionId, 'claude', now);

      this.db
        .prepare(
          `INSERT INTO messages (message_id, protocol_version, sender_session_id, sender_alias, recipient_session_id, recipient_alias, kind, correlation_id, causation_id, parent_message_id, recipient_sequence, idempotency_key, body_text, body_hash, metadata_json, requires_ack, requires_reply, not_before, expires_at, created_at, trace_id, thread_id, thread_sequence, author_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          messageId, PROTOCOL_VERSION, auth.sessionId, this.aliasForSession(auth.sessionId), recipient.sessionId, recipient.alias,
          input.kind, correlationId, null, null, sequence, input.idempotencyKey ?? null, input.text, hashBody(input.text),
          input.metadata ? JSON.stringify(input.metadata) : null, input.requiresAck ? 1 : 0, input.requiresReply ? 1 : 0,
          null, expiresAt, now, traceId, threadId, threadSequence, 'claude',
        );
      this.touchThread(threadId, threadSequence, now);

      this.db
        .prepare(`INSERT INTO deliveries (delivery_id, message_id, recipient_session_id, state, created_at, updated_at) VALUES (?,?,?, '${DeliveryState.QUEUED}', ?, ?)`)
        .run(this.ids.next(), messageId, recipient.sessionId, now, now);

      // Beta.4: sending is meaningful activity for the SENDER (ADR 0012 Decision 5).
      this.refreshMeaningfulActivity(auth.sessionId, now);
      this.audit('MESSAGE_SENT', { sessionId: auth.sessionId, messageId, traceId, recipient: recipient.alias, sequence });

      return { messageId, correlationId, recipientSessionId: recipient.sessionId, recipientAlias: recipient.alias, sequence, state: DeliveryState.QUEUED, deduplicated: false };
    });
  }

  // ─────────────────────────── beta.6 thread helpers (ADR 0017/0021) ───────────────────────────

  /** Ensure a `threads` row + `thread_sequences` cursor exist for a thread. Idempotent
   *  (INSERT OR IGNORE); called from send()/reply()/operatorSend inside their transaction. */
  private ensureThread(threadId: string, rootMessageId: string, createdByActor: string, _actorKind: string, now: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO threads (thread_id, root_message_id, subject, created_by_actor, state, created_at, updated_at, last_message_at, last_thread_sequence)
       VALUES (?,?,?,?, 'open', ?,?,?, 0)`,
    ).run(threadId, rootMessageId, null, createdByActor, now, now, now);
    this.db.prepare('INSERT OR IGNORE INTO thread_sequences (thread_id, next_sequence) VALUES (?, 1)').run(threadId);
  }

  /** Allocate the next per-thread sequence (monotonic, gap-free — single writer). Mirrors
   *  recipient_sequences. MUST run inside the caller's transaction. */
  private allocThreadSequence(threadId: string): number {
    const row = this.db.prepare('SELECT next_sequence FROM thread_sequences WHERE thread_id=?').get(threadId) as { next_sequence: number } | undefined;
    const seq = row ? row.next_sequence : 1;
    this.db.prepare('INSERT OR REPLACE INTO thread_sequences (thread_id, next_sequence) VALUES (?, ?)').run(threadId, seq + 1);
    return seq;
  }

  /** Ensure a participant row for (thread, session). Idempotent via UNIQUE(thread_id,
   *  session_id). Never resets an existing participant's read cursor. */
  private ensureParticipant(threadId: string, sessionId: string, actorKind: string, now: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO thread_participants (participant_id, thread_id, session_id, actor_kind, participant_role, joined_at, last_read_thread_seq, muted)
       VALUES (?,?,?,?, 'member', ?, 0, 0)`,
    ).run(this.ids.next(), threadId, sessionId, actorKind, now);
  }

  /** Advance the thread's activity stamps + last sequence. */
  private touchThread(threadId: string, threadSequence: number, now: string): void {
    this.db.prepare('UPDATE threads SET updated_at=?, last_message_at=?, last_thread_sequence=MAX(last_thread_sequence, ?) WHERE thread_id=?').run(now, now, threadSequence, threadId);
  }

  private aliasForSession(sessionId: string): string {
    const r = this.db.prepare(`SELECT alias FROM aliases WHERE session_id=? AND scope='global' AND active=1 ORDER BY alias_ci='session-'||substr(?,1,8) LIMIT 1`).get(sessionId, sessionId) as { alias: string } | undefined;
    if (r) return r.alias;
    const s = this.db.prepare('SELECT automatic_alias FROM sessions WHERE session_id=?').get(sessionId) as { automatic_alias: string } | undefined;
    return s?.automatic_alias ?? 'unknown';
  }

  // ─────────────────────── beta.6 operator console (ADR 0021) ───────────────────────

  /**
   * Send a message AS the reserved `local-operator` principal (ADR 0021) — the dashboard
   * communication console's ONLY write. Identity is ALWAYS broker-stamped: the browser
   * supplies only {to, text, threadId?, parentMessageId?, requiresAck, requiresReply,
   * idempotencyKey?, ttlSeconds?, subject?}, never a sender/actor field. Reuses the SAME
   * durable lifecycle as store.send (QUEUED delivery, recipient checkpoint pull injects it
   * identically to a peer message) plus threading:
   *   - no threadId  → OPENS a new thread (thread_id = this message id = correlation id);
   *   - threadId set → CONTINUES it (correlation_id = thread's root, parent = the answered turn).
   * Appends exactly ONE hash-chained ledger event (actor='local-operator', subject.threadId)
   * in the same transaction. Idempotent on (operator, idempotencyKey) via ux_idem.
   * The recipient identity is validated (must be a real, non-expired, routable-by-address
   * session); the operator can never send to itself. Message text stays untrusted-peer
   * content to the recipient (validateSendInput reserved-key defense is applied by the caller).
   */
  operatorSend(input: OperatorSendInput): SendResult & { threadId: string; threadSequence: number; authorType: string } {
    return this.db.transaction(() => {
      const now = this.clock.nowIso();
      // Idempotency short-circuit (operator-scoped) — a double-click / retry with the same
      // key returns the recorded result, never a duplicate row (ux_idem on sender+key).
      if (input.idempotencyKey) {
        const dup = this.db
          .prepare('SELECT message_id, correlation_id, recipient_session_id, recipient_alias, recipient_sequence, thread_id, thread_sequence FROM messages WHERE sender_session_id=? AND idempotency_key=?')
          .get(OPERATOR_SESSION_ID, input.idempotencyKey) as
          | { message_id: string; correlation_id: string; recipient_session_id: string; recipient_alias: string; recipient_sequence: number; thread_id: string; thread_sequence: number }
          | undefined;
        if (dup) {
          const d = this.db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(dup.message_id) as { state: string } | undefined;
          return {
            messageId: dup.message_id, correlationId: dup.correlation_id, recipientSessionId: dup.recipient_session_id,
            recipientAlias: dup.recipient_alias, sequence: dup.recipient_sequence, state: d?.state ?? DeliveryState.QUEUED,
            deduplicated: true, threadId: dup.thread_id, threadSequence: dup.thread_sequence, authorType: OPERATOR_ACTOR_KIND,
          };
        }
      }

      const recipient = this.resolveRecipient(input.to);
      if (recipient.sessionId === OPERATOR_SESSION_ID) {
        throw new XBusError(XBusErrorCode.UNKNOWN_RECIPIENT, 'the operator cannot message itself');
      }
      // Recipient-expiry guard (symmetric with store.send): never queue for a tombstoned session.
      const exp = this.db.prepare('SELECT expired_at FROM sessions WHERE session_id=?').get(recipient.sessionId) as { expired_at: string | null } | undefined;
      if (exp?.expired_at) {
        throw new XBusError(XBusErrorCode.RECIPIENT_SESSION_EXPIRED, 'recipient session expired (no activity for 15 days); it must re-register', { recipient: recipient.alias });
      }

      const messageId = this.ids.next();
      const traceId = this.ids.next();

      // Thread resolution: continue an existing thread, or open a new one rooted at this message.
      let threadId: string;
      let correlationId: string;
      let parentMessageId: string | null;
      let causationId: string | null;
      if (input.threadId !== undefined) {
        const t = this.db.prepare('SELECT thread_id, root_message_id, state FROM threads WHERE thread_id=?').get(input.threadId) as { thread_id: string; root_message_id: string; state: string } | undefined;
        if (!t) throw new XBusError(XBusErrorCode.MESSAGE_NOT_FOUND, 'no such thread');
        if (t.state !== 'open') throw new XBusError(XBusErrorCode.ILLEGAL_STATE_TRANSITION, 'thread is closed');
        // The operator must be a participant of a thread it continues (it is added on open).
        threadId = t.thread_id;
        correlationId = threadId; // thread_id == root correlation_id (ADR 0017 D1)
        // parent = the explicit turn answered, else the latest turn in the thread.
        if (input.parentMessageId !== undefined) {
          const pm = this.db.prepare('SELECT message_id FROM messages WHERE message_id=? AND thread_id=?').get(input.parentMessageId, threadId) as { message_id: string } | undefined;
          if (!pm) throw new XBusError(XBusErrorCode.MESSAGE_NOT_FOUND, 'parentMessageId is not a turn in this thread');
          parentMessageId = pm.message_id;
        } else {
          const last = this.db.prepare('SELECT message_id FROM messages WHERE thread_id=? ORDER BY thread_sequence DESC LIMIT 1').get(threadId) as { message_id: string } | undefined;
          parentMessageId = last?.message_id ?? t.root_message_id;
        }
        causationId = parentMessageId;
      } else {
        threadId = messageId;      // new thread rooted here
        correlationId = messageId; // root: correlation == messageId (unchanged convention)
        parentMessageId = null;
        causationId = null;
      }

      this.ensureThread(threadId, input.threadId !== undefined ? (this.db.prepare('SELECT root_message_id FROM threads WHERE thread_id=?').get(threadId) as { root_message_id: string }).root_message_id : messageId, OPERATOR_SESSION_ID, OPERATOR_ACTOR_KIND, now);
      if (input.subject !== undefined && input.threadId === undefined) {
        this.db.prepare('UPDATE threads SET subject=? WHERE thread_id=? AND subject IS NULL').run(input.subject, threadId);
      }
      const threadSequence = this.allocThreadSequence(threadId);
      this.ensureParticipant(threadId, OPERATOR_SESSION_ID, OPERATOR_ACTOR_KIND, now);
      this.ensureParticipant(threadId, recipient.sessionId, 'claude', now);

      // Allocate the recipient sequence (per-recipient global ordering) in the same txn.
      const seqRow = this.db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(recipient.sessionId) as { next_sequence: number } | undefined;
      const sequence = seqRow ? seqRow.next_sequence : 1;
      this.db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(recipient.sessionId, sequence + 1);

      const ttlMs = input.ttlSeconds ? input.ttlSeconds * 1000 : undefined;
      const expiresAt = ttlMs ? new Date(this.clock.nowMs() + ttlMs).toISOString() : null;

      this.db
        .prepare(
          `INSERT INTO messages (message_id, protocol_version, sender_session_id, sender_alias, recipient_session_id, recipient_alias, kind, correlation_id, causation_id, parent_message_id, recipient_sequence, idempotency_key, body_text, body_hash, metadata_json, requires_ack, requires_reply, not_before, expires_at, created_at, trace_id, thread_id, thread_sequence, author_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          messageId, PROTOCOL_VERSION, OPERATOR_SESSION_ID, OPERATOR_ALIAS, recipient.sessionId, recipient.alias,
          input.kind, correlationId, causationId, parentMessageId, sequence, input.idempotencyKey ?? null, input.text, hashBody(input.text),
          input.metadata ? JSON.stringify(input.metadata) : null, input.requiresAck ? 1 : 0, input.requiresReply ? 1 : 0,
          null, expiresAt, now, traceId, threadId, threadSequence, OPERATOR_ACTOR_KIND,
        );
      this.touchThread(threadId, threadSequence, now);
      // The operator has "read" its own turn (so it never counts as unread to itself).
      this.db.prepare('UPDATE thread_participants SET last_read_thread_seq=MAX(last_read_thread_seq, ?) WHERE thread_id=? AND session_id=?').run(threadSequence, threadId, OPERATOR_SESSION_ID);

      this.db
        .prepare(`INSERT INTO deliveries (delivery_id, message_id, recipient_session_id, state, created_at, updated_at) VALUES (?,?,?, '${DeliveryState.QUEUED}', ?, ?)`)
        .run(this.ids.next(), messageId, recipient.sessionId, now, now);

      // Recipient meaningful-activity is NOT refreshed here (the operator sending TO a session
      // is not the session's own activity); delivery/ack will refresh it, matching store.send
      // which refreshes only the sender (and the operator never expires).
      this.audit('OPERATOR_MESSAGE_SENT', { sessionId: OPERATOR_SESSION_ID, messageId, traceId, recipient: recipient.alias, threadId, threadSequence });
      // Exactly one hash-chained ledger event in this transaction (ADR 0021 D7).
      this.ledger(input.threadId === undefined ? 'THREAD_OPENED' : 'OPERATOR_MESSAGE_SENT', OPERATOR_LEDGER_ACTOR, { threadId, messageId }, {
        recipient: recipient.alias, threadSequence, requiresAck: input.requiresAck ? 1 : 0, requiresReply: input.requiresReply ? 1 : 0, bodyHash: hashBody(input.text),
      });

      return {
        messageId, correlationId, recipientSessionId: recipient.sessionId, recipientAlias: recipient.alias,
        sequence, state: DeliveryState.QUEUED, deduplicated: false, threadId, threadSequence, authorType: OPERATOR_ACTOR_KIND,
      };
    });
  }

  /**
   * Mark a thread read UP TO a sequence for the operator participant (ADR 0021 D6). Advances
   * last_read_thread_seq (monotonic — never rewinds) and appends one THREAD_READ ledger
   * event. Idempotent; a no-op if already read past `upToSequence`. Returns the new cursor.
   */
  markThreadRead(threadId: string, upToSequence: number): { threadId: string; lastReadThreadSeq: number } {
    return this.db.transaction(() => {
      const now = this.clock.nowIso();
      const t = this.db.prepare('SELECT thread_id FROM threads WHERE thread_id=?').get(threadId) as { thread_id: string } | undefined;
      if (!t) throw new XBusError(XBusErrorCode.MESSAGE_NOT_FOUND, 'no such thread');
      this.ensureParticipant(threadId, OPERATOR_SESSION_ID, OPERATOR_ACTOR_KIND, now);
      const cur = this.db.prepare('SELECT last_read_thread_seq FROM thread_participants WHERE thread_id=? AND session_id=?').get(threadId, OPERATOR_SESSION_ID) as { last_read_thread_seq: number };
      const target = Math.max(cur.last_read_thread_seq, Math.max(0, Math.trunc(upToSequence)));
      if (target === cur.last_read_thread_seq) {
        return { threadId, lastReadThreadSeq: cur.last_read_thread_seq }; // already read that far — no ledger churn
      }
      this.db.prepare('UPDATE thread_participants SET last_read_thread_seq=? WHERE thread_id=? AND session_id=?').run(target, threadId, OPERATOR_SESSION_ID);
      this.ledger('THREAD_READ', OPERATOR_LEDGER_ACTOR, { threadId }, { lastReadThreadSeq: target });
      return { threadId, lastReadThreadSeq: target };
    });
  }
}
