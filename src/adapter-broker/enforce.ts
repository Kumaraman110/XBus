/**
 * Broker-side adapter registration enforcement (§7/§9). This is the ONLY place the
 * broker awards a support tier — an adapter can never award its own.
 *
 * STRICTLY OPT-IN + ADDITIVE. It engages ONLY when a register frame carries explicit
 * structured `adapterRegistration` metadata (a NEW optional field). A legacy beta.2
 * registration (free-string receiveMode + capabilities:string[] + no adapter metadata)
 * takes a PURE NO-OP path: `evaluate()` returns null and `onRegister` proceeds exactly
 * as before. No SQLite column, no schema bump, no STP change — the awarded support is
 * computed in-memory and attached to the connection's authority, never persisted.
 *
 * Honesty controls (reusing the canonical PR1 cores — no re-declaration):
 *   - capabilities are CONFIRMED against broker evidence (confirmCapabilities) before
 *     toVerified, so a self-declared 'verified' leaf cannot raise the tier;
 *   - the delivery tier comes from calculateMaximumTier (verified caps + evidence);
 *   - the validation level comes from evidence PROVENANCE (computeAwardedSupport);
 *   - a fake runtime's evidence is structurally capped (buildValidationEvidence), so a
 *     non-real registration can never be awarded T4/T5 or real_runtime_validated.
 */

import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import { confirmCapabilities, toVerified, type AgentCapabilities } from '../adapter/capabilities.js';
import { calculateMaximumTier, type ValidationEvidence } from '../adapter/tier.js';
import {
  computeAwardedSupport, buildValidationEvidence, type AwardedSupport,
  type EvidenceSource, type StructuredEvidence,
} from '../adapter/evidence.js';
import { ComponentRole, isComponentRole } from '../identity/components.js';

/**
 * The NEW optional register-frame field. Absent ⇒ legacy path (no-op). When present,
 * it carries the adapter's DECLARED structured capabilities + the broker-trusted
 * evidence record produced by the registration/conformance pipeline (never by the
 * adapter itself).
 */
export interface AdapterRegistration {
  adapterId: string;
  adapterVersion: string;
  role: ComponentRole;
  /** Adapter-DECLARED capabilities (untrusted; confirmed here). */
  declaredCapabilities: AgentCapabilities;
  /** Provenance of the evidence backing this registration. */
  evidenceSource: EvidenceSource;
  /** The evidence flags (capped by source in buildValidationEvidence). */
  evidence: Partial<ValidationEvidence>;
  /** The structured-evidence record (its `source` is authoritative for validationLevel). */
  structuredEvidence: StructuredEvidence;
  /** Whether the full conformance battery passed (gates validationLevel). */
  fullConformancePassed: boolean;
}

export interface EnforcementResult {
  awarded: AwardedSupport;
  /** Diagnostic: declared-vs-confirmed deltas, enum/bool only (no adapter strings as labels). */
  confirmedVerified: ReturnType<typeof toVerified>;
}

/** Map a receive mode to the verified capability it REQUIRES (if any). */
export function modeRequires(receiveMode: string): keyof ReturnType<typeof toVerified>['receive'] | 'none' {
  switch (receiveMode) {
    case 'manual_pull': return 'manualPull';
    case 'hook_checkpoint': return 'lifecycleCheckpoint';
    case 'live':
    case 'live_push': return 'livePush';
    default: return 'none';   // unknown/legacy free-string modes impose no adapter requirement
  }
}

/**
 * Evaluate an adapter-aware registration. Returns null for a LEGACY registration
 * (no adapter metadata) — the caller then takes the unchanged path. For an
 * adapter-aware registration, returns the broker-awarded support, or throws
 * PROTOCOL_VIOLATION if the requested receive mode over-claims a capability the
 * broker has NOT confirmed.
 *
 * NOTE: this never throws for legacy registrations and never inspects a legacy
 * `capabilities: string[]` — the opt-in gate is the presence of `adapterRegistration`.
 */
export function evaluateRegistration(
  receiveMode: string,
  adapterReg: AdapterRegistration | undefined,
): EnforcementResult | null {
  if (!adapterReg) return null; // legacy path — pure no-op

  if (!isComponentRole(adapterReg.role)) {
    throw new XBusError(XBusErrorCode.PROTOCOL_VIOLATION, `adapter declared an invalid role '${String(adapterReg.role)}'`);
  }

  // 1) Build evidence with source-capping (fake runtime can't set live/full).
  const evidence = buildValidationEvidence(adapterReg.evidenceSource, adapterReg.evidence);

  // 2) CONFIRM declared capabilities against evidence — clamps self-declared 'verified'.
  const confirmed = confirmCapabilities(adapterReg.declaredCapabilities, evidence);
  const verified = toVerified(adapterReg.role, confirmed);

  // 3) Receive-mode capability check: the requested mode must be backed by a CONFIRMED
  //    capability. Over-claim ⇒ fail closed (only on this adapter-aware path).
  const required = modeRequires(receiveMode);
  if (required !== 'none' && !verified.receive[required]) {
    throw new XBusError(
      XBusErrorCode.PROTOCOL_VIOLATION,
      `adapter requested receiveMode '${receiveMode}' but the broker has not confirmed the '${required}' capability`,
      { receiveMode, required },
    );
  }

  // 4) Award support — delivery tier from verified caps + evidence; validation level
  //    from evidence provenance. Neither reads the adapter's self-declared maturity.
  const awarded = computeAwardedSupport(verified, evidence, adapterReg.structuredEvidence, adapterReg.fullConformancePassed);

  // Defense-in-depth: re-assert the tier equals the pure cap (no out-of-band award).
  const capTier = calculateMaximumTier(verified, evidence);
  if (awarded.maximumDeliveryTier !== capTier) {
    throw new XBusError(XBusErrorCode.PROTOCOL_VIOLATION, 'awarded tier diverged from the computed ceiling');
  }

  return { awarded, confirmedVerified: verified };
}
