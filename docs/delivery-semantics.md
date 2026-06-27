# XBus Delivery Semantics

This document is the authoritative statement of what XBus guarantees about
delivering a message, and — just as importantly — what it does **not**
guarantee. Read it before reasoning about correctness of any flow that depends
on a peer message being processed.

XBus does **not** provide exactly-once *model execution*. It cannot: a model is
a non-deterministic process that XBus does not control, and "the model acted on
this request" is not an event XBus can observe or fence. What XBus provides is a
layered set of dedup guarantees that together make duplicate *model-visible
presentation* of a request impossible on any normal recovery path, while being
honest that an application's own side effects still need their own idempotency.

## The four dedup layers

There are four genuinely different things people mean by "no duplicates." They
live at different layers, have different mechanisms, and fail in different ways.
Conflating them is the most common source of incorrect reasoning about XBus.

### Layer 1 — Durable-row dedup (the sender side)

**Guarantee:** a `send` with the same `idempotencyKey` from the same sender
does not create a second message row.

- **Mechanism:** unique index on `(sender_session_id, idempotency_key)` plus an
  `INSERT … ON CONFLICT` that returns the existing message id. Retrying a send
  that timed out is therefore safe and returns the original `messageId`.
- **Scope:** the durable store. One logical message ⇒ exactly one `messages`
  row ⇒ exactly one recipient sequence number.
- **What it does NOT do:** it says nothing about how many times that one row is
  shown to the receiving model.

### Layer 2 — Context-injection dedup (the receiver's epoch)

**Guarantee:** at most one *context injection* per
`(message_id, recipient_epoch, logical_injection_number)`.

- **Mechanism:** the `context_injections` ledger with a uniqueness constraint
  (migration v4). The hook checkpoint path and the on-demand inbox read both go
  through the same allocation: if an injection row already exists for the
  current `(message, epoch, logical_number)`, no new one is created and no new
  receipt is issued. A repeated checkpoint pull with the same `checkpointId`
  re-surfaces the *same* injection — it does not mint a second.
- **Scope:** one receiving session epoch. If the session is genuinely
  superseded (ADR 0003 — a proven supersede, not a mere component reconnect),
  the new epoch may inject afresh; that is a deliberate, visible recovery, not a
  silent duplicate.
- **What it does NOT do:** an injection row existing does not, by itself,
  guarantee the body was never repeated in tool output — that is Layer 3.

### Layer 3 — Model-visible body dedup (this is §1)

**Guarantee — the strong invariant:** *A normal recovery path must not present
the same peer request body to the receiving model more than once without an
explicit, visible redelivery action.*

This is the layer that protects the model's context window from silent
duplication. It is implemented in `inboxView` / `redeliver`
(`src/broker/delivery.ts`) and is what the §1 tests
(`tests/integration/inbox-dedup.test.ts`) pin.

`xbus_inbox` classifies every pending entry into one of four states and decides
body inclusion from the state:

| State                            | Meaning                                                              | Body in output?                |
|----------------------------------|----------------------------------------------------------------------|--------------------------------|
| `queued_not_injected`            | Durable, never yet presented to this model.                          | **Yes — included exactly once.** |
| `context_injected_unacknowledged`| Already presented once; the model has not yet acked/replied.         | **No.** Returns metadata + `bodyAlreadyPresented:true`, `bodyIncluded:false`, and `allowedActions` (`ack`, `reject`, `reply`, `request-explicit-redelivery`). The body is **not** repeated. |
| `application_accepted`           | The model acked `accepted` (work may be in progress).                | **No.** Not resurfaced as a live request body. |
| `application_completed`          | A reply/outcome has been recorded.                                   | **No.** Terminal. |

So the first read of a new message includes the full body once. A subsequent
recovery read of the same, still-unacked message re-surfaces it (so a model that
did not act in the first turn can still act) **but returns only metadata — never
the body again.** The model is told the body was already presented and is given
the explicit action it can take if it genuinely needs to see it again.

**Explicit redelivery** (`xbus_redeliver` → broker `redeliver`) is the only way
to re-present a body, and it is deliberately heavyweight:

- requires an explicit command from the model/operator (never automatic);
- allocates a **new logical injection number** (history is preserved — the prior
  injection rows are not deleted; the §1 test asserts the ledger goes `[1, 2]`);
- emits an `EXPLICIT_REDELIVERY` audit event;
- returns the body **with a warning** that the receiving model may now process
  the request twice.

There is no normal path — no repeated inbox read, no repeated checkpoint pull,
no reconnect, no broker restart — that repeats a body. Only an explicit
redelivery does, and it announces itself.

### Layer 4 — Application-side-effect idempotency (NOT XBus's job)

**Guarantee:** none from XBus. This is the application's responsibility.

Even with Layers 1–3 perfect, "the model decided to call a tool / hit an API /
write a file in response to the request" is an action XBus neither observes nor
controls. If that action is not itself idempotent, then:

- a legitimate **explicit** redelivery, or
- a model that re-derives the same action from surrounding context, or
- two different epochs that each legitimately process the message

can each produce a duplicate *side effect*. XBus gives the application the tools
to dedup (a stable `messageId`, a stable `correlationId`, the per-message
`injection_id`), but it is the application/model that must use them — e.g. by
keying its own external writes on `messageId`.

## Why we do not claim exactly-once model execution

Exactly-once execution would require XBus to (a) observe the model's internal
decision to act, and (b) atomically fence the side effect with the
acknowledgement. XBus can do neither. What it can do is guarantee that the
*input* (the request body) is presented to the model exactly once on every
normal path, and that any re-presentation is explicit and audited. That is the
honest, defensible guarantee, and it is the one the tests enforce.

> **Summary:** XBus guarantees one durable row (L1), at most one injection per
> epoch+logical-number (L2), and **at most one model-visible body on any normal
> path** (L3). It does **not** guarantee that the model, or the application's
> side effects, run exactly once (L4) — that requires application-level
> idempotency keyed on the stable identifiers XBus provides.

## Readiness — when is it safe to inject?

Dedup answers "how many times is a body shown?" Readiness answers the prior
question: "**should** this session be shown anything yet?" The two are
orthogonal and reported separately (`src/broker/readiness.ts`).

A session has three independent dimensions:

- **Connection** — is a socket attached to the broker right now?
- **Receive mode** — *how* does it take delivery (`hook_checkpoint` on Bedrock;
  a push transport would be `live`)?
- **Readiness** — is it *safe to inject a request it can actually act on*?

A session that has registered but not finished initializing is **connected** but
not **ready**. Injecting a `requires_ack` request into it would arm an ack
deadline the receiver cannot meet. So the broker holds the message durably
queued and reports the readiness honestly rather than pretending the next
checkpoint will deliver it.

| Readiness                    | Meaning                                                        | Injected? |
|------------------------------|----------------------------------------------------------------|-----------|
| `initializing`               | Registered, not yet signalled ready.                           | **No** — held queued; sender sees `queued_receiver_initializing`. |
| `ready_checkpoint`           | Normal Bedrock state: delivery taken at a hook checkpoint.      | **Yes.** |
| `ready_live`                 | Push-capable transport (not available on Bedrock today).       | **Yes.** |
| `degraded_ack_unavailable`   | Cannot acknowledge — no ack capability.                        | **No** — `queued_receiver_degraded`. |
| `degraded_hook_unavailable`  | hook_checkpoint session whose checkpoint hook is absent.       | **No** — `queued_receiver_degraded`. |
| `incompatible`               | Version handshake failed.                                      | **No.** |
| `disconnected`               | No live owner.                                                 | **No.** |

Key invariants (pinned by `tests/integration/session-readiness.test.ts`):

- The broker **derives** readiness from concrete capability hints; it never
  trusts a client that merely asserts `ready`. A component that cannot ack lands
  in `degraded_ack_unavailable`, not ready.
- While **not ready**, a checkpoint pull injects nothing: no `transport_written`,
  no ack timer, no attempt consumed. The message simply waits.
- A message sent *before* the receiver is ready is delivered *after* it signals
  ready — once, on the first ready pull.
- A genuine **supersede** (new epoch) resets readiness to `initializing`: the new
  owner must signal afresh, and a stale prior-epoch signal is rejected. This
  prevents a superseded owner's readiness from leaking into the new epoch.
