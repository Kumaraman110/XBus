/**
 * Validation-evidence model + awarded-support computation (§7/§8). Separates two
 * orthogonal axes that must NEVER be conflated:
 *
 *   maximumDeliveryTier — the highest delivery capability the broker VERIFIED
 *                         (T0..T5). A checkpoint-only platform legitimately tops
 *                         out at T3; that is not a maturity deficiency.
 *   validationLevel     — HOW the evidence was produced: unvalidated <
 *                         conformance_tested < real_runtime_validated < supported.
 *
 * So Claude Code on Bedrock may be { maximumDeliveryTier: 'T3',
 * validationLevel: 'real_runtime_validated' } and MUST NOT self-promote to T4.
 *
 * Evidence is BROKER-CONTROLLED. An adapter cannot submit a bare boolean like
 * `realRuntimeValidated = true`; the level is derived from how the evidence was
 * generated (a fake runtime can only ever yield `conformance_tested`).
 */

import type { VerifiedCapabilities } from './capabilities.js';
import { calculateMaximumTier, type SupportTier, type ValidationEvidence } from './tier.js';

export type ValidationLevel =
  | 'unvalidated'
  | 'conformance_tested'        // passed the deterministic conformance runner (fake runtime)
  | 'real_runtime_validated'   // R1-R4 proven against an actual host
  | 'supported';               // real-runtime + policy sign-off

export const VALIDATION_LEVELS: readonly ValidationLevel[] = ['unvalidated', 'conformance_tested', 'real_runtime_validated', 'supported'];

/** Provenance of the evidence — determines the MAX validationLevel it can justify. */
export type EvidenceSource = 'none' | 'fake_runtime' | 'real_runtime' | 'real_runtime_signed_off';

/** The structured, broker-controlled evidence record (§8). */
export interface StructuredEvidence {
  conformanceVersion: number;
  adapterId: string;
  adapterVersion: string;
  /** Provenance — set by the runner/broker, never by the adapter. */
  source: EvidenceSource;
  capabilitiesVerified: string[];
  conformanceCasesPassed: string[];
  runtimeEvidence?: {
    platformVersion: string;
    operatingSystem: string;
    testedAt: string;       // ISO; passed in, never Date.now()
    deliveryMode: string;
  };
  durability: { brokerRestart: boolean; adapterRestart: boolean; queuedDeliveryPreserved: boolean };
  security: { aliasFencing: boolean; secretRedaction: boolean; telemetryRedaction: boolean; packagedRuntime: boolean };
}

export interface AwardedSupport {
  maximumDeliveryTier: SupportTier;
  validationLevel: ValidationLevel;
}

/** The conformance schema version (bumped when the 25-case contract changes). */
export const CONFORMANCE_VERSION = 1 as const;

/**
 * The MAXIMUM validationLevel a given evidence source can ever justify. A fake
 * runtime is capped at `conformance_tested` — it can never yield
 * `real_runtime_validated`, no matter what booleans it sets.
 */
export function maxLevelForSource(source: EvidenceSource): ValidationLevel {
  switch (source) {
    case 'none': return 'unvalidated';
    case 'fake_runtime': return 'conformance_tested';
    case 'real_runtime': return 'real_runtime_validated';
    case 'real_runtime_signed_off': return 'supported';
  }
}

function levelRank(l: ValidationLevel): number { return VALIDATION_LEVELS.indexOf(l); }

/**
 * Derive the validationLevel from the evidence PROVENANCE (source) and whether the
 * conformance battery is complete enough to claim that level. Capped by the source:
 * fake-runtime evidence can never exceed `conformance_tested`.
 */
export function deriveValidationLevel(ev: StructuredEvidence, fullConformancePassed: boolean): ValidationLevel {
  const ceiling = maxLevelForSource(ev.source);
  // Without a full conformance pass, nothing above `conformance_tested` is claimable,
  // and even that requires the run to have happened (source != none).
  let claimed: ValidationLevel;
  if (ev.source === 'none') claimed = 'unvalidated';
  else if (!fullConformancePassed) claimed = 'unvalidated';
  else claimed = ceiling; // a complete pass justifies up to the source ceiling
  // never exceed the source ceiling
  return levelRank(claimed) <= levelRank(ceiling) ? claimed : ceiling;
}

/**
 * Compute the broker-awarded support. The delivery tier comes ONLY from verified
 * capabilities + the runtime evidence (calculateMaximumTier); the validation level
 * comes ONLY from the evidence provenance. Neither reads the manifest's self-declared
 * maturity. This is the single function the broker uses to award support.
 */
export function computeAwardedSupport(
  verified: VerifiedCapabilities,
  runtimeEvidence: ValidationEvidence,
  structured: StructuredEvidence,
  fullConformancePassed: boolean,
): AwardedSupport {
  return {
    maximumDeliveryTier: calculateMaximumTier(verified, runtimeEvidence),
    validationLevel: deriveValidationLevel(structured, fullConformancePassed),
  };
}

/**
 * Build a ValidationEvidence record whose flags are CAPPED by the evidence source
 * (the tier-axis provenance guard). A fake runtime (`source: 'fake_runtime'`) can
 * set boot/send/manual/checkpoint/ack flags — those are deterministically provable
 * against a fake broker — but is STRUCTURALLY FORBIDDEN from setting
 * `liveReceiveVerified` or `fullRuntimeValidation`, whose only honest proof is a
 * real host (the §15 R-gate). So a pure conformance run can never lift the awarded
 * delivery tier to T4/T5, no matter what booleans the caller passes.
 */
export function buildValidationEvidence(source: EvidenceSource, flags: Partial<ValidationEvidence>): ValidationEvidence {
  const realOnly = source === 'real_runtime' || source === 'real_runtime_signed_off';
  return {
    bootedAndRegistered: flags.bootedAndRegistered ?? false,
    sendVerified: flags.sendVerified ?? false,
    manualReceiveVerified: flags.manualReceiveVerified ?? false,
    checkpointReceiveVerified: flags.checkpointReceiveVerified ?? false,
    ackReplyVerified: flags.ackReplyVerified ?? false,
    // live + full are real-host-only: forced false unless the source is a real runtime.
    liveReceiveVerified: realOnly ? (flags.liveReceiveVerified ?? false) : false,
    fullRuntimeValidation: realOnly ? (flags.fullRuntimeValidation ?? false) : false,
  };
}

export function emptyStructuredEvidence(adapterId: string, adapterVersion: string): StructuredEvidence {
  return {
    conformanceVersion: CONFORMANCE_VERSION,
    adapterId,
    adapterVersion,
    source: 'none',
    capabilitiesVerified: [],
    conformanceCasesPassed: [],
    durability: { brokerRestart: false, adapterRestart: false, queuedDeliveryPreserved: false },
    security: { aliasFencing: false, secretRedaction: false, telemetryRedaction: false, packagedRuntime: false },
  };
}
