# ADR 0008 — One writable owner per logical session (split-brain prevention)

**Status:** Accepted · **Date:** 2026-06-25

## Decision
At most ONE live writable (`mcp`-role) component per session epoch. A second
concurrent `mcp` registration on a different connection (e.g. the same session
resumed in another terminal while the first is still active) is rejected with
`XBUS_SESSION_ALREADY_ACTIVE`. Safe next actions are surfaced: use
`--fork-session`, close the existing owner, or `xbus takeover <session>`.
Ephemeral `hook` components coexist with the live `mcp` owner (same epoch).

A clean disconnect (onConnClose marks the component `closed`) lets the next `mcp`
register reuse the epoch. An explicit takeover (`supersede`) advances the epoch
transactionally, fences old components, re-queues in-flight messages, and audits.

The broker never silently picks a winner. Tests: tests/integration/split-brain.test.ts.
