# XBus beta.5 — control-plane architecture (design for review)

**Status:** Proposed for review · **Date:** 2026-07-12 · version target `0.1.0-beta.5`.
This ties together ADRs 0013–0019. No implementation has begun; this is the design
artifact requested before build.

## One-paragraph summary

After a single user-level install, every Claude Code session for that Windows user
auto-registers at `SessionStart`, a single broker owns a loopback dashboard + an
append-only hash-chained SQLite ledger, the dashboard shows every session's state
(including dormant + unmanaged) and message state, and operators can hold real
multi-turn threads with sessions under a distinct local-operator identity — all while
the XBUS-STP wire and beta.4/beta.4.1 request/ACK/reply semantics stay frozen.

## Component diagram (text)

```
              ┌──────────────────────────────────────────────────────────┐
  Claude ────▶│ SessionStart hook (new)  ── announces session ──▶ broker  │
  session     │ UserPromptSubmit/Stop hook (existing checkpoint delivery)  │
   │          │ MCP server (existing xbus_* tools; register/send/thread)   │
   │  stdio   └──────────────────────────────────────────────────────────┘
   ▼                              │ XBUS-STP over named pipe (frozen)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ BROKER (machine singleton, single writer)                              │
 │  • routing/delivery (existing) + threads (Phase 2)                     │
 │  • SessionStore + LedgerStore (SQLite, WAL, FKs, hash chain)           │
 │  • /auth/exchange (nonce→tab-token; broker/WRITER side)                │
 │  • Dashboard HTTP server (127.0.0.1, token-auth, CSP)                  │
 │      – reads run OFF-LOOP: worker_thread, SQLITE_OPEN_READONLY          │
 │      – live updates via fetch-STREAM/JSON (NOT SSE) ◀── Authorization ─┐│
 └─────────────────────────────────────────────────────────────────────┼─┘
                                                                         │
                                        default browser ◀─ open/focus ───┘
                                        (debounced; no tab storm)
```

## Data model (new + changed; details in ADR 0016/0017/0014)

- **`sessions`** (+cols): `management_state` (unmanaged/dormant/active — see ADR 0020 Q2;
  connection `state` + `readiness` remain SEPARATE existing columns), `source_last`
  (startup/resume/clear/compact/fork/import), `desired_session_title`,
  `observed_session_title`, `title_sync_state`, `forked_from` (diagnostic).
- **`threads`** (new): `thread_id`, `created_by`, `subject`, participants, `state`,
  `created_at`.
- **`messages`** (+cols): `thread_id`, `thread_sequence`, `author_type`
  (claude/operator), unread bookkeeping.
- **`ledger_events`** (new): append-only, hash-chained (`prev_hash`/`entry_hash`, `seq`),
  redacted `payload_json`, UTC — the authoritative audit log.
- **Schema 6 → 7**, forward-only, backup-before-migrate, downgrade-guarded (ADR 0019).

## Control flow — session start

1. `claude` starts → `SessionStart` hook fires (`source` = startup/resume/clear/compact).
2. Hook → `ensureBroker` (starts the one broker if none) → `announce_session`.
3. Broker upserts the session row + ledger event; if resuming a dormant/expired row,
   activates/resumes it (existing expired-resume path).
4. Broker "ensure dashboard": starts the HTTP server once, opens the browser only if
   not already open/recent (debounced).
5. Hook exits 0 regardless (never blocks Claude). MCP server later joins idempotently.

## Security posture (ADR 0018)

Loopback-only bind; owner-ACL'd token required on every request (loopback ≠ trust);
header-token CSRF defense; strict CSP + nosniff + no-inline; zod input validation with
clean typed errors (no DB/500 leak); body-free redacted ledger; fail closed on
newer-than-build schema; uninstall stops broker+dashboard and preserves the audit DB
unless `--purge`.

## Compatibility (ADR 0019)

`xbus-p1-stp1-s6 → -s7`; protocol/STP frozen at 1. **No mixed-version operation:** the
handshake requires equal schema (`checkCompatibility`, `handshake.ts`), so an s6
component meeting an s7 broker fails closed with `upgrade_component`. Beta.5 is therefore
a **single controlled whole-install upgrade** (stop old broker → back up DB/config →
install plugin+hooks+broker → migrate 6→7 → restart), not a beta.4.1↔beta.5 coexistence.
No compatibility-protocol redesign in Phase 1. beta.4/beta.4.1 tags/releases never moved.

## Dependency posture

No new runtime dependencies: dashboard server = `node:http` + hand-rolled router;
UI = static assets served from the plugin dir (no express/bundler at runtime), keeping
the artifact toolchain-free and within the uuid+zod-only bar (package-win
FORBIDDEN_RUNTIME).

## Phased delivery (each = focused PR, own migration/tests/verify:release×2/review)

**Owner-directed sequencing (2026-07-12): session visibility ships FIRST; threaded
messaging comes after.** Phase 1 is the next measurable milestone.

- **Phase 1 (NEXT MILESTONE)** — SessionStart auto-registration of every new/resumed/
  forked session + user-scope-only guard + import→dormant/unmanaged detection +
  append-only hash-chained SQLite audit ledger + **read-only** 127.0.0.1 dashboard
  (all session states, last sent/received, delivery state, ledger timeline). No new
  messaging semantics (beta.4.1 request/ACK/reply unchanged).
- **Phase 2 (deferred, after Phase 1)** — threaded messaging + operator send/read
  (distinct operator identity).
- **Phase 3** — title sync (desired→sync-pending→apply on resume) + security hardening
  + full test matrix (startup/resume/continue/fork, clear/compact, crash/restart, stale
  sessions, duplicate names, 4-session/12-path, 100-message threads, concurrent UI/API
  writes, malformed input, replay, DB recovery, migrations, install/upgrade/uninstall,
  browser behavior, zero loss/dup/cross-routing).

## Decisions — LOCKED (2026-07-12, owner-directed; formerly open questions)

1. **Unmanaged detection = conservative AGGREGATE banner, no invasive process mapping.**
   Phase 1 shows a single "N unmanaged session(s) may exist — resume/restart to manage"
   banner from non-invasive counts; it does **not** read foreign process env/memory to map
   individual session ids (ADR 0013 D6).
2. **Threads = two-party behavior, on an extensible participant JOIN-TABLE.** Ships in
   Phase 2 on the all-s7 fleet; stored via `thread_participants` so N-party is a later
   data-only extension (ADR 0017).
3. **UI = hand-written vanilla HTML/CSS/JS** for Phase 1 (no framework/bundler/build
   step); framework/bundle explicitly out (ADR 0015).
4. **Audit DB preserved by default; explicit `--purge` only** (ADR 0016/0018). A normal
   uninstall stops broker + dashboard and keeps the audit history; only
   `uninstall --purge`/`--remove-data` deletes it (logged as a final ledger event first).

No open questions remain for a Phase-1 go/no-go; the three design blockers are closed in
ADRs 0015/0016/0018/0019/0020 (see the PR #10 correction summary).
