# ADR 0020 — Beta.5 Phase 1 detailed design: session visibility (answers the 5 release-blocking questions)

**Status:** Proposed for Phase-1 approval · **Date:** 2026-07-12 · beta.5 · depends on
ADR 0013 (lifecycle), 0015 (dashboard), 0016 (ledger), 0018 (security), 0019 (migration).

This ADR answers the five release-blocking review questions **concretely** — SQL
schemas, a lifecycle state machine + decision table, failure behavior, and the test
matrix — so Phase 1 can be approved on evidence, not prose. Grounded in the real code
at `origin/main 3d78fdee` and the real machine layout
(`~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`, 183 transcripts observed) plus
the official SessionStart hook contract (`session_id`, `transcript_path`, `cwd`,
`source`, `agent_type`, `session_title`).

---

## Q1 — Can every new/resumed/forked session be identified WITHOUT undocumented files?

**Every session that fires SessionStart is identified from documented inputs alone
(authoritative). Sessions that never fire one (pre-existing/pre-install) are surfaced
honestly as lower-confidence `dormant`/`unmanaged` — with the reliance on internal
layout labelled as such, never claimed as "documented".** (Review correction 2026-07-12:
the earlier draft over-claimed the import path as "documented"; corrected below.)

Three identification paths, in decreasing trust — the `identify_confidence` column
records which one produced the row, so the dashboard never presents a heuristic as fact:

| Path | Source | What's documented vs. relied-upon | `identify_confidence` | Produces |
| --- | --- | --- | --- | --- |
| **Live SessionStart** | Hook stdin: `session_id`, `source`∈{startup,resume,clear,compact}, `cwd`, `transcript_path`, `agent_type?`, `session_title?` | **Fully documented** hook contract — Claude tells us directly | `signal` | `active` (or resumes a `dormant`/expired row) |
| **Import (dormant)** | Enumerate `~/.claude/projects/<slug>/*.jsonl`; filename stem = session UUID; mtime = last-seen | **Relies on internal, undocumented layout** (dir location, one-uuid-jsonl-per-session, slug↔cwd encoding). Metadata-only: we `stat` filenames, **never open bodies** | `listing_only` | `dormant` |
| **Unmanaged detection** | Best-effort: a live `claude`/node process with no matching XBus registration | **Heuristic.** Reliably obtaining another process's `CLAUDE_CODE_SESSION_ID` on Windows is not guaranteed and we do NOT poke process internals to force it | `unidentified` (or `listing_only` if we can only say "≥1 unmanaged present") | `unmanaged` |

- **Import is best-effort and explicitly non-authoritative.** The `listing_only`
  confidence + the `dormant` label tell the operator "known from on-disk history, not a
  live managed session." Because the directory layout and slug↔cwd encoding are Claude
  internals, import is a **convenience/history view**, not a correctness-bearing path:
  if the layout changes, import degrades to empty/`unidentified` — it never blocks the
  broker and never misroutes (dormant/unmanaged are unroutable). We do **not** claim the
  layout is documented.
- **Forks: new identity, no inheritance — `forked_from` is best-effort.** A fork fires
  SessionStart `startup` with a **new** `session_id` → a brand-new session (epoch 1,
  beta.4.1-safe automatic_alias), no thread/alias inheritance. The researched
  SessionStart input list contains **no parent/fork field**, so `forked_from` is
  populated **only if** a future documented linkage field appears; today it stays NULL
  and the fork story is simply "distinct id = distinct owner" (matches the ADR 0003/0008
  split-brain model). The column is a forward-compat placeholder, documented as
  normally-NULL — not a load-bearing claim.
- **What we NEVER do:** parse/modify `*.jsonl` transcript bodies; read Claude internal
  state beyond the `~/.claude.json` + `~/.claude/settings.json` we already own (ADR 0018);
  poke another process's memory/env to force an id; or claim retroactive registration for
  a session that never fired a post-install SessionStart (ADR 0013 D6).

---

## Q2 — How are dormant / unmanaged / disconnected / expired distinguished?

The label is derived from **FOUR real fields**, not one enum — conflating them is the
trap. Three are existing columns in the live `sessions` table; one is new. (Review
correction 2026-07-12: an earlier draft folded connection-drop into the `readiness`
enum, but in the actual code the connection state and readiness are **separate
columns** — see below.)

- **Field 1 — `management_state`** *(NEW column; does XBus manage this, and how learned?)*:
  `unmanaged` → `dormant` → `active`.
- **Field 2 — `state`** *(EXISTING column, `sessions.state ∈ {connected, disconnected}`)*:
  the IPC connection state. **`daemon.onConnClose` sets `state='disconnected'`** when a
  live owner's link drops (`daemon.ts` onConnClose); reconnect restores `connected`,
  same epoch. Meaningful only when `management_state='active'`.
- **Field 3 — `readiness`** *(EXISTING column, the `readiness.ts` enum)*: `initializing`,
  `ready_checkpoint`, `ready_live`, `degraded_*`. **Note:** `resolveReadiness()` never
  returns `disconnected`; the enum's `disconnected` value is written **only by the expiry
  reaper** alongside `expired_at`, so it is an expiry artifact, NOT the connection-drop
  signal (that is Field 2). The derive-label function therefore reads Field 2 for
  connection-drop and treats a `readiness='disconnected'` row as part of the expired case.
- **Field 4 — `expired_at`** *(EXISTING tombstone, ADR 0012 D6)*: non-null ⇒ expired.

### Decision table (authoritative — implemented as a pure function, unit-tested)

Evaluated **top-down; first match wins** (so `expired_at` set is caught before the
active rows, and a legacy `active`+`expired_at` row from the migration backfill lands on
`expired`, not `active — *`):

| # | management_state | state (conn) | readiness | expired_at | **Dashboard label** | Routable? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | any | — | — | **set** | **expired** (tombstoned; ADR 0012) | no |
| 2 | `unmanaged` | — | — | null | **unmanaged** (detected, no XBus signal) | no |
| 3 | `dormant` | — | — | null | **dormant** (known from transcripts, not live) | no |
| 4 | `active` | `disconnected` | any | null | **active — disconnected** (owner's link dropped this session) | queued |
| 5 | `active` | `connected` | `ready_checkpoint`/`ready_live` | null | **active — ready** | yes |
| 6 | `active` | `connected` | `initializing`/`degraded_*` | null | **active — starting/degraded** | no (yet) |

Key distinctions made explicit (each covered by a table row + a unit test):
- **disconnected ≠ dormant (row 4 vs 3):** `disconnected` = `management_state='active'` +
  `state='disconnected'` — an owner that connected *this* broker lifetime and dropped
  (rejoins on reconnect, keeps epoch, `store.ts` reconnect path); `dormant` = imported
  from a *prior* run, never connected this lifetime.
- **dormant ≠ expired (row 3 vs 1):** `dormant` is pre-15-day (`expired_at` null) and
  activates on `resume`; `expired` has the tombstone set — resume routes through the
  existing expired-resume path (fresh epoch, no resurrection).
- **unmanaged ≠ everything else (row 2):** the only label NOT sourced from the
  broker/ledger — a live-process heuristic, always rendered "detected; not managed",
  never transitions to `active` without a real SessionStart signal.

(Field naming: the new column is `management_state` everywhere, incl. the architecture
doc — the earlier `lifecycle_state` mention there is corrected to `management_state`.)

### Lifecycle diagram

```
                         (transcript listing, install/first-start)
                                      │ import
                                      ▼
  (pre-install live proc, no signal) dormant ───────── SessionStart:resume ──────┐
        │ detect                       │                                          │
        ▼                              │ SessionStart:startup (new id)            ▼
     unmanaged ─ resume/restart ─▶  active(initializing) ─ signal_readiness ─▶ active(ready)
        (cannot self-promote;          │  ▲                                       │
         needs a real SessionStart)    │  └── reconnect (same epoch) ── disconnected
                                       │                                          │
                                       │ 15d no meaningful activity (reaper)      │
                                       ▼                                          │
                                    expired ◀───────────────────────────────────┘
                                       │ SessionStart:resume → fresh epoch (no resurrection, ADR 0012 D6)
                                       ▼
                                  active(initializing)
      clear/compact: stay active; record lifecycle event; identity unchanged.
      fork: SessionStart:startup with a NEW id → a separate active(initializing) node.
```

---

## Q3 — Is SQLite authoritative state, or only an append-only audit projection?

**Split by table, and it is explicit — this is the crucial design line:**

- **Authoritative broker state** lives in the existing **mutable** relational tables
  (`sessions`, `aliases`, `messages`, `deliveries`, …). The broker is the single writer
  (I4). Beta.5 Phase 1 adds mutable columns to `sessions` (management_state, source_last,
  identify_confidence, forked_from, transcript_path, first_seen/last_seen) — these are
  **current state**, updated in place inside broker transactions.
- **`ledger_events` is an append-only AUDIT PROJECTION** — a hash-chained, immutable
  *history* of transitions. It is **not** the source of truth for current state; it is
  the tamper-evident record of *how* state got here.

**Invariant (tested):** every mutation of authoritative session/delivery state and its
`ledger_events` append happen in **one broker transaction** — so the ledger can never
diverge from state (no transition unlogged, no logged transition that didn't happen).
The current state is always recoverable from the mutable tables alone.

**Coupling — stated precisely (review correction 2026-07-12).** Same-txn append means an
`INSERT INTO ledger_events` failure aborts the whole op. This is **not** an
audit-subsystem coupling that can independently take down delivery: both the state
mutation and the ledger append are `INSERT`/`UPDATE`s into the **same SQLite file** in
the **same transaction**, so the only realistic shared failure (disk-full, I/O error, DB
corruption) fails the state write *anyway* — there is no scenario where routing state
commits durably but only the ledger row can't. So we do **not** claim "the ledger can
never affect the op"; we claim the accurate thing: **the ledger shares the op's fate,
adding no *independent* failure mode** — a healthy DB that can persist the state change
can persist its ledger row. A *chain that is already broken* (past tamper/bit-rot) is
separate and never blocks new ops (it degrades auditability visibly — Q4). This keeps
Q5's "dashboard/audit cannot destabilize delivery" intact: the *dashboard* is read-only
and off-loop (Q5 #2); the *ledger write* isn't a separate subsystem that can fail on its
own. **Rejected alternative:** best-effort/out-of-band ledger writes (decoupled) — that
would let state and audit diverge silently, which is worse for an audit ledger than
sharing the op's fate. We choose no-divergence over best-effort, and describe the
coupling honestly rather than claim a non-existent independence.

Why not make the ledger authoritative (event-sourced)? Rejected for Phase 1: it would
duplicate the proven ADR 0003 receipt/epoch state machine, add replay complexity, and
risk the Layer-3 injection invariants. The mutable tables stay the single source of
truth; the ledger is the append-only audit lens over them, sharing their transaction.

**`audit_events` coexistence (implementation gap closed):** the existing `audit_events`
table (written in-txn today by `store.ts`/`delivery.ts`) is **kept** for beta.4-parity
diagnostics; `ledger_events` is the **new hash-chained** record. Phase 1 adds the
`ledger_events` append at the same in-txn sites that already call `audit()` — and, per
I2/I3, the append is pure metadata (ids/states/hashes) that **cannot** perturb the
Layer-3 `issue()`-returns-null idempotency or the non-ACK path: it is an extra INSERT
after the state decision is made, never a branch on delivery logic. A test asserts a
forced `ledger_events` insert-failure rolls back the state change (all-or-nothing) and
that injection/ack/reply outcomes are byte-identical with vs. without the ledger wired.

---

## Q4 — Hash chain: retention, export, corruption, recovery, growth

### Schema (append-only)

```sql
CREATE TABLE ledger_events (
  event_id     TEXT PRIMARY KEY,            -- UUIDv7 (existing IdGen)
  seq          INTEGER NOT NULL UNIQUE,      -- dense monotonic, gap-free per ledger
  event_type   TEXT NOT NULL,
  actor        TEXT NOT NULL,               -- session id | 'operator' | 'broker' | 'installer'
  subject_json TEXT NOT NULL,               -- {sessionId?, threadId?, messageId?} (ids only)
  payload_json TEXT NOT NULL,               -- SAFE metadata: states, counts, hashes — NO bodies/secrets
  created_at   TEXT NOT NULL,               -- UTC ISO-8601
  prev_hash    TEXT NOT NULL,               -- entry_hash of seq-1 (genesis = 64 zeros)
  entry_hash   TEXT NOT NULL                -- sha256(canonical(seq,event_type,actor,subject,payload,created_at,prev_hash))
);
CREATE UNIQUE INDEX ux_ledger_seq ON ledger_events(seq);
-- append-only enforcement: triggers reject UPDATE/DELETE
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_events
  BEGIN SELECT RAISE(ABORT, 'ledger_events is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_events
  BEGIN SELECT RAISE(ABORT, 'ledger_events is append-only'); END;
-- checkpoint anchors for compaction (see Growth/Retention)
CREATE TABLE ledger_anchors (
  anchor_seq   INTEGER PRIMARY KEY,          -- seq of the anchored event
  anchor_hash  TEXT NOT NULL,                -- entry_hash at anchor_seq
  created_at   TEXT NOT NULL,
  reason       TEXT NOT NULL                 -- 'vacuum' | 'periodic'
);
```

`canonical(...)` = a fixed field order, JSON with sorted keys, UTF-8 — identical rules
on write and on verify (unit-tested against frozen vectors), so the hash is reproducible.

- **Growth:** append-only, so it grows with activity. Bounded write amplification via the
  existing WAL. Row is small (ids + safe metadata, no bodies). Dashboard queries are
  indexed by `seq` (paged). A size metric is exposed in `doctor`/dashboard.
- **Retention / compaction (operator-initiated, never silent):** `xbus audit vacuum
  --before <utc>` archives events `< N` to a JSONL export, writes a `ledger_anchors` row
  `(anchor_seq=N-1, anchor_hash=entry_hash(N-1))`, then prunes the archived rows. The
  append-only triggers cannot be "selectively bypassed" for one statement (SQLite has no
  such feature), so the **concrete mechanism** is, inside a single transaction (SQLite DDL
  is transactional — a crash rolls the whole thing back): `BEGIN IMMEDIATE` → verify the
  full chain up to N-1 → write the anchor → `DROP TRIGGER ledger_no_delete` →
  `DELETE FROM ledger_events WHERE seq < N` → `CREATE TRIGGER ledger_no_delete …` (recreate
  identically) → append a `LEDGER_VACUUMED` event → `COMMIT`. The `no_update` trigger is
  never dropped. A crash at any point leaves the pre-vacuum chain intact (transactional
  DDL). Nothing auto-prunes; vacuum is an explicit, audited operator command.
  **Multi-anchor verify selection:** `ledger_anchors` may hold several rows; `verify`
  starts from the **highest anchor whose `anchor_seq < MIN(remaining seq)`** (i.e. the
  most recent pruned boundary), treats that anchor's `anchor_hash` as the genesis pointer
  for the surviving prefix, and verifies forward. Anchors are themselves append-only.
- **Export:** `xbus audit export [--from --to] --out <file>` → sanitized JSONL (already
  redacted; ids/hashes only) + a manifest with the range's first `prev_hash`, last
  `entry_hash`, and a recomputed range digest, so an export is independently
  chain-verifiable.
- **Corruption detection:** `xbus audit verify` recomputes `entry_hash` for every row in
  `seq` order and checks (a) each `prev_hash == entry_hash(seq-1)`, (b) `seq` dense/gap-
  free from the last anchor, (c) `entry_hash` matches recomputation. It reports the
  **first** break (seq + expected/actual) — so tampering, a dropped row, or bit-rot is
  localized.
- **Recovery / failure behavior (matrix):**

| Failure | Detection | Behavior (fail-safe) |
| --- | --- | --- |
| WAL torn write / crash mid-append | SQLite WAL replay on open | atomic: the half-written event is rolled back; state txn rolls back with it (single txn) → no divergence |
| Chain break (tampered/dropped row) | `audit verify` on broker start + on demand | broker logs + a `LEDGER_CHAIN_BROKEN` diagnostic; **read-only audit still served with a prominent "chain broken at seq N" banner**; routing/delivery UNAFFECTED (ledger is a projection, Q3) |
| DB newer schema than build | existing downgrade guard (ADR 0019) | fail closed; no partial serve |
| Disk-full / I/O error at commit | insert error inside the shared txn | the **whole op** (state + ledger) fails atomically with a clean typed error — no partial/ghost state, no state-without-ledger. Not audit-specific: a full disk fails the state write too (Q3 coupling) |

Two distinct cases, kept separate (this is the Q3/Q5 reconciliation):
- A **ledger write cannot fail independently of the state write** — same file, same txn
  (Q3). So there is no "audit subsystem" that can fall over and take routing with it; a
  DB healthy enough to persist state persists its ledger row.
- A **chain that is already broken** (past out-of-band tamper / bit-rot) **never blocks
  new delivery** — new ops keep appending; `verify` flags the historical break. This is
  the only sense in which "chain-broken doesn't block delivery" holds, and it is about
  *reading/auditing* history, not *writing* new events.

**Tamper-detection latency (stated honestly):** the append-only triggers stop SQL-layer
UPDATE/DELETE, but a direct file edit or bit-rot bypasses SQL entirely. `verify` runs on
broker start **and** on a periodic timer (default hourly) **and** on demand — so an
out-of-band tamper is caught within at most one verify interval (bounded, not "next
restart"). The dashboard shows a "chain verified at &lt;ts&gt;" freshness stamp so staleness
is visible.

---

## Q5 — Dashboard: read-only, loopback-only, single-instance, cannot destabilize delivery

Enforced by **construction + assertions + tests**, not policy. (Review correction
2026-07-12: the dashboard read path is moved OUT of the broker event loop — see #4 — and
the token requirement is tightened to *every* request, closing a same-machine
read-exposure hole.)

1. **Read-only (Phase 1):** the dashboard HTTP server exposes **only `GET`/`HEAD`**
   endpoints (`/api/sessions`, `/api/ledger`, `/api/session/:id`, SSE `/api/stream`,
   `/alive`). There are **no mutating routes in Phase 1** (rename/compose arrive in
   Phase 2/3). A route-table test asserts every registered handler is `GET`/`HEAD`. The
   dashboard opens the DB with **`SQLITE_OPEN_READONLY`** — no writer handle exists in the
   dashboard component, so it physically cannot mutate the DB (I4: broker stays single
   writer). A write attempt on that handle throws — asserted by test.
   **WAL caveat (must be validated, not assumed):** a read-only handle to a WAL database
   cannot create/recover `-wal`/`-shm` or checkpoint; it reads correctly while the broker
   (writer) is live and the files are owner-readable. Phase-1 acceptance includes an
   explicit end-to-end test that the read-only handle returns correct, current rows
   **while the broker is actively writing** (and, per #4, from a separate process).

2. **Cannot destabilize delivery — the read path runs OFF the broker event loop.**
   `node:sqlite` `DatabaseSync` is **synchronous**, and the broker is a single Node
   process/loop running IPC + the reaper. An in-process synchronous read (e.g. a large
   `/api/ledger` scan) would execute *on the broker's loop and stall delivery* — request
   timeouts/response caps do NOT help there (they bound a slow socket, not a slow query).
   Therefore the dashboard's DB reads run in a **separate `worker_thread` (or child
   process)** with its own `SQLITE_OPEN_READONLY` connection; the broker loop only does a
   cheap message-passing handoff. The SSE stream is a fan-out of already-committed state
   (the worker polls / the broker posts change-notifications), never a write path and
   never a synchronous query on the broker loop. This makes "cannot touch routing/epochs/
   receipts/injection-ledger" true for reads as well as writes — structurally, not by
   hope. **Test:** run a *pathological large-scan* read (full ledger + all sessions)
   **concurrently** with the four-replica matrix → matrix still 12/12, broker instance
   unchanged, p99 delivery latency within bound; plus a hung/slow client → dropped, loop
   unaffected.

3. **Loopback-only + token on EVERY request:** binds `127.0.0.1` exclusively; a startup
   assertion refuses any non-loopback address. Because loopback is **shared across local
   OS users** (ADR 0018 threat model), the owner-ACL'd token is the real boundary and is
   required on **every request — including all `GET` reads** (a read-only dashboard still
   exposes session metadata + the audit ledger, which another same-machine user must not
   read). This tightens ADR 0018 D2 ("token on mutating endpoints") → **token on all
   requests** for Phase 1 (there are no mutating endpoints yet, so a reads-only token
   requirement is the whole surface). Test: bind to `0.0.0.0` throws; any request
   (incl. `GET`) without a valid token → 401; token is never logged/redacted in the ledger.

4. **Single-instance:** the **broker** owns the one HTTP server (broker is the machine
   singleton, ADR 0015). Port + URL recorded in `broker.state.json`. A second start finds
   the running dashboard and does not open another (debounced browser-open + `/alive`
   heartbeat → no tab storm). Test: two `ensure-dashboard` calls → one listener, ≤1
   browser open.

---

## Schema delta (Phase 1, migration 6 → 7; ADR 0019)

```sql
-- mutable authoritative state (added to existing sessions table)
ALTER TABLE sessions ADD COLUMN management_state    TEXT NOT NULL DEFAULT 'active';  -- unmanaged|dormant|active
ALTER TABLE sessions ADD COLUMN source_last         TEXT;      -- startup|resume|clear|compact|import|fork
ALTER TABLE sessions ADD COLUMN identify_confidence TEXT NOT NULL DEFAULT 'signal'; -- signal|listing_only|unidentified
ALTER TABLE sessions ADD COLUMN forked_from         TEXT;      -- parent session id (diagnostic), if documented
ALTER TABLE sessions ADD COLUMN transcript_path     TEXT;      -- documented SessionStart input
ALTER TABLE sessions ADD COLUMN first_seen_at       TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_source_at TEXT;
-- append-only audit projection (Q4 schema above): ledger_events + ledger_anchors + triggers
```
Existing rows default to `management_state='active'`, `identify_confidence='signal'`
(they were live pre-migration). Forward-only; downgrade-guarded; protocol/STP frozen;
`xbus-p1-stp1-s6 → -s7`.

---

## Test matrix (Phase 1 gate — all automated unless marked human)

- **Identification (Q1):** SessionStart `startup`/`resume`/`clear`/`compact` each register/
  update correctly (fixture hook inputs); fork `startup` with a new id → new session, no
  inheritance; import reads only directory listing (assert transcript bodies never opened
  — spy on fs reads); unmanaged detection never flips to active without a signal.
- **State distinction (Q2):** table-driven unit test of the derive-label pure function
  across every row of the decision table; disconnected-vs-dormant and dormant-vs-expired
  transitions via the store + reaper (FakeClock 15-day) ; a resume of an expired dormant
  session → fresh epoch, no resurrection.
- **Authoritative-vs-projection (Q3):** property test — after N random lifecycle ops,
  current state rebuilt from mutable tables == live state; and every transition has
  exactly one ledger event in the same txn (kill-after-state-before-ledger is impossible
  because it's one txn — assert by fault injection that a forced ledger-insert failure
  rolls back the state change).
- **Hash chain (Q4):** frozen canonical-hash vectors; `verify` passes on a good chain;
  `verify` localizes a tampered row / dropped seq / bit-flip to the first bad seq;
  vacuum+anchor preserves verifiability; export manifest is independently verifiable;
  crash-mid-append (WAL) leaves a verifiable chain (no half-event); disk-full → clean
  error, no ghost state.
- **Dashboard safety (Q5):** route table is GET-only; read-only connection rejects
  writes; non-loopback bind refused; missing/invalid token → 401; two ensure-dashboard →
  one listener + ≤1 open; **concurrent dashboard load during the four-replica matrix →
  matrix still 12/12, broker instance unchanged** (the "cannot destabilize delivery"
  proof); uninstall stops broker + dashboard; audit DB preserved unless `--purge`.
- **Migration/compat (ADR 0019):** beta.4.1→beta.5 upgrade migrates 6→7 additively;
  downgrade guard refuses a v7 DB on an older build; a beta.4.1 client still does
  request/ACK/reply against a beta.5 broker (interop).
- **Human visual gate:** launch real Claude sessions (startup + `--resume` + a fork) and
  visually confirm each appears in the dashboard with the correct state — the one thing
  that needs eyes (rendering), consistent with the ADR 0013 human-gate stance.

Plus the standing release gates on the Phase-1 PR: verify:release 15/15 ×2, npm audit
high=0, reproducible artifact, independent adversarial review = 0 confirmed defects.

---

## What Phase 1 explicitly does NOT include

Threaded messaging (ADR 0017), operator-composed messages, and title-sync (ADR 0014) are
**deferred** (owner-directed sequencing). Phase 1 reuses beta.4.1 request/ACK/reply
unchanged and ships session visibility only.
