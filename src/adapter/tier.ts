/**
 * Broker-enforced support-tier cap (§10) — the keystone honesty control.
 *
 * The adapter REPORTS capabilities; it MUST NOT self-award a tier. This pure
 * function computes the maximum tier an adapter may legitimately advertise, from
 * (a) VERIFIED capabilities only (never declared/detected) and (b) real-runtime
 * ValidationEvidence. The returned tier is a CEILING; the publicly-awarded tier may
 * be lower by policy or incomplete validation, but never higher.
 *
 *   T0 detected only
 *   T1 verified send
 *   T2 verified send + manual receive
 *   T3 verified lifecycle/checkpoint receive + acknowledgement + reply
 *   T4 verified safe live receive
 *   T5 full real-runtime validation (durability, reconnect, fencing, security, lifecycle)
 */

import type { VerifiedCapabilities } from './capabilities.js';

export type SupportTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
export const TIER_ORDER: readonly SupportTier[] = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'];

/**
 * Real-runtime evidence (§15 R-gate). Each flag is set ONLY by an actual host run,
 * never by a mock or a manifest. Absent evidence ⇒ the corresponding tier is unreachable.
 */
export interface ValidationEvidence {
  /** R1: the adapter booted under the real host and registered with the real broker. */
  bootedAndRegistered: boolean;
  /** Verified send round-trips against a real broker. */
  sendVerified: boolean;
  /** Verified explicit/manual pull drains the queue against a real broker. */
  manualReceiveVerified: boolean;
  /** R3: verified lifecycle-checkpoint receive (fence intact) at a real checkpoint. */
  checkpointReceiveVerified: boolean;
  /** Verified correlated acknowledgement + reply. */
  ackReplyVerified: boolean;
  /** Verified SAFE live (between-turn) receive on a real, push-capable transport. */
  liveReceiveVerified: boolean;
  /** Full T5 battery: durability + reconnect + fencing + security + lifecycle correctness. */
  fullRuntimeValidation: boolean;
}

export function emptyEvidence(): ValidationEvidence {
  return {
    bootedAndRegistered: false, sendVerified: false, manualReceiveVerified: false,
    checkpointReceiveVerified: false, ackReplyVerified: false, liveReceiveVerified: false,
    fullRuntimeValidation: false,
  };
}

/**
 * Compute the maximum legitimate tier. Monotone: each higher tier requires all the
 * evidence of the tiers below it. Returns the highest tier whose every requirement
 * is met by VERIFIED capabilities + real evidence.
 */
export function calculateMaximumTier(capabilities: VerifiedCapabilities, evidence: ValidationEvidence): SupportTier {
  // T0 — detection only; nothing proven.
  if (!evidence.bootedAndRegistered) return 'T0';

  // T1 — verified send.
  if (!evidence.sendVerified) return 'T0';
  let tier: SupportTier = 'T1';

  // T2 — + verified manual receive (capability AND evidence).
  if (capabilities.receive.manualPull && evidence.manualReceiveVerified) {
    tier = 'T2';
  } else {
    return tier; // cannot skip a rung
  }

  // T3 — + verified lifecycle/checkpoint receive, ack, and reply.
  if (capabilities.receive.lifecycleCheckpoint && capabilities.messaging.acknowledgements
      && capabilities.messaging.correlatedReplies && evidence.checkpointReceiveVerified && evidence.ackReplyVerified) {
    tier = 'T3';
  } else {
    return tier;
  }

  // T4 — + verified SAFE live receive (requires a real push-capable transport).
  if (capabilities.receive.livePush && evidence.liveReceiveVerified) {
    tier = 'T4';
  } else {
    return tier;
  }

  // T5 — full real-runtime validation battery.
  if (evidence.fullRuntimeValidation) {
    tier = 'T5';
  }
  return tier;
}

function rank(t: SupportTier): number { return TIER_ORDER.indexOf(t); }

/** True iff `advertised` is within the legitimate ceiling (no self-promotion). */
export function isWithinCeiling(advertised: SupportTier, ceiling: SupportTier): boolean {
  return rank(advertised) <= rank(ceiling);
}

/** The lower of two tiers (policy may award below the ceiling, never above). */
export function awardedTier(ceiling: SupportTier, policyMax: SupportTier = 'T5'): SupportTier {
  return rank(policyMax) < rank(ceiling) ? policyMax : ceiling;
}
