/**
 * Broker-side adapter registration enforcement (§7/§9) — TRUST-BOUNDARY CORRECTED.
 *
 * Central invariant: adapters may DECLARE capabilities; they must NEVER provide the
 * trusted evidence that verifies those capabilities. So this function takes:
 *   - `declaration`    — from the adapter frame, UNTRUSTED (id/version/role/declaredCaps);
 *   - `authority`      — from the authenticated broker connection (role is authoritative);
 *   - `trustedEvidence`— BROKER-OWNED, resolved from the broker-local registry by exact
 *                        adapter identity. The adapter cannot construct or mutate it.
 *
 * The adapter frame can no longer carry evidenceSource, verified flags, structured
 * evidence, fullConformancePassed, awarded tier, or validation level. Those are
 * computed from broker-owned evidence only.
 *
 * STRICTLY OPT-IN + ADDITIVE: engages only when the frame carries an
 * `adapterRegistration` DECLARATION. A legacy beta.2 registration takes a pure no-op
 * path (returns null). No SQLite column, no schema/STP/proto change.
 */

import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import { confirmCapabilities, toVerified, type AgentCapabilities } from '../adapter/capabilities.js';
import { calculateMaximumTier, type ValidationEvidence } from '../adapter/tier.js';
import {
  computeAwardedSupport, buildValidationEvidence, type AwardedSupport, type EvidenceSource,
} from '../adapter/evidence.js';
import { ComponentRole, isComponentRole } from '../identity/components.js';
import {
  type BrokerTrustedEvidence, type TrustedEvidenceSource, type EvidenceRejectReason,
} from './trusted-evidence.js';

/**
 * The adapter-controlled registration field. UNTRUSTED. Carries ONLY declarations —
 * no provenance, no verified flags, no evidence. (Renamed conceptually from the prior
 * AdapterRegistration which mixed in trusted fields; that mixing was the vulnerability.)
 */
export interface AdapterRegistrationDeclaration {
  adapterId: string;
  adapterVersion: string;
  role: ComponentRole;
  /** Adapter-DECLARED capabilities (untrusted; confirmed against broker evidence). */
  declaredCapabilities: AgentCapabilities;
  /** Optional package/build identity the adapter claims (cross-checked against evidence). */
  buildId?: string;
}

/** The authenticated connection authority the broker already holds (role is authoritative). */
export interface ConnectionAuthority {
  role: ComponentRole;
  sessionId: string;
}

export interface EnforcementResult {
  awarded: AwardedSupport;
  confirmedVerified: ReturnType<typeof toVerified>;
}

export interface EvaluateArgs {
  receiveMode: string;
  /** From the adapter frame — UNTRUSTED. Absent ⇒ legacy path (no-op). */
  declaration: AdapterRegistrationDeclaration | undefined;
  /** From the authenticated connection. */
  authority: ConnectionAuthority;
  /** BROKER-OWNED evidence (already resolved from the registry by exact identity), or
   *  undefined when the broker has none for this adapter. NEVER from the adapter frame. */
  trustedEvidence: BrokerTrustedEvidence | undefined;
}

/** Map a receive mode to the verified capability it REQUIRES (if any). */
export function modeRequires(receiveMode: string): keyof ReturnType<typeof toVerified>['receive'] | 'none' {
  switch (receiveMode) {
    case 'manual_pull': return 'manualPull';
    case 'hook_checkpoint': return 'lifecycleCheckpoint';
    case 'live':
    case 'live_push': return 'livePush';
    default: return 'none'; // unknown/legacy free-string modes impose no adapter requirement
  }
}

/** Map broker-owned evidence provenance to the merged evidence-model EvidenceSource. */
function toEvidenceSource(s: TrustedEvidenceSource): EvidenceSource {
  switch (s) {
    case 'none': return 'none';
    case 'conformance_runner': return 'fake_runtime';          // capped at conformance_tested
    case 'real_runtime_validation': return 'real_runtime';     // can reach real_runtime_validated
    case 'policy_signed_off': return 'real_runtime_signed_off';// can reach supported
  }
}

/** Build a source-capped ValidationEvidence from BROKER-OWNED evidence (never adapter input). */
function trustedToValidationEvidence(ev: BrokerTrustedEvidence): ValidationEvidence {
  const source = toEvidenceSource(ev.source);
  const fullRuntime =
    ev.durability.brokerRestartVerified && ev.durability.reconnectVerified && ev.durability.queuedDeliveryVerified &&
    ev.security.fencingVerified && ev.security.redactionVerified && ev.security.packagedRuntimeVerified;
  // buildValidationEvidence source-caps live/full: a conformance_runner (fake_runtime)
  // can never set liveReceiveVerified/fullRuntimeValidation true, no matter the flags.
  return buildValidationEvidence(source, {
    bootedAndRegistered: ev.capabilities.sendVerified || ev.capabilities.checkpointReceiveVerified || ev.capabilities.manualReceiveVerified,
    sendVerified: ev.capabilities.sendVerified,
    manualReceiveVerified: ev.capabilities.manualReceiveVerified,
    checkpointReceiveVerified: ev.capabilities.checkpointReceiveVerified,
    ackReplyVerified: ev.capabilities.ackReplyVerified,
    liveReceiveVerified: ev.capabilities.liveReceiveVerified,
    fullRuntimeValidation: fullRuntime,
  });
}

const REJECT_DETAIL: Record<EvidenceRejectReason, string> = {
  absent: 'no broker-owned trusted evidence exists for this adapter identity',
  adapter_id_mismatch: 'trusted evidence adapterId does not match',
  adapter_version_mismatch: 'trusted evidence adapterVersion does not match',
  role_mismatch: 'trusted evidence role does not match',
  build_mismatch: 'trusted evidence buildId does not match',
  unsupported_conformance_version: 'trusted evidence conformance version is unsupported',
  unknown_source: 'trusted evidence source is unknown',
};

/**
 * Evaluate an adapter-aware registration against BROKER-OWNED evidence.
 *  - legacy (no declaration) ⇒ returns null (caller takes the unchanged path);
 *  - declared role must equal the authenticated authority role (no role spoofing);
 *  - with NO trusted evidence ⇒ T0 / unvalidated, and any advanced receive mode is
 *    REJECTED explicitly (never silently downgraded);
 *  - with trusted evidence ⇒ confirm declared caps against it, award the tier from
 *    the broker-owned evidence only.
 */
export function evaluateRegistration(args: EvaluateArgs): EnforcementResult | null {
  const { receiveMode, declaration, authority, trustedEvidence } = args;
  if (!declaration) return null; // legacy path — pure no-op

  // (a) declared role must be a real role AND match the authenticated authority.
  if (!isComponentRole(declaration.role)) {
    throw new XBusError(XBusErrorCode.PROTOCOL_VIOLATION, `adapter declared an invalid role '${String(declaration.role)}'`);
  }
  if (declaration.role !== authority.role) {
    throw new XBusError(
      XBusErrorCode.FORBIDDEN_ROLE,
      `adapter authenticated as role '${authority.role}' but declared role '${declaration.role}'`,
      { authenticated: authority.role, declared: declaration.role },
    );
  }

  // (b) Resolve broker-owned evidence (already identity-checked by the registry). When
  //     absent, evidence is the empty/'none' baseline ⇒ nothing is verified.
  const evidence: ValidationEvidence = trustedEvidence
    ? trustedToValidationEvidence(trustedEvidence)
    : buildValidationEvidence('none', {});
  const structuredSource: EvidenceSource = trustedEvidence ? toEvidenceSource(trustedEvidence.source) : 'none';

  // (c) CONFIRM declared caps against broker evidence — clamps self-declared 'verified'.
  const confirmed = confirmCapabilities(declaration.declaredCapabilities, evidence);
  const verified = toVerified(declaration.role, confirmed);

  // (d) Receive-mode check: the requested mode must be backed by a CONFIRMED capability.
  //     Without broker evidence this is always false for advanced modes ⇒ explicit reject.
  const required = modeRequires(receiveMode);
  if (required !== 'none' && !verified.receive[required]) {
    throw new XBusError(
      XBusErrorCode.PROTOCOL_VIOLATION,
      `adapter requested receiveMode '${receiveMode}' but the broker has not verified the '${required}' capability${trustedEvidence ? '' : ' (no broker-owned evidence present)'}`,
      { receiveMode, required, hasEvidence: trustedEvidence !== undefined },
    );
  }

  // (e) Award support — delivery tier from verified caps + broker evidence; validation
  //     level from broker-owned provenance. Manifest maturity is NEVER read.
  const fullConformancePassed = trustedEvidence !== undefined && structuredSource !== 'none'
    && (evidence.fullRuntimeValidation || evidence.checkpointReceiveVerified || evidence.manualReceiveVerified || evidence.sendVerified);
  const awarded = computeAwardedSupport(
    verified,
    evidence,
    {
      conformanceVersion: trustedEvidence?.conformanceVersion ?? 0,
      adapterId: declaration.adapterId,
      adapterVersion: declaration.adapterVersion,
      source: structuredSource,
      capabilitiesVerified: [],
      conformanceCasesPassed: [],
      durability: { brokerRestart: trustedEvidence?.durability.brokerRestartVerified ?? false, adapterRestart: trustedEvidence?.durability.reconnectVerified ?? false, queuedDeliveryPreserved: trustedEvidence?.durability.queuedDeliveryVerified ?? false },
      security: { aliasFencing: trustedEvidence?.security.fencingVerified ?? false, secretRedaction: trustedEvidence?.security.redactionVerified ?? false, telemetryRedaction: trustedEvidence?.security.redactionVerified ?? false, packagedRuntime: trustedEvidence?.security.packagedRuntimeVerified ?? false },
    },
    fullConformancePassed,
  );

  // Defense-in-depth: awarded tier must equal the pure cap.
  const capTier = calculateMaximumTier(verified, evidence);
  if (awarded.maximumDeliveryTier !== capTier) {
    throw new XBusError(XBusErrorCode.PROTOCOL_VIOLATION, 'awarded tier diverged from the computed ceiling');
  }

  return { awarded, confirmedVerified: verified };
}

export { REJECT_DETAIL };
