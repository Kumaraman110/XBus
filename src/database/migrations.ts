/**
 * Transactional, checksum-verified migrations. Each migration is applied inside
 * a transaction and recorded with a checksum; a checksum mismatch on a
 * previously-applied migration aborts startup (tamper / version drift).
 *
 * For the vertical slice this carries the minimum schema for the A→B→ack→reply
 * flow plus the identity/fencing/sequence tables the design requires.
 */
import { createHash } from 'node:crypto';
import type { SqliteDriver } from './connection.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE fencing_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
      INSERT INTO fencing_counter (id, value) VALUES (1, 0);

      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        active_instance_id TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        high_water_generation INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER,
        bound_connection_id TEXT,
        automatic_alias TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_alias TEXT,
        cwd TEXT NOT NULL,
        repository_root TEXT,
        repository_remote_hash TEXT,
        claude_code_version TEXT,
        xbus_version TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        receive_mode TEXT NOT NULL DEFAULT 'disconnected',
        state TEXT NOT NULL,
        lease_expires_at TEXT,
        last_checkpoint_at TEXT,
        connected_at TEXT,
        disconnected_at TEXT,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE session_instances (
        instance_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL,
        process_id INTEGER NOT NULL,
        broker_instance_id TEXT NOT NULL,
        connection_id TEXT,
        read_ceiling_seq INTEGER,
        connected_at TEXT NOT NULL,
        disconnected_at TEXT,
        last_seen_at TEXT NOT NULL,
        state TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX idx_instances_session ON session_instances(session_id, generation);

      CREATE TABLE aliases (
        alias_id TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        alias_ci TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT NOT NULL,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );
      CREATE UNIQUE INDEX ux_alias_global ON aliases(alias_ci) WHERE scope='global' AND active=1;
      CREATE UNIQUE INDEX ux_alias_project ON aliases(project_id, alias_ci) WHERE scope='project' AND active=1;

      CREATE TABLE recipient_sequences (
        recipient_session_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL,
        FOREIGN KEY(recipient_session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        protocol_version INTEGER NOT NULL,
        sender_session_id TEXT NOT NULL,
        sender_alias TEXT NOT NULL,
        recipient_session_id TEXT NOT NULL,
        recipient_alias TEXT NOT NULL,
        kind TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        parent_message_id TEXT,
        recipient_sequence INTEGER NOT NULL,
        idempotency_key TEXT,
        body_text TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        metadata_json TEXT,
        requires_ack INTEGER NOT NULL,
        requires_reply INTEGER NOT NULL,
        not_before TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        trace_id TEXT NOT NULL
      );
      CREATE UNIQUE INDEX ux_idem ON messages(sender_session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX ux_recipseq ON messages(recipient_session_id, recipient_sequence);
      CREATE INDEX idx_msg_recipient ON messages(recipient_session_id);
      CREATE INDEX idx_msg_correlation ON messages(correlation_id);

      CREATE TABLE deliveries (
        delivery_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        recipient_session_id TEXT NOT NULL,
        target_instance_id TEXT,
        target_generation INTEGER,
        fencing_token INTEGER,
        delivery_attempt INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        rejected_reason TEXT,
        lease_acquired_at TEXT,
        lease_expires_at TEXT,
        transport_written_at TEXT,
        application_accepted_at TEXT,
        application_completed_at TEXT,
        next_attempt_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(message_id)
      );
      CREATE INDEX idx_deliveries_state ON deliveries(state, next_attempt_at);
      CREATE INDEX idx_deliveries_message ON deliveries(message_id);
      CREATE INDEX idx_deliveries_recipient ON deliveries(recipient_session_id, state);

      CREATE TABLE receipts (
        receipt_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        receiver_session_id TEXT NOT NULL,
        receiver_instance_id TEXT NOT NULL,
        receiver_generation INTEGER NOT NULL,
        receipt_type TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        body_hash TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(message_id, receiver_session_id, receipt_type),
        FOREIGN KEY(message_id) REFERENCES messages(message_id)
      );

      CREATE TABLE transport_write_log (
        write_id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        recipient_instance_id TEXT,
        attempt INTEGER NOT NULL,
        bytes_written INTEGER NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX idx_write_log_delivery ON transport_write_log(delivery_id, attempt);

      CREATE TABLE audit_events (
        audit_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_session_id TEXT,
        actor_instance_id TEXT,
        message_id TEXT,
        trace_id TEXT,
        safe_metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_ts ON audit_events(created_at);
      CREATE INDEX idx_audit_message ON audit_events(message_id);
    `,
  },
  {
    version: 2,
    name: 'component_epoch_identity',
    sql: `
      -- ADR 0003: explicit LogicalSession / SessionEpoch / ComponentInstance.
      CREATE TABLE session_epochs (
        session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        epoch_token_hash TEXT NOT NULL,
        started_at TEXT NOT NULL,
        superseded_at TEXT,
        supersede_reason TEXT,
        PRIMARY KEY (session_id, epoch)
      );

      CREATE TABLE component_instances (
        component_instance_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        role TEXT NOT NULL,
        process_id INTEGER NOT NULL,
        connection_id TEXT,
        build_id TEXT,
        capabilities_json TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        disconnected_at TEXT,
        last_seen_at TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE INDEX idx_components_session ON component_instances(session_id, epoch, role);
      CREATE INDEX idx_components_conn ON component_instances(connection_id);

      -- One-time receipt capability per context injection (ADR 0003 §3).
      CREATE TABLE context_injections (
        injection_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        recipient_session_id TEXT NOT NULL,
        recipient_epoch INTEGER NOT NULL,
        checkpoint_id TEXT NOT NULL,
        injected_by_component_id TEXT NOT NULL,
        receipt_capability_hash TEXT NOT NULL,
        injected_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_op TEXT,
        FOREIGN KEY(message_id) REFERENCES messages(message_id)
      );
      CREATE INDEX idx_injections_message ON context_injections(message_id);
      CREATE UNIQUE INDEX ux_injection_cap ON context_injections(receipt_capability_hash);
      -- replay guard: at most one injection row per (message, checkpoint)
      CREATE UNIQUE INDEX ux_injection_checkpoint ON context_injections(message_id, checkpoint_id);

      -- active epoch on sessions (reframes 'generation').
      ALTER TABLE sessions ADD COLUMN active_epoch INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    name: 'scheduling_controls',
    sql: `
      -- ADR 0005: people-facing receipt controls.
      CREATE TABLE session_controls (
        session_id TEXT PRIMARY KEY,
        receiving INTEGER NOT NULL DEFAULT 1,
        paused_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE blocked_peers (
        id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        blocked_alias_ci TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(owner_session_id, blocked_alias_ci)
      );
      CREATE INDEX idx_blocked_owner ON blocked_peers(owner_session_id);
    `,
  },
  {
    version: 4,
    name: 'injection_ledger_uniqueness',
    sql: `
      -- Reliability contract §6: the duplicate boundary is CONTEXT INJECTION, not
      -- a DB row. One effective injection per (message, recipient_epoch) unless an
      -- explicit redelivery policy bumps logical_injection_number.
      ALTER TABLE context_injections ADD COLUMN logical_injection_number INTEGER NOT NULL DEFAULT 1;
      CREATE UNIQUE INDEX ux_injection_logical ON context_injections(message_id, recipient_epoch, logical_injection_number);
      -- Per-category attempt counters (transport / context-injection / ack-timeout / reply-delivery).
      ALTER TABLE deliveries ADD COLUMN attempt_transport INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE deliveries ADD COLUMN attempt_injection INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE deliveries ADD COLUMN attempt_ack_timeout INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE deliveries ADD COLUMN attempt_reply INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE deliveries ADD COLUMN failure_category TEXT;
      ALTER TABLE deliveries ADD COLUMN paused_accum_ms INTEGER NOT NULL DEFAULT 0;
      -- Delivery leases (reliability contract §8): at most one eligible injection
      -- lease per delivery at a time.
      CREATE TABLE delivery_leases (
        lease_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        recipient_session_id TEXT NOT NULL,
        recipient_epoch INTEGER NOT NULL,
        component_role TEXT NOT NULL,
        component_instance_id TEXT NOT NULL,
        lease_generation INTEGER NOT NULL,
        operation TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        state TEXT NOT NULL DEFAULT 'held'
      );
      CREATE UNIQUE INDEX ux_lease_active ON delivery_leases(delivery_id) WHERE state='held';
      CREATE INDEX idx_lease_expiry ON delivery_leases(state, expires_at);
    `,
  },
  {
    version: 5,
    name: 'session_readiness',
    sql: `
      -- §2: explicit session readiness, SEPARATE from connection state + receive
      -- mode. A registered-but-initializing session must not be injected a request
      -- it cannot yet acknowledge. Default 'initializing' until an explicit signal.
      ALTER TABLE sessions ADD COLUMN readiness TEXT NOT NULL DEFAULT 'initializing';
      ALTER TABLE sessions ADD COLUMN readiness_updated_at TEXT;
    `,
  },
  {
    version: 6,
    name: 'named_sessions_and_activity_retention',
    sql: `
      -- ADR 0012 (beta.4): required human-readable session names + 15-day
      -- meaningful-activity retention. All ADDITIVE; legacy rows default to a
      -- routable 'unnamed' name state with NULL name columns. The existing
      -- (unused) sessions.expires_at column is REUSED as the 15-day expiry
      -- deadline — deliberately NOT renamed, to avoid the SQLite RENAME COLUMN
      -- portability risk (it is null in every existing row).
      --
      -- This migration moves SCHEMA_VERSION 5 -> 6, so the wire compatibility
      -- tuple becomes xbus-p1-stp1-s6. That bump is intentional and fail-closed:
      -- a beta.3 client (schema 5) meeting a v6-migrated broker is rejected
      -- 'upgrade_component' rather than silently writing v6 state (ADR 0012 §3).

      -- Name lifecycle: ORTHOGONAL to connection 'state' and 'readiness'.
      --   'unnamed'  legacy / not-yet-named (routable by automatic_alias)
      --   'pending'  name requested but unusable/ambiguous; UNROUTABLE until chosen
      --   'active'   a valid unique name is held; discoverable + routable by name
      --   'retired'  name released (rename / expiry); name returns to the pool
      ALTER TABLE sessions ADD COLUMN session_name TEXT;
      ALTER TABLE sessions ADD COLUMN normalized_session_name TEXT;
      ALTER TABLE sessions ADD COLUMN session_name_state TEXT NOT NULL DEFAULT 'unnamed';
      ALTER TABLE sessions ADD COLUMN pending_name_expires_at TEXT;

      -- 15-day meaningful-activity retention (expires_at already exists, reused).
      ALTER TABLE sessions ADD COLUMN last_meaningful_activity_at TEXT;
      ALTER TABLE sessions ADD COLUMN expired_at TEXT;
      ALTER TABLE sessions ADD COLUMN expiration_reason TEXT;

      -- Captured-at-registration diagnostic metadata (NOT trust evidence — the
      -- broker-owned-evidence model in PR #4 stays schema-distinct from these).
      ALTER TABLE sessions ADD COLUMN agent_type TEXT;

      -- Active-name uniqueness: case-insensitive, global within this broker
      -- (one broker == one OS user == one dataDir). Reserve-on-claim — a name is
      -- locked while 'active' OR 'pending', so two simultaneous sessions cannot
      -- both claim it; 'unnamed'/'retired' rows (NULL normalized name) are
      -- excluded so they never collide. SQLite serializes this inside the
      -- register transaction, mirroring the proven aliases index.
      CREATE UNIQUE INDEX ux_session_name_active
        ON sessions(normalized_session_name)
        WHERE normalized_session_name IS NOT NULL AND session_name_state IN ('active','pending');

      -- Expiry-sweep scan support: find due sessions cheaply.
      CREATE INDEX idx_sessions_expiry ON sessions(session_name_state, expires_at);

      -- Backfill the retention clock for EXISTING (beta.3-upgraded) sessions so the
      -- 15-day inactivity policy applies to them from upgrade time too — otherwise a
      -- migrated session that never re-registers would keep last_meaningful_activity_at
      -- NULL forever and never expire (the exact stale-install population retention is
      -- meant to cover). Anchor on the most recent known activity (last_seen_at, else
      -- created_at); expires_at = that + 15 days.
      --
      -- CRITICAL: the reaper compares expires_at to the clock STRING-WISE, so the
      -- backfilled value MUST be in the exact JS toISOString() format
      -- (YYYY-MM-DDTHH:MM:SS.sssZ). SQLite's datetime() drops the 'T'/'Z'/millis and
      -- would mis-sort; strftime('%Y-%m-%dT%H:%M:%fZ', ...) reproduces it exactly.
      UPDATE sessions
        SET last_meaningful_activity_at = COALESCE(last_seen_at, created_at),
            expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(last_seen_at, created_at), '+15 days')
        WHERE last_meaningful_activity_at IS NULL;
    `,
  },
  {
    version: 7,
    name: 'control_plane_session_visibility_and_audit_ledger',
    sql: `
      -- ADR 0013/0016/0020 (beta.5 Phase 1): control-plane session visibility +
      -- append-only hash-chained audit ledger. All ADDITIVE. Moves SCHEMA_VERSION
      -- 6 -> 7, so the wire tuple becomes xbus-p1-stp1-s7 (protocol + STP frozen at
      -- 1). Fail-closed: an s6 (beta.4.1) component meeting a v7 broker is rejected
      -- 'upgrade_component' at the handshake (checkCompatibility); beta.5 is a
      -- controlled whole-install upgrade (ADR 0019), NOT mixed-version operation.

      -- Session VISIBILITY columns (ADR 0020 Q1/Q2). management_state is orthogonal
      -- to the existing connection 'state' {connected,disconnected} and the
      -- 'readiness' enum:
      --   'active'    XBus manages it this broker lifetime (learned via SessionStart)
      --   'dormant'   imported from transcript listing (prior run; not live)
      --   'unmanaged' aggregate-only sentinel (see ADR 0013 D6; not per-session)
      -- Existing rows were live pre-migration -> default 'active' / 'signal'.
      ALTER TABLE sessions ADD COLUMN management_state TEXT NOT NULL DEFAULT 'active';
      -- how the row was last learned: startup|resume|clear|compact|fork|import
      ALTER TABLE sessions ADD COLUMN source_last TEXT;
      -- identification confidence: signal (SessionStart) | listing_only (import) | unidentified
      ALTER TABLE sessions ADD COLUMN identify_confidence TEXT NOT NULL DEFAULT 'signal';
      -- diagnostic-only parent linkage (normally NULL; no documented fork field yet)
      ALTER TABLE sessions ADD COLUMN forked_from TEXT;
      -- documented SessionStart input (path to the session transcript .jsonl)
      ALTER TABLE sessions ADD COLUMN transcript_path TEXT;
      ALTER TABLE sessions ADD COLUMN first_seen_at TEXT;
      ALTER TABLE sessions ADD COLUMN last_seen_source_at TEXT;

      CREATE INDEX idx_sessions_management ON sessions(management_state);

      -- Append-only, hash-chained AUDIT LEDGER (ADR 0016/0020 Q4). This is an audit
      -- PROJECTION written in the SAME transaction as each state mutation (ADR 0020
      -- Q3) — NOT the source of truth for routing state. Bodies/secrets are never
      -- stored here (ids/states/hashes only).
      CREATE TABLE ledger_events (
        event_id     TEXT PRIMARY KEY,          -- UUIDv7
        seq          INTEGER NOT NULL UNIQUE,    -- dense monotonic, gap-free per ledger
        event_type   TEXT NOT NULL,
        actor        TEXT NOT NULL,              -- session id | 'operator' | 'broker' | 'installer'
        subject_json TEXT NOT NULL,              -- {sessionId?,threadId?,messageId?} ids only
        payload_json TEXT NOT NULL,              -- SAFE metadata: states/counts/hashes, NO bodies/secrets
        created_at   TEXT NOT NULL,              -- UTC ISO-8601
        prev_hash    TEXT NOT NULL,              -- entry_hash of seq-1 (genesis = 64 zeros)
        entry_hash   TEXT NOT NULL               -- sha256(canonical(fields ‖ prev_hash))
      );
      CREATE UNIQUE INDEX ux_ledger_seq ON ledger_events(seq);
      -- append-only enforcement: reject UPDATE/DELETE (the vacuum path drops/recreates
      -- ONLY the delete trigger inside its own transaction — ADR 0020 Q4).
      CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_events
        BEGIN SELECT RAISE(ABORT, 'ledger_events is append-only'); END;
      CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_events
        BEGIN SELECT RAISE(ABORT, 'ledger_events is append-only'); END;

      -- Compaction anchors (trust roots for a pruned prefix) — ALSO append-only.
      CREATE TABLE ledger_anchors (
        anchor_seq   INTEGER PRIMARY KEY,        -- seq of the anchored event
        anchor_hash  TEXT NOT NULL,              -- entry_hash at anchor_seq
        created_at   TEXT NOT NULL,
        reason       TEXT NOT NULL               -- 'vacuum' | 'periodic'
      );
      CREATE TRIGGER anchors_no_update BEFORE UPDATE ON ledger_anchors
        BEGIN SELECT RAISE(ABORT, 'ledger_anchors is append-only'); END;
      CREATE TRIGGER anchors_no_delete BEFORE DELETE ON ledger_anchors
        BEGIN SELECT RAISE(ABORT, 'ledger_anchors is append-only'); END;
    `,
  },
  {
    version: 8,
    name: 'threaded_messaging_and_operator',
    sql: `
      -- ADR 0017 (data model) + ADR 0021 (operator identity + console): beta.6 Phase 2
      -- real multi-turn threaded messaging + a local-operator communication console.
      -- ALL ADDITIVE (CREATE TABLE / ALTER ADD COLUMN nullable-or-default / CREATE INDEX /
      -- backfill of existing rows) so a live beta.5 schema-7 DB migrates IN PLACE and
      -- preserves every row. Moves SCHEMA_VERSION 7 -> 8, so the wire tuple becomes
      -- xbus-p1-stp1-s8 (protocol + STP frozen at 1). Fail-closed: an s7 (beta.5.1)
      -- component meeting a v8 broker is rejected 'upgrade_component' at the handshake
      -- (checkCompatibility); beta.6 is a controlled whole-install upgrade (ADR 0019),
      -- NOT mixed-version operation. SQLite cannot ALTER-add an FK or a NOT-NULL-without-
      -- default column to a populated table, so thread_id/thread_sequence are nullable and
      -- author_type carries a DEFAULT; FKs are declared only on the brand-new tables.

      -- A THREAD is a first-class ordered conversation (ADR 0017 D1). thread_id equals the
      -- root turn's message_id (== its correlation_id), so beta.5 correlation tooling still
      -- groups a thread's turns. state: 'open' (accepts turns) | 'closed' (archived).
      CREATE TABLE threads (
        thread_id            TEXT PRIMARY KEY,        -- == root message_id == correlation_id
        root_message_id      TEXT NOT NULL,           -- the opening turn
        subject              TEXT,                    -- optional operator-set subject (untrusted text)
        created_by_actor     TEXT NOT NULL,           -- 'local-operator' | a session id
        state                TEXT NOT NULL DEFAULT 'open',
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        last_message_at      TEXT NOT NULL,
        last_thread_sequence INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_threads_updated ON threads(updated_at);

      -- Extensible N-party participant join-table (ADR 0017 locked decision) — two-party
      -- behavior now, N-party is a data-only extension later with no schema rewrite. Per
      -- (thread, participant): read cursor + membership. session_id is 'local-operator' for
      -- the operator participant, else a real session_id. actor_kind mirrors messages.author_type.
      CREATE TABLE thread_participants (
        participant_id       TEXT PRIMARY KEY,
        thread_id            TEXT NOT NULL,
        session_id           TEXT NOT NULL,           -- 'local-operator' | real session id
        actor_kind           TEXT NOT NULL,           -- 'operator' | 'claude'
        participant_role     TEXT NOT NULL DEFAULT 'member',
        joined_at            TEXT NOT NULL,
        left_at              TEXT,
        last_read_thread_seq INTEGER NOT NULL DEFAULT 0,
        muted                INTEGER NOT NULL DEFAULT 0,
        UNIQUE(thread_id, session_id),
        FOREIGN KEY(thread_id) REFERENCES threads(thread_id)
      );
      CREATE INDEX idx_participants_session ON thread_participants(session_id);

      -- Per-thread monotonic sequence allocator (ADR 0017 D4 / ADR 0021 D5). recipient_sequence
      -- is per-RECIPIENT, so a thread that spans op->session AND session->op draws from two
      -- recipient streams and gives no single monotonic order — this does. Allocated inside the
      -- send/reply transaction with INSERT OR REPLACE, mirroring recipient_sequences.
      CREATE TABLE thread_sequences (
        thread_id    TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(thread_id)
      );

      -- Thread linkage + attribution on messages. thread_id/thread_sequence are nullable
      -- (ALTER on a populated table); author_type defaults 'claude' for every legacy row.
      ALTER TABLE messages ADD COLUMN thread_id TEXT;
      ALTER TABLE messages ADD COLUMN thread_sequence INTEGER;
      ALTER TABLE messages ADD COLUMN author_type TEXT NOT NULL DEFAULT 'claude';
      CREATE INDEX idx_messages_thread ON messages(thread_id, thread_sequence);

      -- BACKFILL: make existing conversations coherent degenerate threads (ADR 0017 D2).
      -- correlation_id is already the thread-root key (a request + its replies share it),
      -- so every legacy message adopts thread_id = correlation_id.
      UPDATE messages SET thread_id = correlation_id WHERE thread_id IS NULL;

      -- Seed one threads row per distinct correlation group. The root turn is the earliest
      -- message in the group (by created_at, then message_id to break ties deterministically);
      -- created_by_actor is that root's sender (legacy roots are all Claude sessions — the
      -- operator did not exist pre-v8). last_message_at is the group's latest created_at.
      INSERT INTO threads (thread_id, root_message_id, subject, created_by_actor, state, created_at, updated_at, last_message_at, last_thread_sequence)
        SELECT g.thread_id,
               (SELECT m2.message_id FROM messages m2 WHERE m2.thread_id = g.thread_id ORDER BY m2.created_at ASC, m2.message_id ASC LIMIT 1),
               NULL,
               (SELECT m3.sender_session_id FROM messages m3 WHERE m3.thread_id = g.thread_id ORDER BY m3.created_at ASC, m3.message_id ASC LIMIT 1),
               'open',
               g.min_created, g.max_created, g.max_created, g.cnt
          FROM (SELECT thread_id, MIN(created_at) AS min_created, MAX(created_at) AS max_created, COUNT(*) AS cnt
                  FROM messages WHERE thread_id IS NOT NULL GROUP BY thread_id) g;

      -- Assign a per-thread sequence to legacy messages in (created_at, message_id) order.
      -- SQLite window functions (ROW_NUMBER) are available on the node:sqlite build (>=22.13).
      UPDATE messages
         SET thread_sequence = (
           SELECT rn FROM (
             SELECT message_id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at ASC, message_id ASC) AS rn
               FROM messages WHERE thread_id IS NOT NULL
           ) ranked WHERE ranked.message_id = messages.message_id)
       WHERE thread_id IS NOT NULL;

      -- Seed thread_sequences.next_sequence to one past the highest assigned sequence per thread.
      INSERT INTO thread_sequences (thread_id, next_sequence)
        SELECT thread_id, COALESCE(MAX(thread_sequence), 0) + 1
          FROM messages WHERE thread_id IS NOT NULL GROUP BY thread_id;

      -- Seed participants from the sender/recipient of each legacy thread's messages. Every
      -- distinct (thread, session) that appears as a sender or recipient becomes a 'claude'
      -- participant (the operator is provisioned at runtime, ADR 0021, not in this migration).
      INSERT OR IGNORE INTO thread_participants (participant_id, thread_id, session_id, actor_kind, participant_role, joined_at, last_read_thread_seq, muted)
        SELECT lower(hex(randomblob(16))), t.thread_id, t.session_id, 'claude', 'member', th.created_at, 0, 0
          FROM (
            SELECT DISTINCT thread_id, sender_session_id AS session_id FROM messages WHERE thread_id IS NOT NULL
            UNION
            SELECT DISTINCT thread_id, recipient_session_id AS session_id FROM messages WHERE thread_id IS NOT NULL
          ) t
          JOIN threads th ON th.thread_id = t.thread_id;
    `,
  },
  {
    version: 9,
    name: 'session_titles_lifecycle_and_scheduling',
    sql: `
      -- ADR 0024 (title sync + session controls) + ADR 0025 (idle wake + scheduling): beta.7
      -- Phase 3. ALL ADDITIVE. Moves SCHEMA_VERSION 8 -> 9, so the wire tuple becomes
      -- xbus-p1-stp1-s9 (protocol + STP frozen at 1). Fail-closed: an s8 (beta.6) component
      -- meeting a v9 broker is rejected 'upgrade_component' at the handshake (checkCompatibility);
      -- beta.7 is a controlled whole-install upgrade (ADR 0019). Every ALTER on the POPULATED
      -- sessions table is nullable-or-NOT-NULL-DEFAULT (SQLite cannot ALTER-add an FK or a bare
      -- NOT NULL to a populated table); FKs appear ONLY on the two brand-new (empty-at-create)
      -- tables. No backfill needed — existing sessions get DEFAULT 0 flags + NULL new columns.

      -- ===== Area 3a: the Claude Code NATIVE display title (ADR 0024) =====
      -- A deliberately INERT FOURTH identity pool, DISTINCT from the xbus session_name /
      -- normalized_session_name / aliases pools. It is NEVER normalized, NEVER unique-indexed,
      -- NEVER reserved, and NEVER read by resolveRecipient/aliasForSession — it is untrusted
      -- DISPLAY text captured ONLY from Claude Code's documented SessionStart 'session_title'
      -- stdin field (or a SessionStart hookSpecificOutput.sessionTitle XBus emits). Storing it
      -- separately from the xbus alias is what lets the console show both without ever CLAIMING
      -- the Claude title changed when only the xbus alias did (ADR 0024).
      ALTER TABLE sessions ADD COLUMN claude_title TEXT;                          -- untrusted display text, nullable
      ALTER TABLE sessions ADD COLUMN claude_title_source TEXT;                   -- startup|resume|clear|compact|hook_output
      ALTER TABLE sessions ADD COLUMN claude_title_at TEXT;                       -- ISO, last observation

      -- ===== Area 3b: xbus-MANAGED background session tracking (ADR 0024/0025) =====
      -- managed_by_xbus marks a session XBus launched itself (via 'claude --bg'); managed_pid +
      -- managed_started_at + managed_launch_key let stop/restart target ONLY xbus-managed
      -- sessions and validate liveness (not pid alone — OS pid recycling). Default 0 => a normal
      -- user-launched session is never treated as managed.
      ALTER TABLE sessions ADD COLUMN managed_by_xbus INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN managed_pid INTEGER;
      ALTER TABLE sessions ADD COLUMN managed_started_at TEXT;
      ALTER TABLE sessions ADD COLUMN managed_launch_key TEXT;                    -- <schedule_id:scheduled_for>, idempotent-launch guard

      -- ===== Area 3c: pin/archive lifecycle (ADR 0024) =====
      -- ORTHOGONAL to connection state / readiness / management_state / expired_at. archived
      -- hides a stale record from the default console view; pinned keeps it surfaced. Neither
      -- deletes the record or the Claude transcript (removal is an explicit operator op that
      -- deletes only the sessions row + projections, NEVER unlinks transcript_path).
      ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN archived_at TEXT;
      CREATE INDEX idx_sessions_lifecycle ON sessions(archived, pinned);

      -- ===== Area 4a: schedules (ADR 0025) =====
      -- Opt-in managed execution. NO FK to sessions: the target is resolved AT FIRE TIME from
      -- target_address (a name/alias/session-id), so a schedule can target a not-yet-existing
      -- (managed_spawn) session and survives target archival/deletion. Loop prevention:
      -- min_interval_ms floor + origin_guard (a scheduled message may not create schedules) +
      -- wake_limit_per_day. delivery_mode: enqueue_only (durable QUEUED, drains at the target's
      -- next checkpoint) | wake_if_running (also nudges the resident rewaker) | managed_spawn
      -- (launch a sandboxed background session; EXPERIMENTAL, default off).
      CREATE TABLE schedules (
        schedule_id        TEXT PRIMARY KEY,
        created_by_actor   TEXT NOT NULL,                        -- 'local-operator' | a session id
        title              TEXT,                                 -- operator label (display only, untrusted)
        target_address     TEXT NOT NULL,                        -- resolved at fire time (name/alias/session id)
        payload_kind       TEXT NOT NULL DEFAULT 'request',
        payload_text       TEXT NOT NULL,                        -- untrusted-peer body enqueued when due
        requires_ack       INTEGER NOT NULL DEFAULT 1,
        requires_reply     INTEGER NOT NULL DEFAULT 1,
        kind               TEXT NOT NULL,                        -- 'once' | 'interval' | 'cron'
        schedule_expr      TEXT,                                 -- interval ms / 5-field cron; NULL for 'once'
        timezone           TEXT NOT NULL DEFAULT 'UTC',
        quiet_hours_json   TEXT,                                 -- {tz,windows:[{start,end}]} or NULL
        delivery_mode      TEXT NOT NULL DEFAULT 'enqueue_only', -- enqueue_only|wake_if_running|managed_spawn
        managed_budget_json TEXT,                                -- {maxTurns,maxBudgetUsd,timeoutMs} for managed_spawn
        concurrency_key    TEXT,                                 -- at-most-one in-flight per key
        min_interval_ms    INTEGER NOT NULL DEFAULT 60000,       -- loop floor (rejected below at creation)
        wake_limit_per_day INTEGER,                              -- NULL = unlimited
        wakes_today        INTEGER NOT NULL DEFAULT 0,
        wakes_today_date   TEXT,                                 -- UTC date for wakes_today reset
        next_run           TEXT,                                 -- ISO next occurrence; NULL => nothing due
        last_run           TEXT,
        max_fires          INTEGER,                              -- NULL = unbounded
        fires_used         INTEGER NOT NULL DEFAULT 0,
        origin_guard       INTEGER NOT NULL DEFAULT 1,           -- forbid this schedule's own delivery creating schedules
        state              TEXT NOT NULL DEFAULT 'active',       -- active|paused|exhausted|cancelled
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX idx_schedules_due ON schedules(state, next_run);
      -- Wake-cap / concurrency lookups filter schedules by target_address / concurrency_key.
      CREATE INDEX idx_schedules_target ON schedules(target_address);

      -- ===== Area 4b: schedule_runs — the exactly-once run ledger (ADR 0025) =====
      -- UNIQUE(schedule_id, scheduled_for) is the CAS: one claim per fire-slot, EVER. Combined
      -- with the ux_idem UNIQUE on messages(sender_session_id, idempotency_key) and the single
      -- savepoint-reentrant transaction per tick, this gives exactly-once execution across a
      -- duplicate tick AND a broker restart mid-fire (claim rolls back on crash-before-commit;
      -- on crash-after-commit the advanced next_run + these two UNIQUEs prevent a re-fire). No
      -- claim_expires_at lease — redundant under the atomic claim+send+advance.
      CREATE TABLE schedule_runs (
        run_id             TEXT PRIMARY KEY,
        schedule_id        TEXT NOT NULL,
        scheduled_for      TEXT NOT NULL,                        -- the fire-slot instant (idempotency anchor)
        idempotency_key    TEXT NOT NULL,                        -- 'sched:'||schedule_id||':'||scheduled_for
        state              TEXT NOT NULL DEFAULT 'claimed',      -- claimed|sent|delivered|completed|skipped|failed
        skip_reason        TEXT,                                 -- quiet_hours|wake_limit|concurrency|paused|recipient_expired|budget
        claimed_at         TEXT NOT NULL,
        message_id         TEXT,                                 -- operatorSend result (ux_idem-deduped)
        managed_session_id TEXT,                                 -- preminted UUID if managed_spawn
        managed_pid        INTEGER,
        attempt            INTEGER NOT NULL DEFAULT 1,
        error_code         TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        UNIQUE(schedule_id, scheduled_for),
        FOREIGN KEY(schedule_id) REFERENCES schedules(schedule_id)
      );
      CREATE INDEX idx_schedule_runs_state ON schedule_runs(state, schedule_id);
      -- Covers the per-day wake-cap COUNT (state + scheduled_for) and the retention prune
      -- (terminal state + scheduled_for < cutoff) so neither is an ever-growing full scan.
      CREATE INDEX idx_schedule_runs_slot ON schedule_runs(state, scheduled_for);
    `,
  },
];

function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex');
}

export interface MigrationResult {
  appliedNow: number[];
  currentVersion: number;
}

/** Apply pending migrations; verify checksums of already-applied ones. */
export function runMigrations(db: SqliteDriver, nowIso: string): MigrationResult {
  // Bootstrap: does schema_migrations exist?
  const hasTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
    .get();

  const applied = new Map<number, string>();
  if (hasTable) {
    for (const row of db.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{
      version: number;
      checksum: string;
    }>) {
      applied.set(row.version, row.checksum);
    }
  }

  // Downgrade guard (§8 rollback case): the DB must NOT carry a schema version
  // newer than this code knows. Running old code against a database an upgraded
  // build already migrated forward risks silent corruption — fail closed and
  // direct the user to the matching (or newer) build.
  const codeMaxVersion = MIGRATIONS.reduce((mx, m) => Math.max(mx, m.version), 0);
  const dbMaxVersion = applied.size > 0 ? Math.max(...applied.keys()) : 0;
  if (dbMaxVersion > codeMaxVersion) {
    throw new XBusError(XBusErrorCode.DATABASE_ERROR, 'database schema is newer than this XBus build; upgrade XBus or restore a compatible data directory', {
      dbVersion: dbMaxVersion,
      codeVersion: codeMaxVersion,
    });
  }

  const appliedNow: number[] = [];
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    const cs = checksum(m.sql);
    if (applied.has(m.version)) {
      if (applied.get(m.version) !== cs) {
        throw new XBusError(XBusErrorCode.DATABASE_ERROR, 'migration checksum mismatch', {
          version: m.version,
        });
      }
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(m.version, m.name, cs, nowIso);
    });
    appliedNow.push(m.version);
  }

  const current = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
  return { appliedNow, currentVersion: current };
}
