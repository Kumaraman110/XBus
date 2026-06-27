# Demo

A scripted, reproducible end-to-end demonstration of XBus.

## Automated dogfood scenario

The most complete demo is the **API contract review** dogfood scenario: two
sessions collaborate over the secure transport on a real engineering task
(detecting breaking changes between two OpenAPI contracts), not a toy echo.

- Walkthrough + synthetic contract fixtures:
  [examples/contract-review/](../examples/contract-review/README.md)
- Run it yourself (regenerates the transcript into a temp dir):

```
npx vitest run tests/e2e/dogfood-contract-review.test.ts
```

It exercises: secure register + alias + readiness signal (§2), a multi-KB request
body delivered intact and shown exactly once (§1), ack acceptance, and a
structured correlated reply.

## Two-terminal manual demo

See [quickstart.md](quickstart.md) for the hand-driven two-terminal version:
register `architect` and `implementer`, send a review request, ack, reply, and
watch the correlated reply arrive.

## What you'll observe

- `xbus_send` returns **after** the message is durably persisted
  (`queued_until_checkpoint`, or `queued_receiver_initializing` if the recipient
  isn't ready yet).
- The receiver sees the body **once**; a second `xbus_inbox` returns metadata with
  `bodyIncluded:false` (no silent duplication).
- `xbus sessions` shows **Connection**, **Receive mode**, and **Readiness** as
  separate columns.
- The reply carries `correlationId` + `causationId` tying it to the original.

## Benchmarks

To see latency/throughput over the encrypted transport on your machine:

```
npm run build && npm run bench
```

Methodology and the honest non-claims: [benchmarks.md](benchmarks.md).
