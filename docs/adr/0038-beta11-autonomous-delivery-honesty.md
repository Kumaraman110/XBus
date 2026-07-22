# ADR 0038 — Beta.11: durable queueing is not autonomous delivery (routing honesty)

**Status:** Accepted for beta.11 · **Date:** 2026-07-22 · Builds on ADR 0025 (idle-wake + scheduling),
ADR 0036 (activation consistency), ADR 0037 (durable reclaim + activation). Additive; **no schema,
wire, or protocol change** (compatibility tuple stays `xbus-p1-stp1-s11`).

## Context — the defect

AgenTel sessions were producing user-facing messages like:

> My XBus is hook-only this session, so delivery lags — if you see "message waiting" and I say the
> inbox is empty, it is the checkpoint delay, not a miss; the messages are durable and surface on the
> next tick.

Two things were wrong, and neither is "durability" (the durable queue is correct):

1. **`ready_checkpoint` conflated two different guarantees.** An idle MCP-connected session is stored
   `readiness=ready_checkpoint` (`readiness.ts`), which put it in `READY_STATES` — so it was marked
   *routable* on the dashboard (`read-model.ts:deriveSessionLabel`) and *wake-eligible* for the broker
   (`store.hasEligibleDelivery`). But whether that idle session *autonomously reaches a checkpoint*
   depends on the resident `asyncRewake` rewaker (`rewaker.ts`, `hooks/hooks.json`) actually firing —
   which is **host-dependent and NOT guaranteed by the Claude Code docs**. Checkpoint-capable was
   being sold as "will consume on its own."

2. **The activation diagnostic was injected into the model's context** (`checkpoint-hook.ts` →
   `additionalContext`), which is where an agent learned to *narrate* hook-only/next-tick internals
   to the user. That is an operator concern, not the product experience.

### Ground truth on the platform wake capability (why this is HYBRID, not "just a bug")

A documentation review (Claude Code hooks) plus an adversarial refutation established: `asyncRewake`
"wakes Claude on exit code 2" and there is a docs section titled *"Waking an Idle Session from an
External Process"* — but the docs do **not** guarantee it wakes a **truly cold-idle interactive**
session, do **not** document background-process residency, and prior empirical testing
(`reference_cc_bedrock_capabilities`) showed idle-wake **did not fire** in headless/Bedrock mode. So:

- **Fixable in beta.11 (implementation defects):** the *honesty* of classification, delivery-state
  reporting, routing policy, self-heal-where-the-lifecycle-permits, dashboard/status parity, and
  removing model-facing narration.
- **Platform limitation (state honestly, do not fake):** true zero-touch injection into a cold-idle
  *interactive* `claude` session is not guaranteed. The strongest *real* autonomous consumption path
  is the existing opt-in `managed_spawn` (headless `claude --bg`, ADR 0025).

This is presumptively a **RELEASE_READY blocker** (the core AgenTel value is autonomous coordination),
resolved by making the product *honest and adaptive* about the limitation rather than by faking a wake.

## Decision

### D1 — Outward RoutingClass (derived, not stored; single source of truth)

`src/broker/routing-class.ts` adds a pure `deriveRoutingClass(readiness, connection, expired,
wakeProbe, autoDelivery, receiveControl)` → one of:

| RoutingClass | Meaning | Auto-routable? |
|---|---|---|
| `ready_live` | push transport, consumes immediately (not on Bedrock today) | yes |
| `ready_wakeable` | idle, but a **proven** host wake path exists | yes |
| `degraded_checkpoint_only` | checkpoint hook works, but autonomous wake is unproven/unavailable (or manual-drain) | **no** |
| `unavailable` | no verified consumption path (disconnected / incompatible / expired / ack-or-hook-missing / paused / DND) | no |
| `pending_activation` | activation still establishing | no |

`ready_wakeable` is awarded **only** when `wakeProbe.proven === true`. The honest default (no proof)
is `degraded_checkpoint_only`. **Both** the dashboard (`read-model.ts`) and the MCP tools
(`xbus_sessions`, `xbus_status`, `send_message_ack` via `daemon.ts`) derive the class from the **same
pure function over the same columns**, so they cannot disagree (parity — closing the observed bug
where a disconnected session still reported `ready_checkpoint`). `manual_checkpoint` is
operator-drainable, so it maps to `degraded_checkpoint_only` (not `unavailable`).

### D2 — Sender-facing DeliverySignal (honest lifecycle word)

`deriveDeliverySignal(deliveryState, wakeOutcome)` → `queued | wake_requested | wake_failed |
injected | acknowledged | replied | failed | expired`. A merely-stored message is **`queued`**, never
"delivered". `injected` (`transport_written`), `acknowledged` (`accepted`), and `replied` (`completed`)
map from **distinct existing DeliveryState members**, so stored/injected/acked are always
distinguishable without overloading a field. `send_message_ack` carries `routingClass`,
`autonomouslyRoutable`, and `deliverySignal` **additively** (raw `readiness`/`state` preserved for
older readers — no payload-shape break).

### D3 — Wake-probe: broker-owned, recorded, version-bound

`src/broker/wake-probe.ts` holds a host wake-probe (`WakeProbeStore`). It is **broker-owned** — no
wire frame writes it, so a client cannot assert wakeability (security review MAJOR-2). A `proven`
result is honored only if observed on the current `claude --version` (a CC upgrade downgrades a stale
proof to unproven → re-probe). Until a dedicated `doctor` idle-wake probe records proof,
`ready_wakeable` is unreachable — the product tells the truth by construction.

### D4 — Routing policy (honest-queue default)

- **Delay-tolerant** messages queue durably (unchanged send success semantics).
- The sender is always told the exact `deliverySignal` + whether the recipient is
  `autonomouslyRoutable`. Never "delivered" before injection; never "will surface on the next tick"
  as if that were autonomous delivery.
- **Time-sensitive** work to a non-`autonomouslyRoutable` target is **not** silently queued: the
  sender receives a precise non-delivery signal and may hold, reroute (a sender decision — see
  security note), or opt into delay-tolerant delivery.
- `managed_spawn` remains **opt-in and operator-driven** — it is NOT auto-triggered by a peer send
  (security review BLOCKER-2), and a peer message can never cause process creation.
- **Auto-reroute of a message *body* to a broker-chosen session is forbidden by default** (security
  review BLOCKER-1: global name resolution + self-declared capabilities = a confidentiality/identity
  regression). Beta.11 emits an honest non-delivery + reroute *hint*; broker-selected body reroute is
  out of scope.

### D5 — Self-heal (bounded, lifecycle-limited)

`src/channel/self-heal.ts` is a **pure, bounded planner**: on a path that is executing (eager-register
/ tool call), if the MCP↔broker channel is missing/stale it decides `attempt` (bounded, exponential
backoff) → the **existing gated** `ensureBroker` + `register()`/`resolveReclaim` re-establishes
identity and readiness (owner-secret + proven-liveness + epoch — unchanged, never a cached-authority
or map-edge fast-path; post-reconnect readiness defaults to `initializing`, capability-derived, never
force-ready — security review M1/M3). On exhaustion it yields `degrade` (stop autonomous routing;
surface to operator/logs) — never a spawn, never a reroute, never a retry storm. True cold-idle
interactive injection is **not** claimed when the platform cannot guarantee it.

### D6 — Narration removal

The activation diagnostic now goes to the hook's **stderr** (operator/logs), never the model's
`additionalContext`. `instructions.ts` explicitly forbids agents from explaining checkpoint timing /
hook-only status / delivery-lag internals to the user; agents report task **status** and precise
outcomes instead.

## Consequences

- **Positive:** the product is honest — a session is only advertised autonomously routable when a
  verified consumption path exists; senders get a truthful delivery lifecycle; operators (not end
  users) see the transport diagnostics; no security guarantee is weakened.
- **Negative / accepted:** on Bedrock today `ready_wakeable` is unreachable (asyncRewake idle-wake
  unproven) → healthy idle sessions read `degraded_checkpoint_only` and time-sensitive autonomous
  routing to them is declined rather than faked. That is the honest state; closing the gap needs a
  recorded per-host idle-wake probe (and/or opt-in `managed_spawn`), each RED-first + reviewed.

## Compatibility & data safety

Additive only: `migrations.ts` is byte-identical to the shipped beta.10 baseline (`1a00fff`),
`SCHEMA_VERSION` stays 11, the compatibility tuple stays `xbus-p1-stp1-s11`. RoutingClass and
DeliverySignal are outward derived strings, not `readiness`-enum or `DeliveryState` members. Wake
attempts are recorded on the existing `audit_events` table (safe-metadata only; no body/secret).
`send_message_ack` gains fields but keeps its existing ones, so older readers are unaffected. No
migration, upgrade, or rollback runbook is required.

## Cross-refs

ADR 0025 (idle-wake + managed_spawn), ADR 0036 (activation consistency), ADR 0037 (durable reclaim),
`docs/delivery-semantics.md` (§ Wakeability), `reference_cc_bedrock_capabilities` (idle-wake not
proven headless/Bedrock).
