# ADR 0013 — Beta.5: mandatory user-scope control plane, SessionStart lifecycle, and session import

**Status:** Proposed · **Date:** 2026-07-12 · beta.5 architecture note (umbrella).
Extends ADR 0003 (identity/receipt authority), ADR 0008 (split-brain one-owner),
ADR 0012 (zero-friction named sessions + retention). Companion ADRs: 0014 (title
sync), 0015 (browser launch), 0016 (SQLite audit ledger), 0017 (threaded
messaging), 0018 (control-plane security), 0019 (migration + compatibility).

> **Versioning decision (recorded):** this milestone is **`0.1.0-beta.5`**. The
> automatic-alias-collision hotfix is a separate, already-completed **`0.1.0-beta.4.1`**
> bugfix prerelease; beta.5 builds on top of it. The beta.4/beta.4.1 tags and releases
> are never moved or overwritten.

This is the grounding note required **before** implementation. It is written against
the actual code at `origin/main` (`3d78fdee`, includes the beta.4.1 patch), with
file:line citations. It closes
lifecycle/import decisions; per-area decisions live in the companion ADRs.

---

## Context — the beta.5 objective

XBus today is a broker + per-session MCP server + a checkpoint hook, installed at
user scope (ADR 0012). Beta.5 turns it into a **control plane**: after one user-level
install, *every* Claude Code session for that Windows user auto-registers on start,
a single localhost dashboard shows all sessions and their message state, an
append-only SQLite ledger is the authoritative audit record, and operators can send
and read real multi-turn threads from the dashboard.

Frozen invariants that constrain every decision:

- **I1** `compatibilityId` and schema move ONLY with cause and a migration (ADR 0019).
  The XBUS-STP v1 wire bytes/key schedule/vectors (ADR 0010) stay UNCHANGED.
- **I2** every injected body carries a valid injection id; no normal path re-presents
  a body (Layer-3, `delivery.ts`). Beta.5 threads MUST preserve this.
- **I3** epoch/fencing + receipt authority (ADR 0003); **I4** broker is the single
  writer of the store (no second writer, incl. the dashboard — it calls the broker).
- **I5** a failed XBus path NEVER blocks `claude` from starting (ADR 0012 D7).

## Current ground truth (verified in code)

- **Hooks** (`hooks/hooks.json`): only `UserPromptSubmit` + `Stop` are wired, both to
  `dist/channel/hook-entry.js` (`checkpoint-hook.ts`). **No `SessionStart` hook exists.**
- **Session identity**: the MCP server reads `CLAUDE_CODE_SESSION_ID` and
  `register_session`s on first tool use (`channel/server.js`, `mcp-server.ts` ensureBroker).
  Registration is thus **lazy** — a session that never calls an `xbus_*` tool never
  appears. There is no proactive "session exists" signal.
- **Install scope**: `cli/user-scope-config.ts` writes the `xbus` MCP entry to
  `~/.claude.json` and hooks to `~/.claude/settings.json`, ownership-tagged
  `_xbusOwner`. A project/local install path is NOT explicitly denied today.
- **Broker singleton**: one broker per data dir enforced by pipe bind + `broker.state.json`
  (`host.ts`, `singleton.ts`, ADR 0010). `ensureBroker` = connect-or-start.
- **No HTTP server / dashboard** exists; the only listener is the UDS/named-pipe IPC.
- **Sessions table** (`migrations.ts`) already has `session_name`, `session_name_state`,
  `automatic_alias`, `agent_type`, `readiness`, `expires_at`, `expired_at` (ADR 0012).

## SessionStart hook — the authoritative primitive (researched)

Per the official Claude Code hooks docs (code.claude.com/docs/en/hooks), `SessionStart`:
- **Fires on**: `startup` (new session), `resume` (`--resume`/`--continue`/`/resume`),
  `clear` (`/clear`), `compact` (auto/manual compaction) — via the `source` matcher.
- **Inputs**: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`,
  optional `model`, `agent_type` (when `--agent`), `session_title` (current title if set).
- **Output** (`hookSpecificOutput`): `additionalContext`, `initialUserMessage`,
  **`sessionTitle`** (= `/rename`, *applies only when source is startup or resume*),
  `watchPaths`, `reloadSkills`.
- Any stdout text becomes context. The hook can fail without blocking the session.

This is exactly the proactive lifecycle signal beta.5 needs. `session_title` in gives
us the current Claude title; `sessionTitle` out lets us push a desired title — but
only at startup/resume (see ADR 0014).

## Decision 1 — one install mode: user scope; deny project/local

`xbus install` remains user-scope only. **Add an explicit guard**: if invoked with a
project/local scope intent (a `--project`/`--local` flag or a detected project-scoped
`.mcp.json`/`.claude/settings.json` target), fail closed with an actionable message
("XBus is a user-level control plane; install once per Windows user"). Rationale: the
control plane's guarantees (one broker, one dashboard, one ledger, all-sessions view)
only hold if there is exactly one installation per user. Uninstall stays ownership-scoped
(ADR 0018 §uninstall). No new global command; still PATH-free.

## Decision 2 — SessionStart auto-registration for every lifecycle event

Add a `SessionStart` hook (`hooks/hooks.json`, new `dist/channel/session-start-hook.js`)
matching **all** sources. On fire it calls the broker (via the same `ensureBroker`
connect-or-start path, so the first session of the machine starts the one broker) to
**announce the session** with `{session_id, source, cwd, agent_type, session_title,
transcript_path}`. Mapping by `source`:

- `startup` → register a fresh session (or, if `session_id` already exists as a fork
  parent, see D4). Marks it **active**.
- `resume` → reconnect/resume the existing `session_id` (ADR 0012 expired-resume path
  handles a tombstoned one); if it was **dormant** (imported, D5), activate it.
- `clear` → the session id is unchanged; record a `session_cleared` lifecycle event,
  keep it active (clear resets the model context, not the XBus session).
- `compact` → record a `session_compacted` event; no identity change.

The hook is **best-effort and non-blocking** (I5): a broker/IPC failure prints a short
stderr note and exits 0. Registration is now **proactive** — a session appears in the
dashboard the moment it starts, before it calls any `xbus_*` tool. The MCP server's
existing lazy `register_session` becomes idempotent-join for the already-announced id.

## Decision 3 — one broker + one dashboard per startup/resume/fork; no tab storm

Every SessionStart reuses the single broker (D2). The **dashboard** (ADR 0015) is
opened/focused by the broker, not per-hook: the hook asks the broker to "ensure
dashboard", and the broker (single writer, single owner) starts the HTTP server once
and opens the browser **only if** the dashboard isn't already reachable — a
broker-side singleton flag + a "last-opened" timestamp guard prevent a tab storm when
four sessions start within seconds (ADR 0015 §debounce).

## Decision 4 — forks get NEW identities

A forked session (`claude --fork-session` / a fork that yields a new
`CLAUDE_CODE_SESSION_ID`) fires SessionStart `startup` with a **new** `session_id`. It
is registered as a brand-new session (new automatic_alias via the beta.4.1-safe path,
new name lifecycle → likely `pending` if it inherits a taken suggested name). We do
NOT copy the parent's threads/aliases to the fork. If Claude exposes a parent-session
linkage field in the hook input, we record it as `forked_from` metadata (diagnostic
only, never identity). The split-brain guard (ADR 0008) is unaffected: distinct
session ids are distinct owners.

## Decision 5 — import persisted sessions as DORMANT; activate on resume

On install/first-broker-start, scan the Claude projects transcript directory
(`~/.claude/projects/**/<session-uuid>.jsonl`, the `transcript_path` shape from the
hook input) to **import** previously-existing sessions as **`dormant`** rows: known
identity (session_id, cwd/project, last-seen from file mtime, title if recoverable),
but **not connected, not routable, not counted as active**. A dormant session becomes
**active** only when it fires SessionStart `resume` (D2). Rationale: the dashboard
should show the user's real session history (honest "all session states"), without
falsely claiming those sessions are managed/live. Import is read-only over transcript
metadata; we never parse or mutate transcript contents.

## Decision 6 — honesty about ALREADY-RUNNING pre-install sessions

A Claude session that was **already running before XBus installed** did NOT fire a
post-install SessionStart, so XBus has **no hook signal** for it and cannot honestly
claim to manage it. We will **NOT** fabricate retroactive registration. Instead:

- Surface such sessions as **`unmanaged`** in the dashboard when we can detect them
  (e.g. a live `claude`/node process whose session id has no XBus registration and no
  dormant import match), clearly labelled "started before XBus — not yet managed".
- Show the **minimum action** to manage it: "resume or restart this session
  (`/resume` or relaunch) so XBus can register it at SessionStart." No undocumented
  Claude-internal poking.
- Never move an unmanaged session to active without a real SessionStart signal.

Detection is best-effort and explicitly labelled as such; a session we cannot map is
still shown as `unmanaged (unidentified)` rather than hidden.

## Session state model (dashboard-visible)

`unmanaged` (detected, no XBus signal) · `dormant` (imported from transcripts, not
live) · `active` sub-states reuse ADR 0012/`readiness.ts`: `initializing`,
`ready_checkpoint`, `ready_live`, `degraded_*`, `disconnected`, plus name lifecycle
`unnamed`/`pending`/`active`/`retired` and retention `expired`. The dashboard renders
the union; the broker/ledger is the source of truth for everything except `unmanaged`
(which is a live-process heuristic, flagged as such).

## Impact analysis (frozen-invariant + subsystem)

- **Reply semantics / beta.4 compat**: request/ACK/reply frames unchanged; threads
  (ADR 0017) are additive columns + new frames, negotiated so a beta.4/beta.4.1 client
  still works. Layer-3 injection-id invariant (I2) preserved.
- **Retention (ADR 0012)**: dormant/unmanaged do NOT count as meaningful activity;
  import does not reset the 15-day clock. SessionStart `resume` of an expired session
  uses the existing expired-resume path (no resurrection).
- **Aliases**: unchanged; automatic_alias uses the beta.4.1 collision-safe path.
- **Forks**: new identity (D4); no thread/alias inheritance.
- **Ordering / storage**: threads add per-thread `sequence` (ADR 0017); ledger adds
  storage (ADR 0016 §retention/vacuum).
- **Uninstall**: stops broker + dashboard, removes only owned config (ADR 0018);
  **audit DB preserved unless explicit `--purge`** (ADR 0016).
- **Protocol/schema**: schema bump for threads + ledger + lifecycle columns (ADR 0019);
  protocol/STP frozen; compatibility tuple moves only its schema component, with a
  migration + downgrade guard.

## Phased build plan (each phase = its own focused PR)

**Sequencing decision (owner-directed 2026-07-12):** *session visibility ships FIRST,
threaded messaging comes AFTER.* Phase 1 is the next measurable milestone; Phase 2
(threads) does not begin until Phase 1 is merged, released, and validated.

1. **Phase 1 — session visibility (THE NEXT MILESTONE): SessionStart auto-registration
   + read-only localhost dashboard + SQLite audit history.** SessionStart hook (D2)
   auto-registering every **new / resumed / forked** session, user-scope-only guard
   (D1), session import → dormant (D5) + unmanaged detection (D6), the append-only
   hash-chained **SQLite audit ledger** (ADR 0016), and a **read-only** `127.0.0.1`
   dashboard (ADR 0015/0018) showing **all** session states (active/dormant/unmanaged) +
   last-sent / last-received + delivery state, backed by a timeline from the ledger.
   **No new messaging semantics** — reuses beta.4.1 request/ACK/reply unchanged.
   *Measurable acceptance:* start/resume/fork a session → it appears in the dashboard
   automatically (correct source + identity), every lifecycle transition is a
   hash-chain-verifiable ledger event, unrelated config preserved, one broker + one
   dashboard, loopback+token security (ADR 0018), schema 6→7 migration + downgrade guard
   (ADR 0019), verify:release ×2 + adversarial review + a lifecycle test matrix
   (startup/resume/continue/fork, clear/compact, crash/restart, import, unmanaged).
   Ships as a **beta.5.0 / beta.5 prerelease** (exact label at release time).
2. **Phase 2 — threaded messaging + operator send** (ADR 0017), AFTER Phase 1: thread
   schema, thread frames, dashboard compose/read as the distinct local-operator
   identity. Deferred by explicit owner sequencing.
3. **Phase 3 — title sync + hardening** (ADR 0014): desired-title persistence +
   sync-pending + SessionStart `sessionTitle` on resume; security hardening pass;
   full test matrix.

Each phase carries its own migration increment, tests, verify:release ×2, adversarial
review, and PR. Implementation does not begin until this ADR set is reviewed.
