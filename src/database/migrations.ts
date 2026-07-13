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
