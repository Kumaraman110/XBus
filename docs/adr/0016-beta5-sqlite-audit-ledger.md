# ADR 0016 — Beta.5: SQLite as authoritative, append-only, hash-chained audit ledger

**Status:** Proposed · **Date:** 2026-07-12 · beta.5. Companion to ADR 0013.

## Context

Beta.5 requires SQLite to be the authoritative ledger for sessions, aliases, threads,
messages, delivery transitions, failures, broker lifecycle, UI actions, and
install/config events — with migrations, WAL, foreign keys, transactions, stable IDs,
UTC, and an **append-only hash-chained event log**; the broker is the single writer;
the UI provides timeline/filters/details and sanitized JSON export.

XBus already uses `node:sqlite` with WAL and a migrations graph (`database/`,
`migrations.ts`), an `audit_events` table (safe-metadata JSON), and stable UUIDv7 ids
via `IdGen`. Beta.5 extends this, it does not replace it.

## Decision

1. **Reuse the existing SQLite store + migrations + WAL**; add beta.5 tables via new
   migration steps (ADR 0019). Keep `busy_timeout`/WAL pragmas. Enable **foreign keys**
   (`PRAGMA foreign_keys=ON`) for the new relational tables (verify existing pragmas
   don't disable it; if legacy rows can't satisfy FKs, scope FK enforcement to new
   tables). All timestamps **UTC ISO-8601** (existing `clock.nowIso()`), all ids stable
   UUIDv7 (existing `IdGen`).

2. **Single writer = the broker** (I4). The dashboard server issues broker ops; it never
   opens the DB for writing. Reads may use a read-only connection.

3. **Append-only hash-chained event log** — a new `ledger_events` table:
   `event_id (UUIDv7, PK)`, `seq (INTEGER, monotonic, per-ledger)`, `event_type`,
   `actor` (session id / `operator` / `broker` / `installer`), `subject_ids` (session/
   thread/message), `payload_json` (safe, redacted — no bodies/secrets), `created_at`
   (UTC), `prev_hash`, `entry_hash`. `entry_hash = sha256(prev_hash ‖ canonical(event
   fields))`, `prev_hash` = previous row's `entry_hash` (genesis = zero). Inserts are
   append-only (no UPDATE/DELETE; enforced by a trigger + code review). A `verify`
   routine recomputes the chain and reports the first break. This makes tampering /
   dropped events detectable.

4. **What is logged**: session lifecycle (start/resume/clear/compact/fork/import/
   dormant/unmanaged/expire), alias + name ops, thread create, message create,
   **every delivery-state transition** (queued→…→completed/failed/expired/dead_letter),
   failures, broker start/stop/restart, dashboard/UI actions (rename, operator-send,
   redeliver), and install/uninstall/config events. Delivery transitions are recorded
   at the point the store already changes state (one insert per transition, in the same
   transaction — so the ledger can't diverge from state).

5. **Redaction**: `payload_json` follows the existing §5.1 body-free discipline —
   message **bodies are NOT in the ledger** (only ids, hashes, sizes, states, actors).
   The threads table (ADR 0017) holds bodies under the same access controls as today's
   `messages.body_text`; the ledger references them by id/hash. Secret scrubbing reuses
   the existing redaction path.

6. **UI surface**: read-only timeline (paged, newest-first), filters (session, thread,
   event type, state, time range), event detail, and a **sanitized JSON export**
   (redacted, chain-verifiable) via a dashboard endpoint + an `xbus audit export` CLI.

7. **Retention / growth**: the ledger is append-only, so it grows. Provide
   `xbus audit vacuum --before <ts>` (operator-initiated, logged) that archives+prunes
   old events while preserving chain continuity via a checkpointed `prev_hash` anchor.
   Never auto-prune silently. Uninstall **preserves** the audit DB unless `--purge`.

## Impact

- New tables: `ledger_events`, plus threads/messages extensions (ADR 0017) and
  lifecycle columns (ADR 0013/0014). Schema bump (ADR 0019) with a downgrade guard.
- FK + append-only triggers are new; covered by migration tests + a chain-verify test.
- Storage grows with activity; documented + `vacuum` provided. WAL already bounds
  write amplification.
- No protocol/STP change; the ledger is broker-local.
