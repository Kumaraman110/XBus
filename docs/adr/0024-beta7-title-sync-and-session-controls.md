# ADR 0024 — Beta.7: Claude title sync + operator session controls

**Status:** Accepted for Phase-3 build · **Date:** 2026-07-14 · beta.7 · supersedes the
*Proposed* ADR 0014 (which deferred title sync). Grounded in the **documented** Claude Code
hook/CLI surface (confirmed 2026-07-14 against docs.claude.com/en/docs/claude-code).

## Documented Claude Code facts this relies on (verified, cited in PR evidence)

- **`session_title`** is a documented **SessionStart hook stdin** field (present only once a
  title exists via `--name`/`-n`, `/rename`, or plan-accept). A SessionStart hook may also SET
  it via `hookSpecificOutput.sessionTitle` (ignored on `source` clear/compact).
- `--name`/`-n` sets a title at launch; `--resume <id|name>` / `--continue` resume an existing
  session; `--session-id <UUID>` assigns a NEW session's id at launch.
- There is **no** documented way to read/set a Claude session title outside these — so XBus
  captures the title OBSERVE-ONLY from the SessionStart stdin field and NEVER edits an
  undocumented Claude file.

## Decision

1. **`claudeTitle` and `xbusAlias` are stored SEPARATELY** (schema v9): `claude_title` /
   `claude_title_source` / `claude_title_at` are a **fourth, inert display pool**, distinct
   from the three existing name/alias pools (`session_name`/`normalized_session_name`,
   `aliases`, `automatic_alias`). The title is NEVER normalized, unique-indexed, reserved, or
   read by `resolveRecipient`/`aliasForSession` — a peer can never address a session by its
   Claude title. Precedence: a present `session_title` on announce overwrites (latest
   observation wins) with its source (`startup|resume|clear|compact`) + timestamp; an absent
   field never clears a prior title. XBus never claims it *changed* the Claude title — it only
   records what Claude reported; renaming the **xbus alias** is a separate, explicit op that
   leaves `claude_title` untouched.

2. **Capture path:** `session-start-hook` forwards the documented `session_title` → the
   `announce_session` frame (`sessionTitle`) → `store.announceSession` writes the title,
   respecting the tombstone guard. Fail-open (a title-capture problem never blocks Claude).

3. **Operator controls** (OPERATOR-authority store methods + `daemon.operatorControl` dispatch
   + a bearer-gated `POST /api/session/:id/control` route where the target id comes from the
   PATH, not a spoofable body field; each stamps `local-operator` + one ledger event):
   - **rename xbus alias** (`operatorRenameAlias`) — the routable `session_name`, not the title;
   - **pause / DND / manual / active** (`operatorSetControl`) on a *target* session (distinct
     from the self-only `onSetControl`);
   - **pin / unpin, archive / unarchive** — orthogonal lifecycle flags;
   - **remove stale record** (`operatorRemoveRecord`) — deletes the `sessions` row + the tables
     that FK-reference it (aliases, session_instances, recipient_sequences) + the
     thread_participants projection, in dependency order; **KEEPS** messages/deliveries/ledger
     (append-only audit, referenced by value not FK) and **NEVER unlinks the Claude transcript**
     (`transcript_path` is read-only here); refuses a *connected* session and the reserved
     operator principal;
   - **stop-managed** (`clearManagedSession` + `SIGTERM`) — refuses a non-managed session;
   - **launch a named session / resume/attach a managed session** — via the Area-4 managed-spawn
     launcher (ADR 0025), using documented `claude --bg --session-id/--resume --name`.

4. **Managed-session tracking:** `managed_by_xbus` / `managed_pid` / `managed_started_at` /
   `managed_launch_key` mark sessions XBus launched itself, so stop/restart target ONLY
   xbus-managed sessions. Liveness is proven by a **live in-process child handle** the broker
   holds for each child it spawned (keyed by session id, carrying the pid + `launch_key`):
   `stop_managed` clears the DB markers and then `SIGTERM`s the pid **only** when that live
   handle is still present and its pid + `launch_key` match — the sole pid-recycling-safe proof
   that the pid is still *our* child. Without a live handle (the broker restarted since the
   spawn, or the child already exited) XBus does **not** kill a bare pid — it clears the markers
   and reports `killed=false`, so a stale record can never terminate an OS-recycled, unrelated
   process. When a managed child exits (natural or crash) its `exit` handler clears the session's
   managed markers, so a dead session never retains a killable pid. (`managed_started_at` /
   `managed_launch_key` remain the durable idempotent-launch anchor across restarts; the
   cross-process kill authority deliberately does not survive a broker restart — a conservative,
   safe-by-default choice.)

## Consequences

- Positive: the console can show the Claude-native title AND the xbus alias distinctly, without
  ever conflating them or touching Claude internals; operators get real, ownership-bounded
  controls; removing a stale record never destroys a transcript or audit history.
- Negative / accepted: `claude_title` is untrusted display text (escaped on render); it is only
  captured at SessionStart (no mid-session push exists in the documented surface).
