/**
 * EXPERIMENTAL / UNVALIDATED — federation & enterprise SKELETON (beta.7, ADR 0026).
 *
 * This module is **compile-tested interfaces + a few pure helpers ONLY**. It is NOT wired into
 * the live broker, opens NO listener or relay, performs NO networking, and has NOT been tested
 * for multi-machine or enterprise operation. The SHIPPING product remains same-machine /
 * same-user (README + roadmap non-goals). Nothing here changes SCHEMA_VERSION, the wire tuple,
 * or any live path — it exists so a future LAN/relay/enterprise design has honest, typed
 * contracts to build against, and so the direction is reviewable now.
 *
 * Each interface mirrors an existing LOCAL concept (kept string/number/base64 typed so this
 * module never imports Buffer/DB/socket code from the live broker):
 *   - DeviceIdentity / PairingRequest  ← root-secret.ts (create-if-absent, hashed, TTL'd, never
 *                                         cleartext-persisted enrollment secret)
 *   - MtlsEnvelope / E2EEnvelope       ← secure-channel.ts (per-connection sealed frame + AAD)
 *   - RelayEndpoint / ProxyConfig      ← outbound-only posture (no inbound listener ever)
 *   - SsoPrincipal / RbacPolicy        ← dashboard/auth.ts token model + components.ts
 *                                         fail-closed capability matrix
 *   - AuditExport                      ← ledger.ts (body-free, hash-chained, verifiable)
 *   - TenantBoundary                   ← new concept, no live analog
 *
 * The `isFederationEnabled() === false` guard below is a HONESTY TRIPWIRE: it must stay a hard
 * `false` so a future contributor cannot silently flip federation on without design review.
 */

/** Hard status marker — surfaced in docs + asserted by the shard test. */
export const FEDERATION_STATUS = 'experimental-unvalidated' as const;

/** Federation is NEVER enabled in a shipped build. A hard `false` guard (not a config read):
 *  the live broker has no federation code path, so this returning `true` would be a lie. */
export function isFederationEnabled(): false {
  return false;
}

// ─────────────────────────── device identity + pairing ───────────────────────────

/** A device that could participate in a future federation. Mirrors the local root-secret's
 *  identity role — a stable, hashed, non-cleartext identity, never a bearer credential. */
export interface DeviceIdentity {
  deviceId: string;
  /** PEM public key (the private key never leaves the device). */
  publicKeyPem: string;
  createdAtIso: string;
  displayName?: string;
}

/** A request to enroll a device. The enrollment secret is carried ONLY as a hash (mirrors
 *  root-secret.ts: create-if-absent, first-writer-wins, never cleartext-persisted, TTL'd). */
export interface PairingRequest {
  requestId: string;
  deviceId: string;
  enrollmentSecretHash: string; // sha256 hex — never the cleartext secret
  requestedRole: string;
  expiresAtIso: string;
}

export interface PairingResponse {
  accepted: boolean;
  deviceId?: string;
  reason?: string;
}

// ─────────────────────────── channel + end-to-end envelopes ───────────────────────────

/** An application-layer END-TO-END sealed payload (mirrors SecureSession.seal output shape +
 *  buildContext AAD, but base64/string typed so it is transport-agnostic and Buffer-free). */
export interface E2EEnvelope {
  connId: string;
  seq: number;
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
  aad: string;
}

/** A transport-layer mTLS wrapper carrying an E2E-sealed payload. mTLS protects the channel
 *  to the peer/relay; the E2EEnvelope protects the message content end-to-end THROUGH a relay
 *  (a relay that terminates mTLS still cannot read the E2E payload). Distinct on purpose. */
export interface MtlsEnvelope {
  suite: number;
  peerCertFingerprint: string;
  sealed: E2EEnvelope;
}

// ─────────────────────────── relay + proxy (outbound-only) ───────────────────────────

/** A relay endpoint. `direction` is the literal `'outbound-only'` so an inbound-listener
 *  design can never typecheck — matching the same-machine safety posture (no open port). */
export interface RelayEndpoint {
  url: string;
  direction: 'outbound-only';
  relayId: string;
  verifiedPeer: boolean;
}

export interface ProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: readonly string[];
  connectTimeoutMs: number;
}

// ─────────────────────────── SSO / RBAC ───────────────────────────

/** An authenticated principal from an external IdP. Mirrors the dashboard-auth session model:
 *  short-lived, never a persisted cleartext credential. */
export interface SsoPrincipal {
  subject: string;
  issuer: string;
  tenantId: string;
  roles: readonly string[];
  expiresAtIso: string;
}

/** A fail-closed allow-list policy (mirrors components.ts: anything not listed is denied). */
export interface RbacPolicy {
  /** role -> allowed operations. */
  allow: Readonly<Record<string, readonly string[]>>;
}

export interface RbacDecision {
  allowed: boolean;
  reason: string;
}

// ─────────────────────────── audit export ───────────────────────────

/** A body-free audit export descriptor (mirrors ledger.ts: ids/states/counts/hashes only —
 *  no message content ever leaves the machine). `bodyFree` is the literal `true`. */
export interface AuditExport {
  schemaVersion: number;
  fromSeq: number;
  toSeq: number;
  entryCount: number;
  tipHash: string;
  bodyFree: true;
}

export interface AuditExportManifest {
  generatedAtIso: string;
  verifyResultOk: boolean;
}

// ─────────────────────────── tenant boundary ───────────────────────────

/** A hard tenant boundary — strict isolation between tenants (no live analog today). */
export interface TenantBoundary {
  tenantId: string;
  allowedDeviceIds: readonly string[];
  isolationLevel: 'strict';
}

// ─────────────────────────── pure helpers (behavior, not just types) ───────────────────────────

/**
 * Fail-closed RBAC check (mirrors components.ts `assertAllowed`): a role may perform an op ONLY
 * if the policy explicitly lists it. Unknown role / unlisted op → denied. Pure; no I/O.
 */
export function rbacAllows(policy: RbacPolicy, role: string, op: string): RbacDecision {
  const ops = policy.allow[role];
  if (ops === undefined) return { allowed: false, reason: `role '${role}' has no policy (fail-closed)` };
  if (!ops.includes(op)) return { allowed: false, reason: `role '${role}' may not '${op}' (fail-closed)` };
  return { allowed: true, reason: 'allowed by policy' };
}

/** Is an SSO principal still valid at `nowIso`? Pure string-ISO comparison (UTC ISO-8601 sorts
 *  lexicographically). Expired / malformed → false (fail-closed). */
export function ssoPrincipalValid(p: SsoPrincipal, nowIso: string): boolean {
  if (!p.expiresAtIso || !nowIso) return false;
  return p.expiresAtIso > nowIso;
}

/** A federation compatibility verdict shape mirroring handshake.ts (pure, fail-closed on a
 *  tuple mismatch). Used to reason about future cross-device version negotiation. */
export interface FederationCompatibility {
  ok: boolean;
  result: 'compatible' | 'incompatible';
  detail: string;
}
export function federationCompatibility(localTuple: string, remoteTuple: string): FederationCompatibility {
  if (localTuple === remoteTuple) return { ok: true, result: 'compatible', detail: localTuple };
  return { ok: false, result: 'incompatible', detail: `local ${localTuple} != remote ${remoteTuple}` };
}

export * from './errors.js';
