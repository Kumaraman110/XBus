# ADR 0017 — Beta.5: real multi-turn threaded messaging

**Status:** Proposed · **Date:** 2026-07-12 · beta.5. Companion to ADR 0013. Preserves
ADR 0003 receipt authority and the Layer-3 injection invariant (I2).

## Context

Beta.4 messaging is request → ACK → single correlated reply (`messages` with
`correlation_id`, `causation_id`, `parent_message_id`; `delivery.ts` reply path). The
goal wants **real multi-turn threads** — "do not stretch one-shot reply receipts" —
with `threadId`, `parentMessageId`, `sequence`, sender, recipient, author type, body,
timestamps, state, correlation; ordering, idempotency, unread state, backpressure,
limits, explicit redelivery, and **zero automatic duplicates**; while preserving
beta.4 request/ACK/reply compatibility. Dashboard-sent messages must use a distinct
**local-operator** identity; Claude messages stay attributable to the real session.

Ground truth: `messages` already has `parent_message_id`, `correlation_id`,
`causation_id`, `recipient_sequence` (a per-recipient global sequence, NOT per-thread);
Layer-3 dedup keys on `(message_id, recipient_epoch, logical_injection_number)`.

## Decision

1. **Threads are a first-class table, not stretched receipts.** New `threads`
   (`thread_id` UUIDv7 PK, `created_by` actor, `subject`, `participant_a/_b` or a
   participants join, `created_at`, `state`) and a `thread_id` + **`thread_sequence`**
   (monotonic per thread) on `messages`. A thread groups the ordered turns between two
   participants (extensible to N later). `correlation_id` = `thread_id` for thread
   messages (so beta.4 correlation tooling still groups them); `parent_message_id`
   points at the specific turn being answered.

2. **Continuity with beta.4.1 semantics (within the all-s7 fleet — NOT mixed-version).**
   A classic request/ACK/reply is modeled as a **degenerate thread** created implicitly:
   the request opens a thread (`thread_id` = request `message_id` = `correlation_id`,
   matching today), the reply is turn 2. This preserves the *shape* of the existing
   semantics so beta.4.1 correlation tooling and the existing tests still make sense —
   **but note (correction 2026-07-12): this is NOT cross-version interop.** Threads ship
   in **Phase 2**, on an all-beta.5/s7 fleet reached via the ADR 0019 whole-install
   upgrade; the handshake fails closed on any s6↔s7 mismatch, so there is no beta.4.1
   client exchanging messages with a beta.5 broker. New multi-turn frames
   (`thread_send`, `thread_list`, `thread_read`) are additive on the s7 wire; existing
   register/send/ack/reply frames are unchanged (so an all-s7 fleet's non-thread paths are
   byte-identical to beta.4.1's). "No frame removed or repurposed" is about **forward
   evolution of the s7 protocol**, not about running mixed s6/s7 components.

3. **Author type = attribution.** Each message carries `author_type ∈ {claude,
   operator}`. Claude session messages are attributed to the real `sender_session_id`
   (unchanged). Dashboard-composed messages use a distinct reserved local-operator
   identity (`operator` author + a reserved `operator` alias/session marker) so the
   ledger + dashboard never misattribute a human-sent message to a model session.

4. **Ordering + idempotency.** `thread_sequence` gives total order within a thread
   (assigned by the broker, the single writer, inside the send transaction — no gaps,
   no client-chosen sequence). Idempotency reuses the existing `idempotency_key`
   dedup-before-authorize path (delivery.ts) — a retried thread turn no-ops, never a
   duplicate row. **Zero automatic duplicates**: Layer-3 injection invariant (I2) is
   unchanged; each turn's body is injected once with an injection id; only explicit
   `xbus_redeliver` re-presents (audited, warned).

5. **Unread state.** Per (recipient, thread): `unread_count` / `last_read_sequence`
   derived from delivery/ack state (a turn is "unread" until injected+seen or acked).
   Surfaced to the dashboard read-model; not on the wire for beta.4 clients.

6. **Backpressure + limits.** Per-thread and per-recipient caps (max open threads, max
   turns/thread, max unacked, body-size limit reusing the existing `PAYLOAD_TOO_LARGE`
   / reserved-key validation in `schemas.ts`). Over-limit → a clean typed error
   (`PROTOCOL_VIOLATION`/`BACKPRESSURE`), never a crash or silent drop. The reaper's
   ack-timeout/dead-letter handling extends to thread turns (non-ACK turns stay off the
   ack-timeout path, I3).

7. **Delivery states unchanged**: a thread turn is a message; it flows through the same
   queued→transport_written→…→completed/failed/expired/dead_letter states, each
   transition ledgered (ADR 0016).

## Impact

- Schema: new `threads` table + a `thread_participants` **join-table** (see below) +
  `thread_id`/`thread_sequence`/`author_type`/unread columns on `messages`; migration +
  downgrade guard (ADR 0019). Existing single-reply flow maps onto degenerate threads
  with no behavior change **within the all-s7 fleet** (there is no mixed-version peer;
  ADR 0019). This is a Phase-2 schema step (a later migration, e.g. 7→8), not Phase 1.
- **Participant model (locked decision):** threads exhibit **two-party behavior** for now,
  but are stored via an **extensible `thread_participants(thread_id, session_id, role,
  joined_at)` join-table** (not two fixed `participant_a/_b` columns), so N-party is a
  data-only extension later with no schema rewrite.
- Protocol: **new optional frames + a capability** on the s7 wire, no change to existing
  frames/STP.
  Compatibility tuple's schema component moves; protocol stays 1.
- Retention/aliases/forks: threads belong to session identities; a fork starts fresh
  (no thread inheritance, ADR 0013 D4); expiry dead-letters a thread's pending turns
  like any message.
- Tests: 100-message threaded-chat harness, ordering, idempotent-retry, unread,
  backpressure, redelivery-not-auto-duplicate.
