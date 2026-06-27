# ADR 0006 — Non-secret injection reference (remove bearer token from model context)

**Status:** Accepted · **Date:** 2026-06-25 · Supersedes the bearer-receipt part of ADR 0003 §3.

## Problem
ADR 0003 delivered a one-time **bearer** receipt capability inside Claude's
injected context. Model context is persisted to session JSONL, may appear in
`/export`, verbose/debug logs, compaction, and resumed context, and the model can
echo it in replies. **A bearer token in model context must be treated as
observable** — so it is not a sound authorization secret. (By construction the
raw token is written into the transcript; we do not rely on it staying secret.)

## Decision — capability is bound to the authenticated connection, not a bearer token
The model-visible part of an injection is a **non-secret reference**:
`message_id` + `injection_id` (+ `checkpoint_id`). These are safe to log/persist.

`xbus_ack` / `xbus_reply` no longer carry a bearer receipt. The **MCP server adds
authentication privately, from its own authenticated broker connection** — the
broker already knows, per connection: authenticated `sessionId`, `activeEpoch`,
the MCP `componentInstanceId`, and role. The broker authorizes the operation only
when ALL hold:
1. the injection record (`injection_id`) exists;
2. the message was actually context-injected (`transport_written` recorded);
3. the injection's `recipientSessionId` == the caller connection's authenticated session;
4. the injection's `recipientEpoch` == the session's current epoch;
5. the caller's component role is `mcp` (per the capability matrix);
6. the operation is permitted and the delivery state is compatible;
7. the injection is not expired and not already consumed incompatibly.

Crucially: **the model-visible `injection_id` is NOT sufficient by itself.** A
different process/session presenting the same `injection_id` fails check (3)/(4)
because its connection authenticates as a different session/epoch. The id is a
*reference*, the connection identity is the *authority*.

`xbus_ack`/`xbus_reply` accept an optional `injectionId` (the non-secret
reference, used to disambiguate when multiple messages are in flight); if absent,
the broker resolves the injection by `(messageId, recipientSession, currentEpoch)`.

## Consequences
- The injected fence header carries `injection_id=` (non-secret) instead of
  `receipt=` (secret). Safe in transcripts/exports/logs.
- `context_injections.receipt_capability_hash` is retained but no longer the
  authorization path; it becomes an optional defense-in-depth binding (NULLABLE).
  Authorization is connection-identity + injection-record based.
- New error `XBUS_INJECTION_NOT_FOUND`; `XBUS_NOT_RECIPIENT`/`XBUS_EPOCH_MISMATCH`
  cover cross-session/cross-epoch attempts.
- Security tests updated: presenting another session's `injection_id` from a
  different connection is rejected; a completed/expired injection is rejected;
  cross-epoch is rejected. A leaked `injection_id` grants nothing without the
  authenticated connection.

## Why not keep a hardened bearer token
We could (short expiry + one-time + hash-only), but it still must transit model
context, so it can never be more trustworthy than "observable". Binding to the
already-authenticated connection removes the secret from the threat surface
entirely — strictly better. The bearer path is removed, not merely hardened.
