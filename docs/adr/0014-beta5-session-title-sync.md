# ADR 0014 — Beta.5: session title synchronization (XBus alias ↔ Claude Code title)

**Status:** Proposed · **Date:** 2026-07-12 · beta.5. Companion to ADR 0013.

## Context

The dashboard lets an operator rename a session. There are two names in play:
- the **XBus alias / session name** (ADR 0012), which XBus fully owns; and
- the **Claude Code session title** (what `/rename` sets, shown in Claude's UI),
  which XBus does NOT own.

The goal asks: rename in the dashboard, change the XBus alias immediately, and
"research supported synchronization with the actual Claude Code title." We must not
edit undocumented Claude files.

## Researched constraint (authoritative)

Claude Code exposes title control through the **SessionStart hook only**:
`hookSpecificOutput.sessionTitle` sets the title and is **"equivalent to `/rename`"**,
but the docs state it **"applies only when `source` is `startup` or `resume`."** There
is **no documented API to change a running session's title mid-session** — no hook
event other than SessionStart carries a title-write, and the transcript/config files
are undocumented and off-limits.

## Decision

1. **XBus alias rename is immediate and authoritative.** A dashboard rename updates the
   XBus session name synchronously via the existing `rename_session` broker op
   (`store.renameSession`, atomic, unique-index guarded, ADR 0012 D4). This never
   depends on Claude.

2. **Claude title sync is deferred to the next SessionStart.** Because mid-session title
   mutation is unsupported, when the operator sets a desired Claude title we:
   - persist it as `desired_session_title` on the session row (new column, ADR 0019);
   - mark the sync state **`sync_pending`** and show that in the dashboard
     ("title will apply on next resume");
   - on the next `SessionStart` with `source ∈ {startup, resume}` for that session, the
     SessionStart hook emits `hookSpecificOutput.sessionTitle = desired_session_title`
     and, on success, flips the sync state to **`synced`** and records the applied title.
   - `session_title` **in** the hook input lets us detect drift (user renamed via
     `/rename`): we store the observed title and, if it differs from desired with no
     pending operator change, mark **`synced` (external)** rather than fighting it.

3. **We never edit undocumented Claude files** and never claim the title changed
   mid-session. The dashboard is explicit: alias = immediate; Claude title = pending
   until resume.

## Sync-state model

`none` (no desired title) · `sync_pending` (operator set a title; awaiting resume) ·
`synced` (applied at SessionStart) · `synced_external` (user changed via /rename;
observed, not overridden). All transitions are ledger events (ADR 0016).

## Impact

- Additive columns only (`desired_session_title`, `observed_session_title`,
  `title_sync_state`); schema bump via ADR 0019.
- No protocol/STP change. Compatible with sessions that never set a title (state `none`).
- If Claude later adds a mid-session title API, this design swaps the deferred path for
  an immediate one without changing the dashboard contract.
