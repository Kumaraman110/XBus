/**
 * BETA.11 (ADR 0038) — OUTWARD routing class + sender-facing delivery signal.
 *
 * THE DEFECT this closes: the internal `Readiness` enum (readiness.ts) answers "is it safe to
 * INJECT a request the receiver can act on?" — and `ready_checkpoint` means "delivery is taken at
 * a hook checkpoint". But a session being *checkpoint-capable* is NOT the same as it being
 * *autonomously wakeable*: whether an idle session actually REACHES a checkpoint without a human
 * turn depends on the resident `asyncRewake` rewaker firing, which is host-dependent and NOT
 * guaranteed by the Claude Code docs (see ADR 0038 / docs/delivery-semantics.md "Wakeability").
 * Reporting a checkpoint-capable-but-unproven-wakeable idle session as plainly "Ready"/"routable"
 * is the dishonesty an operator saw as "hook-only, delivery lags, surfaces on the next tick".
 *
 * THE FIX (additive, no schema change): a PURE, read-time derivation that BOTH the dashboard
 * (read-model.ts) and the MCP tools (xbus_sessions / xbus_status via daemon.ts) call, so they can
 * never disagree (parity). It maps the internal (readiness, receiveMode, connection, a RECORDED
 * per-host wake-probe result, and the auto-delivery control) to an honest OUTWARD class:
 *
 *   ready_live              push-capable transport, consumes immediately (not on Bedrock today)
 *   ready_wakeable          idle but AgenTel has a PROVEN automatic wake path on THIS host
 *   degraded_checkpoint_only the checkpoint hook WORKS, but autonomous wake is unproven/unavailable —
 *                           delivery may require a user-generated checkpoint (or an operator manual
 *                           drain). NOT auto-routed for time-sensitive work unless the sender opts
 *                           into delayed delivery. (Named for what it CAN do — take delivery at a
 *                           checkpoint — NOT "the hook is degraded"; a broken hook is `unavailable`.)
 *   unavailable             no verified consumption path (disconnected / incompatible / expired /
 *                           ack- or hook-capability missing / paused / DND)
 *   pending_activation      activation still being established (initializing / mid-resume)
 *
 * HONESTY IS STRUCTURAL: `ready_wakeable` is awarded ONLY when `wakeProbe.proven === true`. With no
 * proof (the default), a checkpoint session is `degraded_checkpoint_only`, never `ready_wakeable`. We
 * never assume the wake works; we prove it per host or we tell the truth.
 *
 * MANUAL DRAIN: a session in `manual_checkpoint` control is NOT auto-delivered, but an operator CAN
 * drain it on demand (`xbus process-next`). That is a distinct, honest state — `degraded_checkpoint_only`
 * with `manualDrainOnly:true` surfaced separately — NOT `unavailable` (which would erase the exact
 * signal an operator would act on). Only `paused`/`do_not_disturb` fold to `unavailable`.
 *
 * NO WIRE/SCHEMA CHANGE: RoutingClass and DeliverySignal are OUTWARD presentation strings derived at
 * read time; they are NOT persisted, NOT members of the `readiness` column enum, and NOT members of
 * the `DeliveryState` machine (states.ts). The compatibility tuple (xbus-p1-stp1-s11) is unchanged.
 */

import type { Readiness } from './readiness.js';
import { DeliveryState } from '../protocol/states.js';

/** The outward, operator/sender-facing routing class (see file header). */
export type RoutingClass =
  | 'ready_live'
  | 'ready_wakeable'
  | 'degraded_checkpoint_only'
  | 'unavailable'
  | 'pending_activation';

export const ALL_ROUTING_CLASSES: readonly RoutingClass[] = [
  'ready_live', 'ready_wakeable', 'degraded_checkpoint_only', 'unavailable', 'pending_activation',
];

/**
 * Result of the per-host wake capability probe (recorded by a dedicated `doctor` IDLE-WAKE probe,
 * ADR 0038 — NOT probeManagedSpawn, which tests `--bg` = a DIFFERENT capability). `proven` is true
 * ONLY if a real resident-asyncRewake exit-2 wake of a truly-idle session was observed on this host.
 * Absent or false ⇒ we must NOT claim `ready_wakeable`.
 *
 * VERSION-BOUND (arch review E): the asyncRewake contract can change between Claude Code releases,
 * so a proof is valid only for the `claudeVersion` it was observed on. The consumer treats a probe
 * whose `claudeVersion` no longer matches the running CLI as NOT proven (re-probe required), so we
 * never keep claiming `ready_wakeable` on a host where a CC update silently broke the wake.
 */
export interface WakeProbe {
  proven: boolean;
  detail?: string;
  /** `claude --version` string this proof was observed on. A mismatch ⇒ treat as unproven. */
  claudeVersion?: string;
}

/** Inputs to the pure routing-class derivation — everything the broker cheaply knows at read time. */
export interface RoutingInputs {
  /** Internal readiness (readiness.ts). */
  readiness: Readiness;
  /** sessions.receive_mode: 'hook_checkpoint' | 'live' | 'poll_only' | ... */
  receiveMode: string;
  /** sessions.state: 'connected' | 'disconnected'. A disconnected session has no live owner. */
  connectionState: string;
  /** Is a tombstone set (15-day expiry / superseded)? Overrides everything → unavailable. */
  expired: boolean;
  /** The recorded per-host wake-probe. Undefined ⇒ treated as NOT proven (honest default). */
  wakeProbe?: WakeProbe | undefined;
  /** Is automatic delivery currently enabled (not paused/DND/manual)? Default true. */
  autoDeliveryEnabled?: boolean | undefined;
  /** The receive-control mode: 'active' | 'paused' | 'do_not_disturb' | 'manual_checkpoint'.
   *  `manual_checkpoint` is auto-delivery-OFF but operator-DRAINABLE (xbus process-next), so it
   *  must NOT collapse to `unavailable` — it stays `degraded_checkpoint_only` (manual drain). */
  receiveControl?: string | undefined;
}

/**
 * Derive the OUTWARD routing class. Pure; total over the Readiness enum. Precedence is chosen so
 * the MOST honest, least-overclaiming class wins — we never label a session more capable than a
 * verified consumption path proves.
 */
export function deriveRoutingClass(i: RoutingInputs): RoutingClass {
  // 1. No verified consumption path at all → unavailable (tombstoned / incompatible / no live owner).
  if (i.expired) return 'unavailable';
  if (i.readiness === 'incompatible' || i.readiness === 'disconnected') return 'unavailable';
  if (i.connectionState === 'disconnected') return 'unavailable';

  // 2. Still establishing activation → pending_activation (do not route yet; not a failure).
  if (i.readiness === 'initializing') return 'pending_activation';

  // 3. A receiver that cannot ack, or whose checkpoint hook is known-absent, has no usable path now.
  if (i.readiness === 'degraded_ack_unavailable' || i.readiness === 'degraded_hook_unavailable') {
    return 'unavailable';
  }

  // 4. Auto-delivery suppressed. `manual_checkpoint` is DRAINABLE by an operator on demand, so it
  //    is NOT `unavailable` — it is `degraded_checkpoint_only` (manual drain), an honest actionable
  //    state. Only `paused` / `do_not_disturb` (auto-off AND not manually drainable) → unavailable.
  if (i.autoDeliveryEnabled === false) {
    return i.receiveControl === 'manual_checkpoint' ? 'degraded_checkpoint_only' : 'unavailable';
  }

  // 5. A push-capable transport consumes immediately.
  if (i.readiness === 'ready_live') return 'ready_live';

  // 6. ready_checkpoint: the honesty fork. Autonomously wakeable ONLY with a PROVEN host wake path;
  //    otherwise it is checkpoint-capable but NOT proven-autonomous → degraded_checkpoint_only.
  if (i.readiness === 'ready_checkpoint') {
    return i.wakeProbe?.proven === true ? 'ready_wakeable' : 'degraded_checkpoint_only';
  }

  // Total-function guard: any unmapped readiness is treated as not-verified (fail honest).
  return 'unavailable';
}

/** Is this routing class one AgenTel may AUTONOMOUSLY route a time-sensitive request to?
 *  ready_live / ready_wakeable ONLY — a degraded_checkpoint_only session is NOT (it may need a
 *  user-generated checkpoint or an operator manual drain). */
export function isAutonomouslyRoutable(rc: RoutingClass): boolean {
  return rc === 'ready_live' || rc === 'ready_wakeable';
}

/**
 * SENDER-FACING delivery signal — the honest lifecycle word the sender is told. Derived (never
 * "delivered" for a merely-stored message). This is an OUTWARD overlay over the internal
 * DeliveryState machine plus the routing class + an optional recorded wake attempt; it is NOT a
 * new DeliveryState. The operator's requirement: a stored message, an injected message, and an
 * acknowledged message must be DISTINGUISHABLE — which they are, because each maps from a distinct
 * underlying DeliveryState / wake-attempt outcome, not an overloaded field.
 */
export type DeliverySignal =
  | 'queued'          // durably stored by the broker; NOT yet presented to the recipient model
  | 'wake_requested'  // AgenTel has requested automatic recipient execution
  | 'wake_failed'     // an automatic wake could not be initiated (falls back to durable queue)
  | 'injected'        // the message entered the recipient's Claude context (transport_written)
  | 'acknowledged'    // the recipient acked (accepted)
  | 'replied'         // a correlated reply/outcome was recorded (completed)
  | 'failed'          // rejected / dead-lettered
  | 'expired';        // TTL / retention elapsed

export const ALL_DELIVERY_SIGNALS: readonly DeliverySignal[] = [
  'queued', 'wake_requested', 'wake_failed', 'injected', 'acknowledged', 'replied', 'failed', 'expired',
];

/** The outcome of an automatic wake attempt (recorded additively; see store wake-attempt log). */
export type WakeOutcome = 'requested' | 'accepted' | 'failed' | 'none';

/**
 * Map an internal DeliveryState (+ optional recorded wake outcome) to the sender-facing signal.
 * Pure. The wake outcome only refines the pre-injection window (queued): once a body is injected
 * or beyond, the DeliveryState is authoritative and the signal never regresses to a wake word.
 */
export function deriveDeliverySignal(state: DeliveryState, wake: WakeOutcome = 'none'): DeliverySignal {
  switch (state) {
    case DeliveryState.QUEUED:
    case DeliveryState.DISPATCHING:
    case DeliveryState.RETRY_WAIT:
      // Pre-injection: surface the wake attempt if one is on record, else plain durable-queued.
      if (wake === 'failed') return 'wake_failed';
      if (wake === 'requested' || wake === 'accepted') return 'wake_requested';
      return 'queued';
    case DeliveryState.TRANSPORT_WRITTEN:
      return 'injected';
    case DeliveryState.ACCEPTED:
      return 'acknowledged';
    case DeliveryState.COMPLETED:
      return 'replied';
    case DeliveryState.REJECTED:
    case DeliveryState.DEAD_LETTER:
    case DeliveryState.CANCELLED:
      return 'failed';
    case DeliveryState.EXPIRED:
      return 'expired';
    default:
      return 'queued';
  }
}
