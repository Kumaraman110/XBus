# ADR 0001 — Transport classification (empirical)

**Status:** Accepted · **Date:** 2026-06-25 · **Host:** Windows 11, CC 2.1.186, Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`)

## Context
XBus needs an in-session "receive" leg so an independently-launched Claude Code session can be handed a peer message. The mandate's primary mechanism (Channels) is documented but **silently dropped on Bedrock** (see `docs/research.md` §4, proven 3 ways). We empirically classified every Bedrock-surviving injection mechanism against the strict standard:

> A cross-session bus is proven as **real-time push** only when an **idle** recipient is **automatically scheduled**, processes the message, acknowledges it, and returns a correlated result **without hidden human activity**.

## Empirical results (this binary, not docs)

| Mechanism | Fires on Bedrock? | Wakes a fully **idle** session (no stdin)? | Evidence |
|---|---|---|---|
| Channel (`notifications/claude/channel`) | server connects, **injection dropped** | n/a | model saw no `<channel>` tag; 7 pushes ignored; debug shows channel subsystem inert |
| Monitor | **No** (Bedrock-blocked, documented) | n/a | docs verbatim "not available on Amazon Bedrock…" |
| Hook `additionalContext` on **UserPromptSubmit** | **Yes** | No — needs a user prompt | model quoted injected sentinel back |
| Hook `asyncRewake` + `FileChanged`, exit 2 | watcher didn't fire (stream-json) | **Not demonstrated** | `rw-events-rwA.log`: hook never fired |
| Hook **Stop**-poller, exit 2 | **Yes** | **No** — fires only at a turn boundary | `rw-events-rwS.log`: autonomous reply `IDLE_WOKEN_rwS` at Stop checkpoint; later idle signal → `NO_IDLE_WAKE` |

## Decision
**Receive mode = `hook_checkpoint` (Classification B).** This is the empirically proven floor.

- A `Stop` hook drains the per-session inbox at a turn boundary; the model processes + replies autonomously (no user-typed message content). **Proven.**
- True idle-wake (`hook_push` via `asyncRewake`) is **NOT proven** in the drivable (headless/stream-json) environment — `asyncRewake`+`FileChanged` did not fire, and a genuine interactive TTY could not be driven without a PTY. It is documented and not Bedrock-gated, so it is retained as a **future, human-TTY-validated** capability — **not** claimed now.

### Consequences (binding, per the receive-mode contract)
- Build **ChannelTransport** (first-class; `BLOCKED_BY_PROVIDER` at runtime here) **+ HookCheckpointTransport**.
- `xbus_send` to a `hook_checkpoint` recipient returns state **`queued_until_checkpoint`**.
- The acknowledgement timeout does **not** start until actual model injection (the hook fired and emitted the message), not at enqueue.
- Queued messages persist until the next eligible checkpoint or TTL expiry.
- Never label this transport "real-time push"; never claim it wakes an idle session.
- `xbus sessions` / `xbus status` / `xbus send` must surface the true receive mode; never silently downgrade.

### Preference order (capability-detected, no silent downgrade)
1. `channel_push` — ChannelTransport where the provider supports it.
2. `hook_push` — only if idle-wake is empirically proven (NOT yet; needs human TTY validation).
3. `hook_checkpoint` — Stop/UserPromptSubmit boundary delivery. **← active on this host.**
4. `poll_only` — MCP `xbus_inbox` polling when hooks give notification only.
5. `disconnected` — none available.
