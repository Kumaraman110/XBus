# Injection crash windows + duplicate policy (reliability contract §6)

**Duplicate boundary = CONTEXT INJECTION**, not a DB row. The dangerous duplicate is
the same peer request appearing in Claude's context twice.

**Honest policy: AT-MOST-ONCE context injection per (message_id, recipient_epoch)**,
enforced by `UNIQUE(message_id, recipient_epoch, logical_injection_number)` with
`logical_injection_number=1` for normal delivery. Redelivery requires an explicit
policy that increments the logical number (dead-letter redrive allocates a new
delivery identity, not a silent re-inject). We do **NOT** claim exactly-once: the
Claude runtime provides no injection-acknowledgement primitive, so a crash after
the additionalContext is emitted but before broker confirmation is an unavoidable
ambiguity — classified below.

## Crash-window matrix
| # | Window | Durable outcome | Classification |
|---|---|---|---|
| 1 | broker commits injection lease, crashes before hook response | delivery still `queued`/`transport_written`-not-confirmed; lease expires; on restart the message is eligible again; ledger has no confirmed injection row → re-pull allowed | **safe retry** (no context reached the model) |
| 2 | hook got payload, crashes before marking context_injected | additionalContext was NOT emitted (hook died first) → nothing in model context; lease expires → re-eligible | **safe retry** |
| 3 | hook emitted additionalContext, crashes before broker confirmation | context MAY be in the model; broker has an injection row (written in the same txn as the transport_written CAS) so the ledger uniqueness BLOCKS a second injection for this (message,epoch) | **possible duplicate context** only if the injection row was NOT written before the crash; with same-txn write it is **at-most-once** (re-pull is blocked by the unique index) |
| 4 | Claude received context, MCP ack delayed | normal — ack deadline runs from injection; no re-inject just because ack is slow | **safe** (waiting, not failure) |
| 5 | broker crashes after ack but before responding to MCP | ack receipt is committed durably before the response is sent; on MCP retry the duplicate-ack check returns idempotent `duplicate:true` | **safe retry** (idempotent ack) |
| 6 | MCP retries ack | unique(message,receiver,'ack') receipt → idempotent no-op; conflicting status → rejected | **safe** |
| 7 | session resumes under a NEW epoch after a possible injection | new epoch re-pulls (different recipient_epoch → different ledger key); the OLD epoch's injection cannot be acked (epoch mismatch). If the old epoch already injected+the model acted, the new epoch may see it again → **possible duplicate context across an epoch change** (documented; mitigated because takeover re-queues only un-acked deliveries) | **possible duplicate context** (epoch change) → **manual reconciliation** if it matters |
| 8 | old epoch sends a late ack | rejected (`EPOCH_MISMATCH`), audited, no state change | **safe** |
| 9 | same checkpoint hook fires twice | second `checkpoint_pull_hook` with the same checkpointId → `issue()` returns null (ux_injection_checkpoint) AND the delivery is already `transport_written` so the CAS matches 0 rows → not re-injected | **safe** (deduped) |
| 10 | broker restart between context injection and reply | original delivery is `transport_written`/`accepted` durably; on restart the reply can still be created (the injection + ack receipts survive); reply has its OWN delivery lifecycle | **safe retry** |

## Net
- Within one epoch: **at-most-once** context injection (unique index + CAS).
- Across an epoch change (resume/takeover after a possible injection): **possible
  duplicate context** is the one residual ambiguity → surfaced for **manual
  reconciliation**, never silently retried. Redrive from dead-letter warns when
  history is ambiguous.
- Exactly-once is **not claimed**.
