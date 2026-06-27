# ADR 0003 — Component/epoch identity + receipt-capability authority

**Status:** Accepted · **Date:** 2026-06-25 · Supersedes the "generation" authority model from the v3 protocol design.

## Problem (found by the live test)
The original model conflated *logical session*, *generation*, and *component*. A
session's hook and its MCP server are **two different components of the same
logical session**, often connecting separately and (under the old model) each
bumping the "generation". Authorizing `xbus_ack`/`xbus_reply` by "caller belongs
to the current generation" was both too coarse (any current-gen component could
ack) and caused the reconnect-clobber bug.

## Decision

### Identity hierarchy (three distinct levels)
- **LogicalSession** `{ sessionId, activeEpoch }` — the durable Claude session
  (keyed on `CLAUDE_CODE_SESSION_ID`). Addressable identity.
- **SessionEpoch** `{ sessionId, epoch, epochTokenHash, startedAt, supersededAt? }`
  — a lifecycle generation of the logical session. **An epoch changes ONLY when
  the logical session is genuinely replaced / resumed by a conflicting owner /
  explicitly superseded** — NOT when a component reconnects.
- **ComponentInstance** `{ componentInstanceId, sessionId, epoch, role, processId,
  connectedAt, lastSeenAt, capabilities }` — a single connected component
  (`mcp` | `hook` | `transport` | `cli` | `admin`). Many components share one epoch.

Epoch-advance rules (documented lifecycle):
1. First registration of a sessionId → epoch 1.
2. A component registering for an **existing** sessionId **joins the current
   epoch** (does not advance it) when the prior epoch is still live OR no
   conflicting owner exists.
3. Epoch advances (+1, new epochTokenHash) only on an explicit `supersede`
   (same-OS-user, proven) — e.g. `--resume` claiming a session whose prior owner
   is gone, or an operator-forced takeover.

### Receipt-capability authority (replaces blanket current-generation ack)
When a hook/transport injects a message into Claude context, the broker records a
**ContextInjection** and issues a **one-time, opaque receipt capability**
delivered in the message metadata to Claude. `xbus_ack`/`xbus_reply` must present
that capability. The broker validates: exact message, exact recipient session,
**exact current epoch**, recorded injection, allowed op, expiry, replay status,
caller role = `mcp`, compatible state transition. Only a **hash** of the
capability is stored (DB + logs never hold the raw token).

Capability semantics per injection:
- exactly **one** accepted/rejected acknowledgement;
- **zero or one** terminal reply (idempotency-keyed);
- optional partial replies (kept for future; v1 = single terminal reply).

### checkpoint_pull_hook is privileged + connection-derived
The session/epoch is derived from the **authenticated component connection**, not
a caller-supplied sessionId. Restrictions: role must be `hook`; connection must be
current epoch; only eligible (queued/retry_wait) messages for that session;
bounded batch; one checkpointId per invocation; replay-protected; no
cross-session/alias/history/completed selectors; audited.

### Component capability matrix (fail closed)
| Operation | mcp | hook | transport | cli/admin |
|---|---|---|---|---|
| register component | yes | yes | yes | yes |
| send peer message | yes | no | no | admin-opt |
| pull hook checkpoint | no | yes | no | no |
| mark context injected | no | yes | yes | no |
| acknowledge received | yes | no | no | no |
| reply to received | yes | no | no | no |
| list own inbox | yes | bounded | no | admin-diag |
| list all sessions | safe | no | no | admin |
| change aliases | yes | no | no | admin |

Unlisted (role, op) → `XBUS_FORBIDDEN_ROLE`.

## Consequences
- New tables: `session_epochs`, `component_instances`, `context_injections` (migration v2).
- `sessions.generation` is reframed as `active_epoch`; `session_instances` is
  superseded by `component_instances` (kept for back-compat, unused by new code).
- Reconnect no longer clobbers in-flight deliveries (the lease-expiry rule from the
  prior fix stays as the genuine-abandonment path).
- A hook injection and the subsequent MCP ack are the **same epoch, different
  components** — authority flows through the receipt capability, not the component.
