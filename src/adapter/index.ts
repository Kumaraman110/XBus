/**
 * @xbus/adapter-sdk — the vendor-neutral adapter contract (§11).
 *
 * This is the ONLY surface an adapter is allowed to import. It exposes NO broker
 * internals: no SQLite handle, no broker state object, no root secret, no raw
 * transport key, no arbitrary logging callback. An adapter has NO authority to
 * approve human permissions, bypass message validation, or mutate support-tier
 * evidence. There are no vendor-specific types in the common interface.
 *
 * PR1 introduces the abstraction ALONGSIDE the existing Claude Code integration;
 * no production caller is migrated (that is PR3). Adding this module changes no
 * wire behavior — `compatibilityId xbus-p1-stp1-s5` is unchanged.
 */

import type { BrokerFacade } from './facade.js';
import type {
  DetectionContext, DetectionResult, CapabilityContext, CapabilityReport,
  RegistrationContext, ReceiveContext, AcknowledgeContext, ReplyContext,
  HealthContext, ShutdownContext, RuntimeEnv, AdapterIdentity,
} from './context.js';
import type { RegisteredAgent, ReceiveResult, AcknowledgeResult, ReplyResult, HealthResult } from './results.js';
import type { AdapterManifest } from './manifest.js';

/** The contract every adapter implements. Refine as the cohort grows; PR1 freezes the shape. */
export interface XBusAdapter {
  /** Static, side-effect-free descriptor. Read before any process work. */
  manifest(): AdapterManifest;

  /** Cheap, non-throwing host probe. Performs ZERO broker I/O and NEVER process.exit. */
  detect(context: DetectionContext): Promise<DetectionResult>;

  /** Declares the versioned capability set this adapter reports (untrusted until verified). */
  capabilities(context: CapabilityContext): Promise<CapabilityReport>;

  /** Open the session via the facade using a resolved identity. */
  register(context: RegistrationContext, facade: BrokerFacade): Promise<RegisteredAgent>;

  /** Receive leg. Returns a presentation payload for the host to surface. */
  receive(context: ReceiveContext, facade: BrokerFacade): Promise<ReceiveResult>;

  /** Acknowledge a received message (accepted|rejected + injectionId). */
  acknowledge(context: AcknowledgeContext, facade: BrokerFacade): Promise<AcknowledgeResult>;

  /** Reply to a received message (correlation preserved by the broker). */
  reply(context: ReplyContext, facade: BrokerFacade): Promise<ReplyResult>;

  /** Liveness/readiness, content-free. Drives signal_readiness + get_status. */
  health(context: HealthContext, facade: BrokerFacade): Promise<HealthResult>;

  /** Graceful teardown; idempotent; never throws. */
  shutdown(context: ShutdownContext): Promise<void>;
}

/** An adapter resolves identity from its OWN runtime — core/SDK never read env vars. */
export interface SessionIdentitySource {
  /** Returns a stable identity or throws AdapterError(IDENTITY_UNRESOLVED). */
  resolve(env: RuntimeEnv): Promise<AdapterIdentity>;
}

// ---- Re-exports: the complete public SDK surface ----
export { ADAPTER_SDK_VERSION } from './version.js';
export type { BrokerFacade, SessionRegistration, OutboundMessage, AckCommand, ReplyCommand } from './facade.js';
export { makeBrokerFacade } from './facade.js';
export type {
  DetectionContext, DetectionResult, CapabilityContext, CapabilityReport,
  RegistrationContext, ReceiveContext, AcknowledgeContext, ReplyContext,
  HealthContext, ShutdownContext, RuntimeEnv, AdapterIdentity,
} from './context.js';
export type { RegisteredAgent, ReceiveResult, AcknowledgeResult, ReplyResult, HealthResult } from './results.js';
export type {
  AdapterManifest, AdapterPermission, AdapterMaturity, ReceiveMode,
} from './manifest.js';
export {
  validateManifest, hasPermission, SUPPORTED_MANIFEST_VERSION, FROZEN_PROTOCOL_COMPAT,
  ALL_PERMISSIONS, ALL_MATURITY,
} from './manifest.js';
export type { AgentCapabilities, CapabilityState, VerifiedCapabilities } from './capabilities.js';
export {
  CAPABILITY_STATES, isCapabilityState, isVerified, isClaimed, toVerified, emptyCapabilities,
} from './capabilities.js';
export type { SessionLifecycle } from './lifecycle.js';
export {
  ALL_LIFECYCLE, PROHIBITED_INJECTION, AUTONOMOUS_INJECTABLE, isSessionLifecycle, toReadiness,
} from './lifecycle.js';
export type { SupportTier, ValidationEvidence } from './tier.js';
export {
  TIER_ORDER, calculateMaximumTier, emptyEvidence, isWithinCeiling, awardedTier,
} from './tier.js';
export {
  resolveContainedEntrypoint, assertEntrypointNotReparse, requirePermission, isPermitted,
} from './validation.js';
export { AdapterError, AdapterErrorCode } from './errors.js';
export type { SafeDetails } from './errors.js';
