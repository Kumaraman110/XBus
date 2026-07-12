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

**Yes. Identity comes only from documented SessionStart inputs; import reads only the
documented transcript *directory listing* (never transcript internals).**

Three identification paths, in decreasing trust:

| Path | Source (all documented) | Trust | Produces |
| --- | --- | --- | --- |
| **Live SessionStart** | Hook stdin: `session_id`, `source`∈{startup,resume,clear,compact}, `cwd`, `transcript_path`, `agent_type?`, `session_title?` | Authoritative — Claude tells us | `active` (or resumes a `dormant`/expired row) |
| **Import (dormant)** | Directory listing of `~/.claude/projects/<slug>/*.jsonl`; each filename stem **is** the session UUID; `cwd` recovered from the `<slug>` and file mtime = last-seen | Documented layout; metadata-only | `dormant` |
| **Unmanaged detection** | OS process table: a live `claude`/node process with a session id we have **no** SessionStart signal for | Heuristic — labelled as such | `unmanaged` (never fabricated as managed) |

- **Forks:** a fork fires SessionStart `startup` with a **new** `session_id` → registered
  as a new session (new automatic_alias via the beta.4.1-safe path). If the hook input
  carries a documented parent linkage field, it is stored as `forked_from` (diagnostic
  only); if not, the fork is simply a new identity with no inheritance. **We never infer
  fork parentage by reading transcript contents.**
- **What we NEVER do:** parse/modify `*.jsonl` transcript bodies, read Claude's internal
  config/state beyond the documented `~/.claude.json` + `~/.claude/settings.json` we
  already own (ADR 0018), or claim retroactive registration for a session that never
  fired a post-install SessionStart (ADR 0013 D6).

Import is explicitly **best-effort + read-only**: a session we can list but not fully
attribute is recorded as `dormant` with `identify_confidence='listing_only'`; a live
process we can't map is `unmanaged` with `identify_confidence='unidentified'`.

---

## Q2 — How are dormant / unmanaged / disconnected / expired distinguished?

These are **two orthogonal axes**, not one enum — conflating them is the trap. We store
both and derive the dashboard label from the pair.

- **Axis A — `management_state`** (does XBus manage this session, and how was it learned?):
  `unmanaged` → `dormant` → `active`.
- **Axis B — `readiness`/connection** (the existing ADR 0012 `readiness.ts` model, only
  meaningful when `management_state='active'`): `initializing`, `ready_checkpoint`,
  `ready_live`, `degraded_*`, `disconnected`.
- Plus the existing **retention tombstone** `expired_at` (ADR 0012 D6) and name lifecycle.

### Decision table (authoritative — implemented as a pure function, unit-tested)

| management_state | connection/readiness | expired_at | last activity | **Dashboard label** | Routable? |
| --- | --- | --- | --- | --- | --- |
| `active` | `ready_checkpoint`/`ready_live` | null | recent | **active — ready** | yes |
| `active` | `initializing`/`degraded_*` | null | recent | **active — starting/degraded** | no (yet) |
| `active` | `disconnected` | null | recent | **active — disconnected** (owner went away this session) | queued |
| `dormant` | — | null | from transcript mtime | **dormant** (known, not live) | no |
| `dormant`/active | — | **set** | >15d | **expired** (tombstoned; ADR 0012) | no |
| `unmanaged` | — | — | — | **unmanaged** (detected, no XBus signal) | no |

Key distinctions made explicit:
- **disconnected ≠ dormant:** `disconnected` = an *active-this-session* owner whose IPC
  link dropped (rejoins on reconnect, keeps epoch); `dormant` = a session from a *prior*
  run, imported from transcripts, never connected this broker lifetime.
- **dormant ≠ expired:** `dormant` is pre-15-day and can activate on `resume`; `expired`
  is the retention tombstone (`expired_at` set) — resume routes through the existing
  expired-resume path (fresh epoch, no resurrection).
- **unmanaged ≠ everything else:** the only label NOT sourced from the broker/ledger —
  it's a live-process heuristic, always rendered with an explicit "detected; not managed"
  qualifier, and can never transition to `active` without a real SessionStart signal.

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
The current state is always recoverable from the mutable tables alone; the ledger adds
auditability, not correctness of routing.

Why not make the ledger authoritative (event-sourced)? Rejected for Phase 1: it would
duplicate the proven ADR 0003 receipt/epoch state machine, add replay complexity, and
risk the Layer-3 injection invariants. The mutable tables stay the single source of
truth; the ledger is the audit lens over them.

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
  --before <utc>` archives events `< N` to a JSONL export file, writes a `ledger_anchors`
  row `(anchor_seq=N-1, anchor_hash=…)`, then deletes the archived rows **inside one
  transaction** (the triggers are bypassed only by this audited maintenance path, gated
  behind an explicit flag + a ledger event recording the vacuum). Post-vacuum the chain
  verifies from the anchor forward (genesis pointer = the anchor). Nothing auto-prunes.
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
| Ledger write fails but state txn must proceed | txn aborts as a unit | the whole broker op fails cleanly (typed error) rather than committing state without its audit event — state+ledger are all-or-nothing |
| DB newer schema than build | existing downgrade guard (ADR 0019) | fail closed; no partial serve |
| Ledger disk-full | insert error inside txn | op fails with a clean typed error; no partial/ghost state |

Chain-broken never blocks message delivery (Q3 separation) — it degrades **auditability**
visibly, not correctness.

---

## Q5 — Dashboard: read-only, loopback-only, single-instance, cannot destabilize delivery

Enforced by **construction + assertions + tests**, not policy:

1. **Read-only (Phase 1):** the dashboard HTTP server exposes **only `GET`** endpoints
   (`/api/sessions`, `/api/ledger`, `/api/session/:id`, SSE `/api/stream`, `/alive`).
   There are **no mutating routes in Phase 1** (rename/compose arrive in Phase 2/3). A
   route-table test asserts every registered handler is `GET`/`HEAD`. Reads use a
   **read-only SQLite connection** (`readOnly:true`), so the dashboard process physically
   cannot write the DB (I4: broker remains single writer). A write attempt on that
   connection throws — asserted by test.
2. **Loopback-only:** binds `127.0.0.1` exclusively; a startup assertion refuses any
   non-loopback address (ADR 0018). Token required on every request (owner-ACL'd);
   loopback is not treated as trust. Test: a bind to `0.0.0.0` throws; a request without
   the token gets 401.
3. **Single-instance:** the **broker** owns the one HTTP server (broker is the machine
   singleton, ADR 0015). Port + URL recorded in `broker.state.json`. A second start finds
   the running dashboard and does not open another (debounced browser-open + `/alive`
   heartbeat → no tab storm). Test: two `ensure-dashboard` calls → one listener, ≤1
   browser open.
4. **Cannot destabilize delivery:** the dashboard runs **read-only against a separate
   connection** and issues **no broker mutations** in Phase 1, so it cannot touch routing,
   epochs, receipts, or the injection ledger. The SSE stream is a fan-out of already-
   committed state (poll/notify), never a write path. Even a hung/abusive dashboard
   client cannot block the broker's IPC event loop: the HTTP server has its own request
   timeouts + a bounded response size, and a slow client is dropped. Test: hammer the
   dashboard with concurrent reads while the four-replica matrix runs → matrix still
   12/12, broker instance unchanged, zero delivery impact.

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
