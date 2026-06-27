# ADR 0009 — People-facing scheduling states (enforced before the retry engine)

**Status:** Accepted · **Date:** 2026-06-25 · Extends ADR 0005.

## States + behavior (receiver-side, gates delivery)
- active: normal automatic checkpoint delivery.
- paused: checkpoint pull returns nothing; message persists `queued`; NO delivery
  attempt consumed; NO retry backoff advance; resume re-enables.
- do_not_disturb: automatic delivery suppressed; inspectable via inbox peek.
- manual_checkpoint: no automatic injection; `xbus process-next` injects exactly one.
- blocked sender: send REJECTED before persistence (`XBUS_BLOCKED`) — never normal success.

Encoded in `session_controls` + `blocked_peers` (migration v3). Enforced in
`DeliveryOps.checkpointPull` (auto gate) and `BrokerStore.send` (block check) —
BEFORE any retry/dispatch logic, so the reliability engine inherits the policy.

Commands: pause/resume/dnd/block/unblock/inbox wired to broker frames;
process-next/takeover contracts reserved. Tests: scheduling-states.test.ts.
