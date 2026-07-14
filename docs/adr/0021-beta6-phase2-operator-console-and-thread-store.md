# ADR 0021 — Beta.6 Phase 2: local-operator identity + threaded-messaging store + communication console

**Status:** Accepted for Phase-2 build · **Date:** 2026-07-13 · beta.6 · implements
ADR 0017 (threaded messaging, data model ratified there), depends on ADR 0013
(lifecycle), 0015 (dashboard), 0016 (ledger), 0018 (control-plane security), 0019
(migration + fail-closed compatibility), 0020 (Phase-1 visibility).

ADR 0017 already ratified the **thread data model** (first-class `threads` table + a
`thread_participants` join-table + `thread_id`/`thread_sequence`/`author_type` on
`messages`; `correlation_id = thread_id`; degenerate-thread continuity; broker-assigned
per-thread sequence; per-participant unread). This ADR fixes the **one decision ADR 0017
left open and that becomes irreversible** once it ships baked into the frozen v8
migration and the reserved-name set: **how the `local-operator` is represented** so a
Claude session's `xbus_reply` can be routed back to it, while it can never impersonate,
be injected into, or expire like a Claude session. It also records the console's
read/write split.

---

## Context — the forcing constraint

`recipient_sequences(recipient_session_id)` has a **foreign key to
`sessions(session_id)`** and `PRAGMA foreign_keys = ON` for the writer. When a Claude
session replies, `delivery.reply()` calls `allocSequence(orig.sender_session_id)`, which
`INSERT OR REPLACE`s a `recipient_sequences` row keyed on the reply's recipient — i.e.
the **operator**. So the operator's `sender_session_id` MUST reference a real
`sessions` row, or the FK rejects every reply to the operator. Simultaneously:

- `messages.sender_session_id` is `NOT NULL` and is the idempotency scope
  (`ux_idem(sender_session_id, idempotency_key)`), feeds `aliasForSession`,
  `refreshMeaningfulActivity`, and the blocked-sender check — so it cannot be a
  free-floating sentinel that lacks a `sessions` row.
- `reapExpiredSessions` tombstones any session whose `expires_at <= now`
  (`last_meaningful_activity_at + 15d`); once expired, `reply()` rejects peer replies to
  it with `RECIPIENT_SESSION_EXPIRED` and the reaper dead-letters its inbound. An
  operator that expires strands every reply.
- The operator must **never** appear in the routable session selector, never be
  injectable (it does no checkpoint pull), and never be claimable/impersonable by a real
  Claude session.

## Decision

1. **The operator is a single, reserved, broker-provisioned `sessions` row — never a
   registered session.** At broker startup (`startBrokerHost`, after migrations, before
   the daemon binds) the broker idempotently ensures ONE row:
   - `session_id = 'local-operator'` (a fixed, reserved constant — NOT a UUID, so it is
     unmistakable in the ledger and cannot collide with a real
     `CLAUDE_CODE_SESSION_ID`).
   - `management_state = 'unmanaged'`, `readiness = 'disconnected'`,
     `state = 'disconnected'` → `deriveSessionLabel` returns `unmanaged`/not-routable, so
     it is **excluded from the routable selector by construction** (the dashboard filters
     to routable Claude sessions for the "select a session" control, and separately never
     lists `local-operator` as a target).
   - `session_name_state = 'active'`, `session_name = 'local-operator'`,
     `normalized_session_name = 'local-operator'`, and `'local-operator'` is added to
     `RESERVED_SESSION_NAMES` so no real session can claim/shadow it.
   - `expires_at = NULL` **and** the reaper is taught to **skip `session_id =
     'local-operator'`** in `reapExpiredSessions` (belt-and-suspenders: even if some path
     set `expires_at`, the operator is never tombstoned). It has a `recipient_sequences`
     row (`next_sequence = 1`) so replies can allocate against it.
   This satisfies the FK, the `NOT NULL` sender, the idempotency scope, and the
   non-expiry requirement with **zero new nullable-FK gymnastics** and **no change to the
   proven `send`/`reply` lifecycle**. It is created by the broker (never via
   `register_session`), so it holds **no `SessionAuthority`, no epoch, no live component,
   no connection** — it is a routing endpoint, not an actor that can pull/ack/reply.

2. **`author_type` (ADR 0017 D3) is broker-stamped, never client-supplied.** A message
   composed in the dashboard is stamped `author_type = 'operator'` and
   `sender_session_id = 'local-operator'` **server-side** on the broker loop. The browser
   payload carries only `{to, text, threadId?, parentMessageId?, requiresAck,
   requiresReply, idempotencyKey, ttlSeconds?}` — never a sender/actor/author field
   (mirrors the invariant that sender identity is always broker-stamped). The ledger
   `actor` is `'local-operator'`.

3. **Operator writes route to the broker loop, never the read-only dashboard handle.**
   The dashboard HTTP server stays read-only-by-construction; its worker keeps a
   physically `readOnly:true` handle. New authenticated `POST` routes call **in-process
   daemon callbacks** injected in `host.ts` (exactly like `onSessionStateChanged` /
   `dashboardUrlMinter`), which run `BrokerStore` methods on the single-writer broker
   loop, then `notifyChange()`. A dashboard/write-path failure is caught and never blocks
   the broker or delivery (I5).

4. **Threading reuses the proven lifecycle; only linkage is new.** A new
   `store.openThread()` + `store.operatorSend()` and a threaded variant of the send/reply
   inserts populate `thread_id` / `thread_sequence` and set `correlation_id = thread_id`,
   `parent_message_id` = the specific turn answered. Delivery, exactly-once injection
   (`ux_injection_logical`), ack/reply, retry/dead-letter, and the reaper are **unchanged**
   — an operator turn is an ordinary queued message to the recipient and injects
   identically to a peer message (the checkpoint pull is sender-agnostic). A Claude reply
   inherits the thread via `thread_id = orig.thread_id` and the next `thread_sequence`.

5. **`thread_sequence` is a real per-thread monotonic counter** (`thread_sequences` table,
   allocated `INSERT OR REPLACE` inside the send/reply transaction like
   `recipient_sequences`), because `recipient_sequence` is per-**recipient** and a thread
   spans two recipient streams (op→session and session→op) — neither gives a single
   monotonic thread order.

6. **Unread is derived per participant** from committed rows on the read-only handle:
   `thread_participants.last_read_thread_seq` + a count of `thread_sequence >
   last_read_thread_seq` for that participant. `mark-read` (an operator route → broker
   loop → one `THREAD_READ` ledger event) advances the operator participant's
   `last_read_thread_seq`. Two tabs are consistent because the value lives in one row
   mutated only on the single-writer loop; the count is a pure read.

7. **Every thread mutation appends exactly one hash-chained `ledger_events` row in the
   same transaction** (`THREAD_OPENED`, `OPERATOR_MESSAGE_SENT`, `THREAD_READ`), with
   `actor = 'local-operator'` and `subject.threadId` (already schema-supported). Bodies
   and secrets never enter the ledger. Note that peer `send` historically wrote only
   `audit_events`; Phase-2 thread events additionally write the chained ledger so the
   operator timeline can never diverge from state.

## Linkage semantics (worked example — a 4-turn operator↔session thread)

| turn | message | sender | recipient | thread_id | correlation_id | parent_message_id | causation_id | thread_sequence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | op request #1 (opens thread) | local-operator | S | **T** (= msg1 id) | T | NULL | NULL | 1 |
| 2 | S ack | (receipt, not a message) | — | — | — | — | — | — |
| 3 | S reply #1 | S | local-operator | T | T | msg1 | msg1 | 2 |
| 4 | op follow-up #2 | local-operator | S | T | T | msg3 | msg3 | 3 |
| 5 | S reply #2 | S | local-operator | T | T | msg4 | msg4 | 4 |

`thread_id = correlation_id = T` for the whole thread (ADR 0017 D1). `parent_message_id`
points at the exact turn being answered; `causation_id` mirrors it, matching the existing
`reply()` semantics (`causation_id = parent_message_id = orig.messageId`). Operator
follow-ups set `parent_message_id` to the last turn in the thread (or the root if none).

## Migration (v8, additive, checksum-frozen, SCHEMA_VERSION 7→8, wire → `xbus-p1-stp1-s8`)

Additive DDL only (no edit to v1–v7; SQLite cannot ALTER-add an FK/NOT-NULL-without-
default to a populated table):

- `CREATE TABLE threads(thread_id PK, root_message_id, subject, created_by_actor,
  state, created_at, updated_at, last_message_at, last_thread_sequence)`.
- `CREATE TABLE thread_participants(participant_id PK, thread_id, session_id, actor_kind,
  participant_role, joined_at, left_at, last_read_thread_seq, muted,
  UNIQUE(thread_id, session_id))` — the extensible N-party join-table (ADR 0017 locked).
- `CREATE TABLE thread_sequences(thread_id PK, next_sequence)`.
- `ALTER TABLE messages ADD COLUMN thread_id TEXT` (nullable),
  `ADD COLUMN thread_sequence INTEGER` (nullable),
  `ADD COLUMN author_type TEXT NOT NULL DEFAULT 'claude'`.
- Indexes: `idx_messages_thread(thread_id, thread_sequence)`,
  `idx_threads_updated(updated_at)`, `idx_participants_session(session_id)`.
- **Backfill** existing rows so legacy conversations become coherent degenerate threads:
  `UPDATE messages SET thread_id = correlation_id WHERE thread_id IS NULL`; seed one
  `threads` row + one `thread_sequences` row per distinct `correlation_id` group, and
  assign `thread_sequence` by `created_at, message_id` order within each group
  (`strftime('%Y-%m-%dT%H:%M:%fZ', …)` if any timestamp is computed, matching the v6
  backfill discipline). `author_type` defaults `'claude'` for all legacy rows. The
  `local-operator` session row is created at **runtime startup**, not in the migration
  (so the migration stays pure schema + backfill of existing data).

The 7→8 increase auto-moves `SCHEMA_VERSION` and `WIRE_COMPATIBILITY_ID`; the handshake
then fail-closes any s7↔s8 skew — the intended whole-install upgrade (ADR 0019). Install
already snapshots the DB on any schema increase and restores on failure, so a failed
beta.6 upgrade leaves a working s7 install (proven by a new fault-injection test).

## Security

- Every new `/api/*` route + the stream inherits the existing bearer-token gate
  (`validateToken`) — placed under `/api/*`, authenticated for free; only the method
  guard is widened to allow `POST` on the specific write paths, still after the token
  check.
- The operator cannot impersonate a session: `author_type`/`sender_session_id` are
  broker-stamped; `'local-operator'` is reserved; the operator row is unmanaged/
  unroutable/injection-incapable; it holds no `SessionAuthority`, so it can never
  `ack`/`reply`/pull. A leaked tab token grants only loopback HTTP access (authority is
  the separate broker-side identity, not the token).
- Operator message text is **still untrusted-peer content** to the recipient model (same
  fenced injection, same "no authority" instructions, same `RESERVED_METADATA_KEYS`
  rejection via `validateSendInput`). The console does not weaken the fence.
- Read-only handle + off-loop worker preserved; write path is best-effort and isolated so
  it can never crash the broker loop or stall delivery.

## Consequences

- Positive: no change to the exactly-once/idempotent/reaper machinery; threads are
  additive; the operator is a clean, distinct, durable, non-impersonating principal; the
  console reuses the entire proven delivery lifecycle.
- Negative / accepted: one reserved session row exists permanently (tiny, unmanaged, does
  not count toward routable sessions); `author_type` adds one column to `messages`;
  three new small tables. All within the additive-migration discipline.
- Irreversible bits (why this ADR exists): the `'local-operator'` reserved id/name and
  the v8 table/column shapes ship frozen. Chosen for FK-correctness, non-expiry,
  non-impersonation, and lifecycle reuse.
