# ADR 0036 — beta.10 XBus activation consistency (launcher / plugin / hooks split-state)

**Status:** Proposed (beta.10 FINAL_CORRECTION_CYCLE, Commit 2; local-only; reviewer-gated). No
schema/protocol/compat change (stays schema 11 / xbus-p1-stp1-s11).

## Problem — the split-state defect
XBus ships two independently-registered surfaces:
- **Hooks** (`SessionStart`/`UserPromptSubmit`/`Stop`), registered user-scoped in `~/.claude/settings.json`.
- **MCP server** (`xbus_*` tools), loaded only when the plugin is loaded (today: `xclaude` passes
  `--plugin-dir`; a bare `claude` does NOT load it).

Because the hooks are user-scoped, a **bare `claude`** launch still fires the `SessionStart` hook,
which announces the session to the broker as a `HOOK` component — **even though the MCP server never
loaded**. The result is a dishonest "split state": the bus shows the session present, but the
session has NO `xbus_*` capability. Silently presenting hook-only operation as normal XBus is the
defect this ADR closes.

## Capability finding (Claude Code, 2026 — researched)
Persistent, reversible registration IS supported:
- `enabledPlugins` in `~/.claude/settings.json` (`{"enabledPlugins": {"xbus": true}}`) makes a
  plugin (its MCP server + hooks) load on a NORMAL `claude` launch; reversible by editing the key.
- `claude mcp add --scope user` persists an MCP server in `~/.claude.json` (pre-trusted).
Caveats: (a) project-scoped `.mcp.json` is gated behind a workspace-TRUST prompt (stays pending in
untrusted folders); (b) `CLAUDE_CODE_SESSION_ID` is not a broadly-documented env var (XBus relies on
its runtime presence today — unchanged here); (c) PATH-shadowing the system `claude` is
discouraged/unsupported — `xclaude` as a SEPARATE command is the correct pattern.

## Decision — fallback branch (retain `xclaude` canonical + make absence unmistakable)
For this final correction cycle we take the directive's explicit fallback (persistent enablement is
supported but not *safely* adoptable as the DEFAULT within these constraints — the trust-gate
friction + the session-id caveat + the "tight, two-reviewable-commits, no behavioral surprise" scope
argue against silently switching everyone's activation model). So:
1. `xclaude` remains the CANONICAL launcher (separate command; never shadows system `claude`).
2. Plugin-absence is made UNMISTAKABLE — detected + surfaced, never silent.
3. The persistent `enabledPlugins` path is DOCUMENTED + offered by the installer as an opt-in
   (`xbus install --persistent` / doctor guidance), not forced — so a user who wants zero-wrapper
   launches can opt in, with clean uninstall.

## Activation states (first-class, surfaced by `xbus doctor` + at session start)
- `CONNECTED` — MCP server loaded + broker reachable + session registered as an mcp component.
- `PLUGIN_NOT_LOADED` — the MCP server did not load this session (bare `claude` without the plugin).
  **Detected at the Stop hook, NEVER at SessionStart.** RATIONALE (do not "optimize" back to
  SessionStart): store.ts:700-708 documents the registration-order race — the lifecycle HOOK
  registers at SessionStart BEFORE the MCP server's registration arrives (ms-to-seconds later). So a
  SessionStart-time "no mcp component → PLUGIN_NOT_LOADED" check FALSE-POSITIVES on every normal,
  healthy launch (a false "run xclaude" that trains users to distrust a correct bus — worse than the
  split-state it fixes). By the first Stop, a plugin-loaded session's MCP has registered if it ever
  will, so a Stop-time check is a true negative for bare `claude` and a true positive for a plugin
  session. Distinguish from MCP_DISCONNECTED using "was there EVER an mcp component for this
  session/epoch" (component_instances role='mcp', ANY state incl. superseded/closed) — NOT the
  live-now `hasLiveMcp`. Emits the diagnostic + exact `xclaude` command exactly ONCE (a per-session
  "diagnosed" marker under dataDir prevents per-checkpoint spam); the session is NOT described as
  connected. `xbus doctor` (human-invoked, off the hot path) may check synchronously — the race is
  long resolved by the time a human runs it.
- `MCP_DISCONNECTED` — plugin loaded (mcp attempted) but the MCP↔broker channel is down.
- `BROKER_UNAVAILABLE` — MCP loaded but no broker is running/reachable (existing error code).
- `DEGRADED_HOOK_ONLY` — retained ONLY as an explicit, reported state (a hook-only session that has
  announced but has no mcp capability) — never presented as normal/connected.

## Detection input must be RELIABLE — eager MCP registration (the lazy-registration caveat)
Deferring detection to Stop dodges the SessionStart connect-LATENCY race, but it introduced a
CONVERSE hazard: the MCP server historically registered its `mcp` component LAZILY (only on the
first `xbus_*` tool call, via ensureBroker). So a healthy, plugin-loaded `xclaude` session whose
FIRST turn calls no tool had NO mcp component by its first Stop → the check misfired a FALSE
`DEGRADED_HOOK_ONLY` ("plugin did NOT load — run xclaude") at a correctly-launched user, and burned
the once-per-epoch emission. "Registered by Stop if it ever will" was FALSE because registration is
tool-triggered, not eager. FIX: the MCP server registers EAGERLY at `notifications/initialized`
(best-effort, non-blocking — a briefly-unreachable broker never wedges the handshake; the tool-call
path still retries), so `mcpComponentPresence(session).ever` is true for every loaded session before
any Stop. A future maintainer must NOT revert to lazy-only registration — the Stop-time detection's
correctness DEPENDS on eager registration making the "plugin loaded" fact true independent of tool use.

## Uninstall removes host-stripped orphans by ENTRY PATH (not just owner tag)
Claude re-serializes `settings.json` and drops the non-standard `_xbusOwner` tag, so a scoped
(installId) uninstall that matched only by tag left an orphaned XBus SessionStart hook — a bare
`claude` then kept announcing hook-only sessions for a removed product (the exact split-state, now
post-uninstall). FIX: on uninstall, `stripHooks` also removes an UNTAGGED handler whose entry PATH
matches THIS install's dist entry (unambiguously ours — a user would not wire our private install-dir
path). A handler bearing a DIFFERENT install's tag, or at a non-XBus path, is preserved.

## Honesty rules
- The hook must NOT report a bare-`claude` session as "connected"; if the MCP marker is absent it
  reports `PLUGIN_NOT_LOADED` with the canonical relaunch command.
- Queued messages for a plugin-absent session are PRESERVED in the durable inbox (dormancy/keying
  semantics unchanged) for delivery after a correct `xclaude` relaunch.

## Installer/uninstaller coherence
Prove management of: plugin activation (opt-in `enabledPlugins`) / launcher integration (`xclaude`
on PATH) / global hooks (user settings) / MCP registration / uninstall cleanup (NO stale XBus hooks
after a successful uninstall unless explicitly retained + reported). Never shadow system `claude`.

## Non-goals
No schema/protocol/compat change; no Stage-3 / cross-machine / multi-user / Codex. Reviewer-gated
(Adversarial: installer safety + no shadowing + state honesty; Reliability: install/launch matrix +
upgrade/rollback/restart). Builder may not self-approve.
