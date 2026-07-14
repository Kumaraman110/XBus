/**
 * EXPERIMENTAL / UNVALIDATED federation skeleton (beta.7, ADR 0026) — compile + behavior test.
 *
 * This is a TYPE-only + minimal-impl test: it constructs one literal per exported interface
 * (so tsc/vitest fail if a field drifts) and asserts the pure helpers behave fail-closed. It
 * imports NOTHING from src/broker, src/ipc, or src/database — the federation module is a pure,
 * self-contained skeleton. The isFederationEnabled()===false assertion is the honesty tripwire.
 */
import { describe, it, expect } from 'vitest';
import {
  FEDERATION_STATUS, isFederationEnabled,
  rbacAllows, ssoPrincipalValid, federationCompatibility,
  FederationErrorCode,
  type DeviceIdentity, type PairingRequest, type PairingResponse,
  type E2EEnvelope, type MtlsEnvelope, type RelayEndpoint, type ProxyConfig,
  type SsoPrincipal, type RbacPolicy, type AuditExport, type AuditExportManifest, type TenantBoundary,
} from '../../src/federation/index.js';

describe('federation skeleton — honesty guard (ADR 0026)', () => {
  it('is experimental + NEVER enabled in a shipped build', () => {
    expect(FEDERATION_STATUS).toBe('experimental-unvalidated');
    expect(isFederationEnabled()).toBe(false);
  });
});

describe('federation skeleton — interfaces compile with the documented field shapes', () => {
  it('constructs a literal of every interface (a drift breaks compilation)', () => {
    const dev: DeviceIdentity = { deviceId: 'd1', publicKeyPem: '-----BEGIN PUBLIC KEY-----', createdAtIso: '2026-01-01T00:00:00.000Z' };
    const pair: PairingRequest = { requestId: 'r1', deviceId: 'd1', enrollmentSecretHash: 'a'.repeat(64), requestedRole: 'member', expiresAtIso: '2026-01-01T00:05:00.000Z' };
    const pres: PairingResponse = { accepted: true, deviceId: 'd1' };
    const e2e: E2EEnvelope = { connId: 'c1', seq: 1, ivB64: 'aXY=', tagB64: 'dGFn', ciphertextB64: 'Y3Q=', aad: 'ctx' };
    const mtls: MtlsEnvelope = { suite: 1, peerCertFingerprint: 'ab:cd', sealed: e2e };
    const relay: RelayEndpoint = { url: 'https://relay.example', direction: 'outbound-only', relayId: 'rl1', verifiedPeer: true };
    const proxy: ProxyConfig = { connectTimeoutMs: 5000, noProxy: ['localhost'] };
    const sso: SsoPrincipal = { subject: 'u@x', issuer: 'idp', tenantId: 't1', roles: ['viewer'], expiresAtIso: '2999-01-01T00:00:00.000Z' };
    const pol: RbacPolicy = { allow: { admin: ['send', 'read'], viewer: ['read'] } };
    const ax: AuditExport = { schemaVersion: 9, fromSeq: 1, toSeq: 100, entryCount: 100, tipHash: 'f'.repeat(64), bodyFree: true };
    const axm: AuditExportManifest = { generatedAtIso: '2026-01-01T00:00:00.000Z', verifyResultOk: true };
    const tb: TenantBoundary = { tenantId: 't1', allowedDeviceIds: ['d1'], isolationLevel: 'strict' };
    // Touch every literal so the compiler + linter can't drop them as unused.
    expect([dev.deviceId, pair.requestId, pres.accepted, mtls.suite, relay.direction, proxy.connectTimeoutMs, sso.subject, pol.allow.admin?.length, ax.bodyFree, axm.verifyResultOk, tb.isolationLevel]).toBeTruthy();
    // The outbound-only literal type is load-bearing (no inbound listener can ever typecheck).
    expect(relay.direction).toBe('outbound-only');
    expect(ax.bodyFree).toBe(true);
  });
});

describe('federation skeleton — pure helpers behave fail-closed', () => {
  it('rbacAllows: allow-listed op passes; unknown role + unlisted op deny', () => {
    const pol: RbacPolicy = { allow: { admin: ['send', 'read'], viewer: ['read'] } };
    expect(rbacAllows(pol, 'admin', 'send').allowed).toBe(true);
    expect(rbacAllows(pol, 'viewer', 'read').allowed).toBe(true);
    expect(rbacAllows(pol, 'viewer', 'send').allowed).toBe(false); // unlisted op
    expect(rbacAllows(pol, 'ghost', 'read').allowed).toBe(false);  // unknown role (fail-closed)
  });
  it('ssoPrincipalValid: future expiry valid, past/empty invalid', () => {
    const base = { subject: 'u', issuer: 'i', tenantId: 't', roles: [] as string[] };
    expect(ssoPrincipalValid({ ...base, expiresAtIso: '2999-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(ssoPrincipalValid({ ...base, expiresAtIso: '2000-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z')).toBe(false);
    expect(ssoPrincipalValid({ ...base, expiresAtIso: '' }, '2026-01-01T00:00:00.000Z')).toBe(false);
  });
  it('federationCompatibility: matching tuples compatible; mismatch incompatible', () => {
    expect(federationCompatibility('xbus-p1-stp1-s9', 'xbus-p1-stp1-s9').ok).toBe(true);
    const bad = federationCompatibility('xbus-p1-stp1-s9', 'xbus-p1-stp1-s8');
    expect(bad.ok).toBe(false);
    expect(bad.result).toBe('incompatible');
  });
  it('FederationErrorCode is a SEPARATE experimental taxonomy (not the live XBusErrorCode)', () => {
    expect(FederationErrorCode.PAIRING_REJECTED).toBe('FEDERATION_PAIRING_REJECTED');
    expect(Object.values(FederationErrorCode).every((c) => c.startsWith('FEDERATION_'))).toBe(true);
  });
});
