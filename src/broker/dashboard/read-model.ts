/**
 * Dashboard READ MODEL (ADR 0020 Q2/Q5). Pure, synchronous reads over a
 * PHYSICALLY read-only SQLite handle (`openDatabase(..., { readOnly: true })`). This is
 * the ONLY DB access the dashboard has — there is no writer handle in the read path, so
 * it structurally cannot mutate state (I4). The label for each session is derived by a
 * pure decision function (deriveSessionLabel) so it is unit-testable in isolation.
 *
 * This module holds NO secrets and serves NO bodies — only ids, states, counts, hashes,
 * and the safe session-visibility columns. It is designed to run inside an off-loop
 * worker (read-worker.ts) so a pathological large scan executes off the broker event loop
 * and cannot stall delivery.
 */
import type { SqliteDriver } from '../../database/connection.js';
import { verifyLedger } from '../ledger.js';
import { OPERATOR_SESSION_ID } from '../operator.js';
import { BUILD_ID, SCHEMA_VERSION } from '../../protocol/handshake.js';
import { XBUS_VERSION } from '../../protocol/version.js';

/** The dashboard-visible label for a session, derived top-down, first-match-wins from the
 *  FOUR real fields (ADR 0020 Q2 decision table). */
export type SessionLabel =
  | 'expired'
  | 'unmanaged'
  | 'dormant'
  | 'active-disconnected'
  | 'active-ready'
  | 'active-starting';

export interface SessionLabelInputs {
  managementState: string;      // unmanaged | dormant | active
  connectionState: string;      // connected | disconnected  (sessions.state)
  readiness: string;            // initializing | ready_checkpoint | ready_live | degraded_* | disconnected
  expiredAt: string | null;     // tombstone (ADR 0012 D6)
}

/**
 * ADR 0020 Q2 decision table — evaluated TOP-DOWN, first match wins (so an `expired_at`
 * set row is caught before the active rows, and a legacy `active`+`expired_at` backfill
 * row lands on `expired`, not `active-*`). Pure + exhaustively unit-tested.
 */
export function deriveSessionLabel(i: SessionLabelInputs): { label: SessionLabel; routable: boolean } {
  if (i.expiredAt !== null) return { label: 'expired', routable: false };                    // row 1
  if (i.managementState === 'unmanaged') return { label: 'unmanaged', routable: false };      // row 2
  if (i.managementState === 'dormant') return { label: 'dormant', routable: false };          // row 3
  // management_state === 'active' below
  if (i.connectionState === 'disconnected') return { label: 'active-disconnected', routable: false }; // row 4 (queued, not injectable now)
  if (i.readiness === 'ready_checkpoint' || i.readiness === 'ready_live') return { label: 'active-ready', routable: true }; // row 5
  return { label: 'active-starting', routable: false };                                        // row 6 (initializing / degraded_*)
}

export interface DashboardSession {
  sessionId: string;
  name: string | null;
  sessionNameState: string;
  label: SessionLabel;
  routable: boolean;
  managementState: string;
  source: string | null;
  identifyConfidence: string;
  agentType: string | null;
  project: string;
  connection: string;   // sessions.state {connected,disconnected}
  readiness: string;    // readiness enum
  /** Beta.7: is this an XBus-INTERNAL session (CLI admin/installer shells, the operator
   *  principal) that the console hides by default behind the "Internal sessions" filter?
   *  Derived (no schema change) from the session id prefix / project slug — a cli-* admin
   *  session has id `cli-<pid>-<ts>` + project 'proj-cli'/'proj-install'/'proj-operator'. */
  internal: boolean;
  firstSeenAt: string | null;
  lastSeenSourceAt: string | null;
  /** Beta.10 (Train B): operator-lifecycle + control state surfaced so the console can render
   *  authoritative state after a mutation (the release gate: state must not contradict the broker
   *  after refresh/restart). ADDITIVE — the columns already exist (migrations v3 + v10); this only
   *  projects them. `receiveControl` LEFT-JOINs session_controls (absent row → 'active').
   *  `managed` is `managed_by_xbus`; `managedPid` is the recorded pid (NOT a liveness proof — the
   *  daemon's live in-process handle is the only kill-safe liveness signal, returned by stop_managed). */
  pinned: boolean;
  archived: boolean;
  archivedAt: string | null;
  receiveControl: string; // 'active' | 'paused' | 'do_not_disturb' | 'manual_checkpoint'
  claudeTitle: string | null; // Claude-native display title (ADR 0024) — NEVER a routable alias
  managed: boolean;
  managedPid: number | null;
  /** Beta.10 (Train B) inspector: the DURABLE logical identity this physical session belongs to
   *  (ADR 0027). For a session that has never been reclaimed this equals its own session_id. */
  logicalIdentityId: string | null;
  /** Count of physical Claude-session ids that have been REDIRECTED onto this canonical session
   *  (superseded twins in physical_session_map), PLUS the canonical itself. 1 = never reclaimed. */
  physicalInstances: number;
  /** Delivery-state breakdown for messages addressed TO this session (blocker #6). */
  delivery: { queued: number; delivered: number; acknowledged: number; replied: number; failed: number };
  /** legacy fields kept for existing consumers/tests. */
  queued: number;
  unacknowledged: number;
  /** Last message this session SENT (recipient + when + delivery state), or null. */
  lastSent: { to: string; at: string; state: string } | null;
  /** Last message this session RECEIVED (sender + when + delivery state), or null. */
  lastReceived: { from: string; at: string; state: string } | null;
  /** BETA.10 WS3 (#2): runtime instance history for the inspector (present on the DETAIL view
   *  only, not the roster list). Current + past component instances, newest-first, current flagged.
   *  Physical/epoch internals stay in diagnostics — this surfaces the operator-facing shape. */
  instances?: SessionInstance[];
}

/** BETA.10 WS3 (#2): a runtime instance (component) of a session, for the inspector history. */
export interface SessionInstance {
  instanceId: string;
  role: string;               // 'hook' | 'mcp' | 'admin' (component role)
  state: string;              // 'connected'|'disconnected' (normalized from live/closed/superseded)
  processId: number;
  connectedAt: string;
  disconnectedAt: string | null;
  lastSeenAt: string;
  current: boolean;           // the live instance of the session's current epoch
}


export interface LedgerPage {
  events: Array<{ seq: number; eventType: string; actor: string; subject: unknown; payload: unknown; createdAt: string; entryHash: string }>;
  nextBeforeSeq: number | null;
}

/** Beta.6 (ADR 0021): a thread as shown in the console list — ids/counts/labels, NO bodies. */
export interface DashboardThreadSummary {
  threadId: string;
  subject: string | null;
  state: string;                 // 'open' | 'closed'
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  lastThreadSequence: number;
  lastReadThreadSequence: number;
  unreadCount: number;           // derived: turns after the operator's cursor not sent by the operator
  peerSessionId: string | null;  // the session this thread is with
  peerName: string | null;
  turnCount: number;
  lastTurnState: string;         // mapped delivery state of the latest turn
}

/** A single ordered turn in a thread timeline (BODY included — the operator's own thread). */
export interface DashboardThreadTurn {
  messageId: string;
  threadSequence: number;
  kind: string;
  authorType: string;            // 'operator' | 'claude'
  senderName: string;
  senderSessionId: string;
  recipientName: string;
  recipientSessionId: string;
  correlationId: string;
  causationId: string | null;
  parentMessageId: string | null;
  text: string;
  requiresAck: boolean;
  requiresReply: boolean;
  createdAt: string;
  expiresAt: string | null;
  deliveryState: string;         // queued | delivered | acknowledged | replied | failed
  ackStatus: string | null;      // 'accepted' | 'rejected' | null
  ackAttempts: number;
  failureCategory: string | null;
  deliveredAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
}

/** One thread's full ordered timeline for the console. */
export interface DashboardThread extends Omit<DashboardThreadSummary, 'turnCount' | 'lastTurnState'> {
  rootMessageId: string;
  createdByActor: string;
  turns: DashboardThreadTurn[];
}

/**
 * Beta.7: is this an XBus-INTERNAL session (not a user-facing Claude Code session)? The
 * console hides these by default behind the "Internal sessions" filter. Internal = the
 * reserved operator principal, or a short-lived CLI/admin/installer shell (id `cli-<pid>-<ts>`
 * with a `proj-cli`/`proj-install`/`proj-operator` slug, or the `__xbus_operator__` slug).
 * Derived from stable id/slug shape — no schema column, so it needs no migration.
 */
export function isInternalSession(sessionId: string, projectId: string): boolean {
  if (sessionId === 'local-operator') return true;
  if (sessionId.startsWith('cli-') || sessionId.startsWith('installer-')) return true;
  const slug = projectId.toLowerCase();
  return slug === 'proj-cli' || slug === 'proj-install' || slug === 'proj-operator' || slug === '__xbus_operator__';
}

/** Decode the packed `session_controls.receiving` code into the receive-control mode string.
 *  Mirrors ControlsStore.getControl (controls.ts): 1/absent=active, 0=paused, 2=dnd, 3=manual.
 *  A NULL (no session_controls row via the LEFT JOIN) means the ControlsStore default 'active'. */
function receiveControlFromCode(code: number | null): string {
  switch (code) {
    case 0: return 'paused';
    case 2: return 'do_not_disturb';
    case 3: return 'manual_checkpoint';
    default: return 'active'; // 1 or NULL/unknown
  }
}

/** Map a raw delivery state to the console's five user-facing states (queued/delivered/
 *  acknowledged/replied/failed) — the same rollup the session read model uses. */
function mapDeliveryState(state: string): string {
  switch (state) {
    case 'queued': case 'retry_wait': case 'dispatching': return 'queued';
    case 'transport_written': return 'delivered';
    case 'accepted': return 'acknowledged';
    case 'completed': return 'replied';
    case 'dead_letter': case 'rejected': case 'expired': case 'cancelled': return 'failed';
    default: return state;
  }
}

export class DashboardReadModel {
  constructor(private readonly db: SqliteDriver) {}

  /** All sessions with their derived label + safe metadata (newest-first by first_seen). */
  sessions(): DashboardSession[] {
    const rows = this.db.prepare(
      `SELECT s.session_id AS sessionId, s.session_name AS name, s.session_name_state AS nameState,
              s.management_state AS mgmt, s.source_last AS source, s.identify_confidence AS conf,
              s.agent_type AS agentType, s.project_alias AS projectAlias, s.project_id AS projectId,
              s.state AS connState, s.readiness, s.expired_at AS expiredAt,
              s.first_seen_at AS firstSeenAt, s.last_seen_source_at AS lastSeenSourceAt,
              -- Beta.10 (Train B): operator-lifecycle + control projection (ADDITIVE; columns exist).
              s.pinned AS pinned, s.archived AS archived, s.archived_at AS archivedAt,
              s.claude_title AS claudeTitle, s.managed_by_xbus AS managed, s.managed_pid AS managedPid,
              s.logical_identity_id AS logicalIdentityId, c.receiving AS receiving
         FROM sessions s
         -- LEFT JOIN so a session with no explicit control row reads as 'active' (the ControlsStore default).
         LEFT JOIN session_controls c ON c.session_id = s.session_id
         -- Beta.8 (ADR 0027): a physical session id that has been REDIRECTED onto a canonical
         -- durable identity (name+inbox reclaimed by a new Claude session id) must not appear as
         -- a separate row — the console shows the ONE canonical session, never a phantom
         -- superseded twin. The canonical row itself is never a map KEY, so it is unaffected.
         WHERE s.session_id NOT IN (SELECT physical_session_id FROM physical_session_map)
         ORDER BY COALESCE(s.first_seen_at, s.created_at) DESC`,
    ).all() as Array<Record<string, unknown>>;

    // BOUNDED aggregates (blocker #6): a FIXED number of set-wide GROUP BY queries, NOT one
    // query per session (no N+1). Each is backed by an existing index:
    //  - delivery breakdown by (recipient, state)  → idx_deliveries_recipient (recipient, state)
    //  - last message SENT per sender / RECEIVED per recipient → idx_msg_recipient + a max-created
    //    correlated pick, computed once over the whole messages table and folded into maps.
    const deliveryByState = new Map<string, Record<string, number>>();
    for (const d of this.db.prepare(`SELECT recipient_session_id AS sid, state, COUNT(*) AS n FROM deliveries GROUP BY recipient_session_id, state`).all() as Array<{ sid: string; state: string; n: number }>) {
      const m = deliveryByState.get(d.sid) ?? {}; m[d.state] = d.n; deliveryByState.set(d.sid, m);
    }
    // Physical-instance count per canonical session (redirected twins), ONE GROUP BY (no N+1).
    // A canonical with no reclaims has no row here → its count is just itself (1, added below).
    const redirectCount = new Map<string, number>();
    for (const p of this.db.prepare(`SELECT canonical_session_id AS sid, COUNT(*) AS n FROM physical_session_map GROUP BY canonical_session_id`).all() as Array<{ sid: string; n: number }>) {
      redirectCount.set(p.sid, p.n);
    }
    // Last SENT per sender: the newest message row per sender_session_id, joined to its delivery
    // state. `NOT EXISTS a newer row for the same sender` picks exactly the latest (index-assisted).
    const lastSent = new Map<string, { to: string; at: string; state: string }>();
    for (const m of this.db.prepare(
      `SELECT m.sender_session_id AS sid, m.recipient_alias AS peer, m.created_at AS at, COALESCE(d.state,'queued') AS state
         FROM messages m LEFT JOIN deliveries d ON d.message_id = m.message_id
        WHERE NOT EXISTS (SELECT 1 FROM messages m2 WHERE m2.sender_session_id = m.sender_session_id AND (m2.created_at > m.created_at OR (m2.created_at = m.created_at AND m2.message_id > m.message_id)))`,
    ).all() as Array<{ sid: string; peer: string; at: string; state: string }>) {
      lastSent.set(m.sid, { to: m.peer, at: m.at, state: m.state });
    }
    // Last RECEIVED per recipient: newest message per recipient_session_id + its delivery state.
    const lastReceived = new Map<string, { from: string; at: string; state: string }>();
    for (const m of this.db.prepare(
      `SELECT m.recipient_session_id AS sid, m.sender_alias AS peer, m.created_at AS at, COALESCE(d.state,'queued') AS state
         FROM messages m LEFT JOIN deliveries d ON d.message_id = m.message_id
        WHERE NOT EXISTS (SELECT 1 FROM messages m2 WHERE m2.recipient_session_id = m.recipient_session_id AND (m2.created_at > m.created_at OR (m2.created_at = m.created_at AND m2.message_id > m.message_id)))`,
    ).all() as Array<{ sid: string; peer: string; at: string; state: string }>) {
      lastReceived.set(m.sid, { from: m.peer, at: m.at, state: m.state });
    }

    return rows.map((r) => {
      const sid = r.sessionId as string;
      const { label, routable } = deriveSessionLabel({
        managementState: (r.mgmt as string) ?? 'active',
        connectionState: (r.connState as string) ?? 'disconnected',
        readiness: (r.readiness as string) ?? 'disconnected',
        expiredAt: (r.expiredAt as string | null) ?? null,
      });
      const st = deliveryByState.get(sid) ?? {};
      // Map raw delivery states → the user-facing breakdown (queued/delivered/acked/replied/failed).
      const delivery = {
        queued: (st['queued'] ?? 0) + (st['retry_wait'] ?? 0),
        delivered: st['transport_written'] ?? 0,
        acknowledged: st['accepted'] ?? 0,
        replied: st['completed'] ?? 0,
        failed: (st['dead_letter'] ?? 0) + (st['rejected'] ?? 0) + (st['expired'] ?? 0),
      };
      return {
        sessionId: sid,
        name: (r.name as string | null) ?? null,
        sessionNameState: (r.nameState as string) ?? 'unnamed',
        label, routable,
        managementState: (r.mgmt as string) ?? 'active',
        source: (r.source as string | null) ?? null,
        identifyConfidence: (r.conf as string) ?? 'signal',
        agentType: (r.agentType as string | null) ?? null,
        project: (r.projectAlias as string) ?? (r.projectId as string) ?? 'unknown',
        connection: (r.connState as string) ?? 'disconnected',
        readiness: (r.readiness as string) ?? 'disconnected',
        internal: isInternalSession(sid, (r.projectId as string) ?? ''),
        firstSeenAt: (r.firstSeenAt as string | null) ?? null,
        lastSeenSourceAt: (r.lastSeenSourceAt as string | null) ?? null,
        pinned: (r.pinned as number) === 1,
        archived: (r.archived as number) === 1,
        archivedAt: (r.archivedAt as string | null) ?? null,
        receiveControl: receiveControlFromCode(r.receiving as number | null),
        claudeTitle: (r.claudeTitle as string | null) ?? null,
        managed: (r.managed as number) === 1,
        managedPid: (r.managedPid as number | null) ?? null,
        logicalIdentityId: (r.logicalIdentityId as string | null) ?? null,
        physicalInstances: 1 + (redirectCount.get(sid) ?? 0),
        delivery,
        queued: delivery.queued,
        unacknowledged: delivery.delivered,
        lastSent: lastSent.get(sid) ?? null,
        lastReceived: lastReceived.get(sid) ?? null,
      };
    });
  }

  /** One session's detail (or null). Same safe projection as sessions(). */
  session(sessionId: string): DashboardSession | null {
    const base = this.sessions().find((s) => s.sessionId === sessionId) ?? null;
    if (!base) return null;
    // BETA.10 WS3 (#2): attach the runtime instance history (DETAIL view only). newest-first;
    // `current` = a live component in the session's CURRENT active_epoch. state normalized to
    // connected/disconnected for the operator-facing shape (live→connected; closed/superseded→
    // disconnected). Physical/epoch internals are not surfaced here (diagnostics only).
    const activeEpoch = (this.db.prepare('SELECT active_epoch AS e FROM sessions WHERE session_id=?').get(sessionId) as { e: number } | undefined)?.e ?? null;
    const rows = this.db.prepare(
      `SELECT component_instance_id AS instanceId, role, state, process_id AS processId, epoch,
              connected_at AS connectedAt, disconnected_at AS disconnectedAt, last_seen_at AS lastSeenAt
         FROM component_instances WHERE session_id=? ORDER BY connected_at DESC`,
    ).all(sessionId) as Array<{ instanceId: string; role: string; state: string; processId: number; epoch: number; connectedAt: string; disconnectedAt: string | null; lastSeenAt: string }>;
    const instances: SessionInstance[] = rows.map((r) => ({
      instanceId: r.instanceId,
      role: r.role,
      state: r.state === 'live' ? 'connected' : 'disconnected',
      processId: r.processId,
      connectedAt: r.connectedAt,
      disconnectedAt: r.disconnectedAt,
      lastSeenAt: r.lastSeenAt,
      current: r.state === 'live' && activeEpoch !== null && r.epoch === activeEpoch,
    }));
    return { ...base, instances };
  }

  /**
   * A page of the audit ledger, newest-first, keyset-paginated by seq. `limit` is clamped
   * to [1, 500] so a hostile value cannot force an unbounded scan; `beforeSeq` (exclusive)
   * pages backward. Bodies are never present (the ledger stores ids/states/hashes only).
   */
  ledger(opts: { beforeSeq?: number; limit?: number } = {}): LedgerPage {
    // Clamp to [1, 500]. A non-numeric/NaN limit (e.g. `?limit=abc` → Number('abc')=NaN)
    // must fall back to the default 100, not propagate NaN through Math.min/max into the
    // bind — so guard NaN explicitly before clamping.
    const rawLimit = opts.limit;
    const wantLimit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 100;
    const limit = Math.min(Math.max(wantLimit, 1), 500);
    const before = typeof opts.beforeSeq === 'number' && Number.isSafeInteger(opts.beforeSeq) && opts.beforeSeq > 0 ? opts.beforeSeq : null;
    const rows = (before === null
      ? this.db.prepare(`SELECT seq, event_type AS eventType, actor, subject_json AS subjectJson, payload_json AS payloadJson, created_at AS createdAt, entry_hash AS entryHash FROM ledger_events ORDER BY seq DESC LIMIT ?`).all(limit)
      : this.db.prepare(`SELECT seq, event_type AS eventType, actor, subject_json AS subjectJson, payload_json AS payloadJson, created_at AS createdAt, entry_hash AS entryHash FROM ledger_events WHERE seq < ? ORDER BY seq DESC LIMIT ?`).all(before, limit)
    ) as Array<{ seq: number; eventType: string; actor: string; subjectJson: string; payloadJson: string; createdAt: string; entryHash: string }>;
    const events = rows.map((r) => ({
      seq: r.seq, eventType: r.eventType, actor: r.actor,
      subject: safeParse(r.subjectJson), payload: safeParse(r.payloadJson),
      createdAt: r.createdAt, entryHash: r.entryHash,
    }));
    const nextBeforeSeq = events.length === limit ? events[events.length - 1]!.seq : null;
    return { events, nextBeforeSeq };
  }

  /**
   * Beta.6 Phase 2 (ADR 0021): the operator's thread list, newest-activity first. A thread
   * is surfaced to the console when the operator is a participant (i.e. an operator-initiated
   * or operator-involved conversation). unreadCount is DERIVED from committed rows: turns with
   * thread_sequence > the operator's last_read_thread_seq that the operator did not itself send.
   * Bodies are NOT included here (list view) — only ids/counts/labels/peer. `limit` clamped.
   */
  threads(opts: { limit?: number } = {}): { threads: DashboardThreadSummary[] } {
    const rawLimit = opts.limit;
    const want = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 100;
    const limit = Math.min(Math.max(want, 1), 200);
    // Threads the operator participates in, with the operator's read cursor.
    const rows = this.db.prepare(
      `SELECT t.thread_id AS threadId, t.subject AS subject, t.state AS state, t.created_at AS createdAt,
              t.updated_at AS updatedAt, t.last_message_at AS lastMessageAt, t.last_thread_sequence AS lastSeq,
              p.last_read_thread_seq AS lastReadSeq
         FROM threads t
         JOIN thread_participants p ON p.thread_id = t.thread_id AND p.session_id = ?
        ORDER BY t.last_message_at DESC, t.thread_id DESC
        LIMIT ?`,
    ).all(OPERATOR_SESSION_ID, limit) as Array<{ threadId: string; subject: string | null; state: string; createdAt: string; updatedAt: string; lastMessageAt: string; lastSeq: number; lastReadSeq: number }>;

    return {
      threads: rows.map((r) => {
        // unread = turns after the operator's cursor NOT sent by the operator.
        const unread = (this.db.prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND thread_sequence > ? AND sender_session_id <> ?`,
        ).get(r.threadId, r.lastReadSeq, OPERATOR_SESSION_ID) as { n: number }).n;
        // The peer (the non-operator participant) — the session this thread is "with".
        const peer = this.db.prepare(
          `SELECT session_id AS sid FROM thread_participants WHERE thread_id=? AND session_id <> ? ORDER BY joined_at ASC LIMIT 1`,
        ).get(r.threadId, OPERATOR_SESSION_ID) as { sid: string } | undefined;
        const peerName = peer ? this.sessionDisplay(peer.sid) : null;
        // The latest turn's delivery state (for the list's at-a-glance status).
        const lastState = this.latestTurnState(r.threadId);
        return {
          threadId: r.threadId, subject: r.subject, state: r.state,
          createdAt: r.createdAt, updatedAt: r.updatedAt, lastMessageAt: r.lastMessageAt,
          lastThreadSequence: r.lastSeq, lastReadThreadSequence: r.lastReadSeq, unreadCount: unread,
          peerSessionId: peer?.sid ?? null, peerName, turnCount: r.lastSeq, lastTurnState: lastState,
        };
      }),
    };
  }

  /**
   * One thread's ordered timeline for the console. Includes each turn's BODY (the console
   * must render message text — a deliberate, ADR-0021-scoped exposure of the OPERATOR's own
   * threads, distinct from the body-free ledger/session projections) plus the full delivery
   * lifecycle (queued/delivered/acked/replied/failed) + receipts, so requests, ACKs, replies,
   * retries and failures render in one ordered timeline. Returns null if the thread is unknown
   * or the operator is not a participant (participant-access check). Turns are ordered by
   * thread_sequence (the single monotonic per-thread order). `limit` clamps the turn count.
   */
  thread(threadId: string, opts: { limit?: number } = {}): DashboardThread | null {
    if (typeof threadId !== 'string' || threadId.length === 0) return null;
    const t = this.db.prepare(
      `SELECT thread_id AS threadId, root_message_id AS rootMessageId, subject, state, created_by_actor AS createdByActor,
              created_at AS createdAt, updated_at AS updatedAt, last_message_at AS lastMessageAt, last_thread_sequence AS lastSeq
         FROM threads WHERE thread_id=?`,
    ).get(threadId) as { threadId: string; rootMessageId: string; subject: string | null; state: string; createdByActor: string; createdAt: string; updatedAt: string; lastMessageAt: string; lastSeq: number } | undefined;
    if (!t) return null;
    const opPart = this.db.prepare(`SELECT last_read_thread_seq AS lastReadSeq FROM thread_participants WHERE thread_id=? AND session_id=?`).get(threadId, OPERATOR_SESSION_ID) as { lastReadSeq: number } | undefined;
    if (!opPart) return null; // participant-access: the operator is not in this thread

    const rawLimit = opts.limit;
    const want = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 500;
    const limit = Math.min(Math.max(want, 1), 1000);
    const msgs = this.db.prepare(
      `SELECT m.message_id AS messageId, m.thread_sequence AS seq, m.kind, m.author_type AS authorType,
              m.sender_session_id AS senderSessionId, m.sender_alias AS senderAlias,
              m.recipient_session_id AS recipientSessionId, m.recipient_alias AS recipientAlias,
              m.correlation_id AS correlationId, m.causation_id AS causationId, m.parent_message_id AS parentMessageId,
              m.body_text AS text, m.requires_ack AS requiresAck, m.requires_reply AS requiresReply,
              m.created_at AS createdAt, m.expires_at AS expiresAt,
              d.state AS deliveryState, d.attempt_ack_timeout AS ackAttempts, d.failure_category AS failureCategory,
              d.transport_written_at AS deliveredAt, d.application_accepted_at AS acceptedAt, d.application_completed_at AS completedAt
         FROM messages m LEFT JOIN deliveries d ON d.message_id = m.message_id
        WHERE m.thread_id=?
        ORDER BY m.thread_sequence ASC LIMIT ?`,
    ).all(threadId, limit) as Array<Record<string, unknown>>;

    const turns: DashboardThreadTurn[] = msgs.map((m) => {
      const messageId = m.messageId as string;
      // Receipts (ack + reply outcome) recorded for this turn — surfaces the ACK explicitly.
      const ackReceipt = this.db.prepare(`SELECT status FROM receipts WHERE message_id=? AND receipt_type='ack' LIMIT 1`).get(messageId) as { status: string } | undefined;
      return {
        messageId, threadSequence: m.seq as number, kind: m.kind as string, authorType: m.authorType as string,
        senderName: this.sessionDisplay(m.senderSessionId as string), senderSessionId: m.senderSessionId as string,
        recipientName: this.sessionDisplay(m.recipientSessionId as string), recipientSessionId: m.recipientSessionId as string,
        correlationId: m.correlationId as string, causationId: (m.causationId as string) ?? null, parentMessageId: (m.parentMessageId as string) ?? null,
        text: m.text as string, requiresAck: (m.requiresAck as number) === 1, requiresReply: (m.requiresReply as number) === 1,
        createdAt: m.createdAt as string, expiresAt: (m.expiresAt as string) ?? null,
        deliveryState: mapDeliveryState((m.deliveryState as string) ?? 'queued'),
        ackStatus: ackReceipt?.status ?? null,
        ackAttempts: (m.ackAttempts as number) ?? 0, failureCategory: (m.failureCategory as string) ?? null,
        deliveredAt: (m.deliveredAt as string) ?? null, acceptedAt: (m.acceptedAt as string) ?? null, completedAt: (m.completedAt as string) ?? null,
      };
    });
    const peer = this.db.prepare(`SELECT session_id AS sid FROM thread_participants WHERE thread_id=? AND session_id <> ? ORDER BY joined_at ASC LIMIT 1`).get(threadId, OPERATOR_SESSION_ID) as { sid: string } | undefined;
    const unread = (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND thread_sequence > ? AND sender_session_id <> ?`).get(threadId, opPart.lastReadSeq, OPERATOR_SESSION_ID) as { n: number }).n;
    return {
      threadId: t.threadId, rootMessageId: t.rootMessageId, subject: t.subject, state: t.state, createdByActor: t.createdByActor,
      createdAt: t.createdAt, updatedAt: t.updatedAt, lastMessageAt: t.lastMessageAt,
      lastThreadSequence: t.lastSeq, lastReadThreadSequence: opPart.lastReadSeq, unreadCount: unread,
      peerSessionId: peer?.sid ?? null, peerName: peer ? this.sessionDisplay(peer.sid) : null,
      turns,
    };
  }

  /** Best-effort display name for a session id (active name → alias → short id → 'local-operator'). */
  private sessionDisplay(sessionId: string): string {
    if (sessionId === OPERATOR_SESSION_ID) return 'local-operator';
    const r = this.db.prepare(`SELECT session_name AS name, automatic_alias AS alias FROM sessions WHERE session_id=?`).get(sessionId) as { name: string | null; alias: string | null } | undefined;
    return r?.name ?? r?.alias ?? sessionId.slice(0, 8);
  }

  /** The latest turn's mapped delivery state in a thread (for the list summary). */
  private latestTurnState(threadId: string): string {
    const r = this.db.prepare(
      `SELECT COALESCE(d.state,'queued') AS state FROM messages m LEFT JOIN deliveries d ON d.message_id=m.message_id
        WHERE m.thread_id=? ORDER BY m.thread_sequence DESC LIMIT 1`,
    ).get(threadId) as { state: string } | undefined;
    return mapDeliveryState(r?.state ?? 'queued');
  }

  /**
   * Audit-ledger chain health (blocker #7). Runs verifyLedger over the read-only handle and
   * reports {ok, checked, firstBreak?}. `lastVerifiedAt` is the broker's most recent periodic/
   * startup verify (read from `ledger_verify_state`), so the dashboard shows a freshness stamp;
   * a broken historical chain is reported HONESTLY (ok:false + firstBreak) — never masked. This
   * is a read of already-committed rows, off the broker loop (worker), so it never blocks delivery.
   */
  auditStatus(): { ok: boolean; checked: number; firstBreakSeq: number | null; lastVerifiedAt: string | null } {
    const v = verifyLedger(this.db);
    // `lastVerifiedAt` = the broker's most recent recorded verify. The broker writes a
    // LEDGER_VERIFIED audit_events row on startup + each periodic verify (no schema bump —
    // reuses the existing audit_events table), so the read worker reads the newest one for the
    // freshness stamp. Absent (pre-first-verify) → null.
    let lastVerifiedAt: string | null;
    try {
      const row = this.db.prepare(`SELECT created_at AS at FROM audit_events WHERE event_type='LEDGER_VERIFIED' ORDER BY created_at DESC LIMIT 1`).get() as { at: string } | undefined;
      lastVerifiedAt = row?.at ?? null;
    } catch { lastVerifiedAt = null; } // table absent (older DB / pre-first-verify) → null
    return { ok: v.ok, checked: v.checked, firstBreakSeq: v.firstBreak?.seq ?? null, lastVerifiedAt };
  }

  /**
   * BETA.10 WS3 (#5) — broker/build/runtime/ledger health projection for the dashboard health panel.
   * Shape matches the dashboard's locked consumption contract: { build, runtime, ledger, readWorker,
   * capabilities }. The `ledger` block REUSES auditStatus() (no duplicate verifyLedger pass). `build`
   * comes from the version constants; `runtime` from process (uptime/pid/node). `capabilities` is an
   * explicit allowlist so the dashboard's probe lights the s10-neutral features (#1 redeliver, #2
   * instances) deterministically rather than inferring. Read-only, off the broker loop.
   */
  health(): {
    build: { version: string; buildId: string; schemaVersion: number };
    runtime: { uptimeMs: number; pid: number; nodeVersion: string };
    ledger: { ok: boolean; checked: number; firstBreakSeq: number | null; lastVerifiedAt: string | null };
    readWorker: { inFlight: number; overloaded: boolean };
    capabilities: string[];
  } {
    return {
      build: { version: XBUS_VERSION, buildId: BUILD_ID, schemaVersion: SCHEMA_VERSION },
      runtime: { uptimeMs: Math.round(process.uptime() * 1000), pid: process.pid, nodeVersion: process.version },
      ledger: this.auditStatus(),
      // The read worker's own depth isn't tracked in this projection layer (the worker wraps this
      // call); report a stable not-overloaded baseline. A future worker-instrumented value can
      // replace this without a shape change.
      readWorker: { inFlight: 0, overloaded: false },
      // Integration (Package D): 'remove_safe' advertises that this broker build has the KNOWN-3
      // fix — operatorRemoveRecord atomically GCs physical_session_map + deletes name_ownership +
      // terminalizes deliveries to recipient_removed + cleans collection_members (WS1 R1 162d44a).
      // The dashboard gates its remove_record control on this capability, so remove only lights on
      // a broker that supports the safe teardown (never the pre-KNOWN-3 corrupting primitive).
      capabilities: ['redeliver', 'instances', 'remove_safe'],
    };
  }

  /**
   * BETA.10 WS3 — the workspace Collections read (dashboard contract), off-loop read-only. Mirrors
   * BrokerStore.readCollections but on the read-worker's read-only handle. Ordered by sort_order.
   */
  collections(): { version: number; collections: Array<{ id: string; name: string; sortOrder: number; state: string }>; members: Record<string, string[]> } {
    let cols: Array<{ id: string; name: string; sortOrder: number; state: string }> = [];
    let memberRows: Array<{ cid: string; agent: string }> = [];
    try {
      cols = this.db.prepare(`SELECT collection_id AS id, name, sort_order AS sortOrder, state FROM collections WHERE workspace_id='local' ORDER BY sort_order ASC, normalized_name ASC`).all() as typeof cols;
      memberRows = this.db.prepare(`SELECT collection_id AS cid, logical_agent_id AS agent FROM collection_members ORDER BY sort_order ASC`).all() as typeof memberRows;
    } catch {
      // s10 DB (collections tables absent) → fail-closed empty, never a partial/crash. The dashboard's
      // capability probe treats this as "collections unavailable" and keeps localStorage.
      return { version: 0, collections: [], members: {} };
    }
    const members: Record<string, string[]> = {};
    for (const r of memberRows) { (members[r.agent] ??= []).push(r.cid); }
    return { version: cols.length + memberRows.length + 1, collections: cols, members };
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
