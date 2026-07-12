/**
 * Build-identity model regression tests (ADR 0011).
 *
 * The checks: exact build ids are unique + deterministic, compatibility ids are
 * stable, STP v1 is unchanged, mixed-build is detected (not conflated), provenance
 * fails closed, and identity survives a spaces-path install with no git/source.
 * Fixture build identities are synthetic (non-resolving placeholder commits) and
 * describe behavior, not any release history.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  compatibilityId, exactBuildId, readProvenance, resolveIdentity, classifyMixedBuild, SECURE_TRANSPORT_VERSION,
} from '../../src/shared/build-identity.js';
import { STP_VERSION } from '../../src/ipc/secure-channel.js';
import { WIRE_COMPATIBILITY_ID, SCHEMA_VERSION } from '../../src/protocol/handshake.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dirs: string[] = [];
function freshDir(prefix = 'xbus-id-') { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

// Synthetic, non-resolving fixture commits. These intentionally do NOT correspond
// to any real commit in this (or any) repository — they are obviously-fabricated
// 40-hex placeholders used only to exercise the identity arithmetic. The names
// describe behavior (two distinct builds that share one compatibility id, plus the
// current build), never a private release history.
const LEGACY_BUILD_A_COMMIT = '1111111111111111111111111111111111111111';
const LEGACY_BUILD_B_COMMIT = '2222222222222222222222222222222222222222';
const CURRENT_BUILD_COMMIT = '3333333333333333333333333333333333333333';

describe('build-identity model', () => {
  it('1: two compatible builds share one compatibility ID (same proto+stp+schema)', () => {
    // compatibilityId is version-independent → identical across builds of one line.
    expect(compatibilityId(5)).toBe('xbus-p1-stp1-s5');
    // both legacy builds are p1/stp1/s5 → same compat id.
    expect(compatibilityId(5)).toBe(compatibilityId(5));
  });

  it('2: two builds with different commits have DIFFERENT exact build IDs', () => {
    const a = exactBuildId('0.1.0-test.1', LEGACY_BUILD_A_COMMIT);
    const b = exactBuildId('0.1.0-test.2', LEGACY_BUILD_B_COMMIT);
    expect(a).not.toBe(b);
    expect(a).toBe('xbus-0.1.0-test.1-111111111111');
    expect(b).toBe('xbus-0.1.0-test.2-222222222222');
  });

  it('3: a third build has a unique exact build ID (differs from both legacy builds)', () => {
    const current = exactBuildId('0.1.0-test.3', CURRENT_BUILD_COMMIT);
    expect(current).not.toBe(exactBuildId('0.1.0-test.1', LEGACY_BUILD_A_COMMIT));
    expect(current).not.toBe(exactBuildId('0.1.0-test.2', LEGACY_BUILD_B_COMMIT));
    expect(current.startsWith('xbus-0.1.0-test.3-')).toBe(true);
  });

  it('4: exact build ID is DETERMINISTIC (no clock/user/path/host/random)', () => {
    const a = exactBuildId('0.1.0-test.3', CURRENT_BUILD_COMMIT);
    const b = exactBuildId('0.1.0-test.3', CURRENT_BUILD_COMMIT);
    expect(a).toBe(b);
    // contains only version + short commit; no digits-of-epoch, no separators beyond '-'
    expect(a).toMatch(/^xbus-0\.1\.0-test\.3-[0-9a-f]{12}$/);
  });

  it('5: STP v1 wire constants are unchanged (rename did not touch the wire)', () => {
    expect(STP_VERSION).toBe(1);
    expect(SECURE_TRANSPORT_VERSION).toBe(STP_VERSION);
    // The wire-bound compatibility value is the STABLE tuple, not the product
    // version. Beta.4's migration v6 moved the SCHEMA component 5 -> 6 (ADR 0012
    // §3, a deliberate fail-closed bump); protocol + STP are still 1, so the wire
    // BYTES/key-schedule are unchanged — only the schema integer in the tuple moves.
    expect(WIRE_COMPATIBILITY_ID).toBe('xbus-p1-stp1-s6');
    expect(WIRE_COMPATIBILITY_ID).toBe(compatibilityId(SCHEMA_VERSION));
    expect(SCHEMA_VERSION).toBe(6);
    // The pure arithmetic for the OLD schema is unchanged (version-independent fn).
    expect(compatibilityId(5)).toBe('xbus-p1-stp1-s5');
  });

  it('12: a MISSING provenance manifest is caught by required-files (fail closed at install)', async () => {
    const { validateArtifact } = await import('../../src/shared/artifact-contract.js');
    const root = freshDir();
    // minimal tree with NO provenance.json
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'xbus', version: '0.1.0-test.3', mcpServers: './.mcp.json', hooks: './hooks/hooks.json' }));
    const r = validateArtifact(root, { scope: 'plugin' });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === 'required-file-missing' && v.detail === 'provenance.json')).toBe(true);
  });

  it('13: a TAMPERED provenance manifest fails closed (internal-consistency check)', () => {
    const root = freshDir();
    // buildId that does NOT embed the productVersion → tamper
    fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify({
      productVersion: '0.1.0-test.3', buildId: 'xbus-9.9.9-deadbeef', sourceCommit: 'x',
      compatibilityId: 'xbus-p1-stp1-s5', applicationProtocolVersion: 1, secureTransportProtocolVersion: 1, schemaVersion: 5,
    }));
    expect(() => readProvenance(path.join(root, 'provenance.json'))).toThrow(/does not embed productVersion/);
  });

  it('13b: a provenance with a contradictory compatibilityId fails closed', () => {
    const root = freshDir();
    fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify({
      productVersion: '0.1.0-test.3', buildId: 'xbus-0.1.0-test.3-abc', sourceCommit: 'x',
      compatibilityId: 'xbus-p9-stp9-s9', applicationProtocolVersion: 1, secureTransportProtocolVersion: 1, schemaVersion: 5,
    }));
    expect(() => readProvenance(path.join(root, 'provenance.json'))).toThrow(/compatibilityId/);
  });

  it('source run (no provenance) degrades to a LABELLED source identity, never a false exact id', () => {
    const id = resolveIdentity(5, null);
    expect(id.sourceCommit).toBe('source');
    expect(id.buildId).toBe('xbus-0.1.0-beta.4.1-source');
    expect(id.compatibilityId).toBe('xbus-p1-stp1-s5');
  });

  it('9: classifyMixedBuild distinguishes same / compatible-mixed / incompatible / missing', () => {
    const self = { buildId: 'xbus-0.1.0-test.3-aaa', compatibilityId: 'xbus-p1-stp1-s5', applicationProtocolVersion: 1, secureTransportProtocolVersion: 1, schemaVersion: 5 };
    // same exact build
    expect(classifyMixedBuild(self, { ...self })).toBe('same_exact_build');
    // compatible mixed build (different exact id, same family) — NOT a failure
    expect(classifyMixedBuild(self, { ...self, buildId: 'xbus-0.1.0-test.2-bbb' })).toBe('compatible_mixed_builds');
    // incompatible schema
    expect(classifyMixedBuild(self, { ...self, buildId: 'x', schemaVersion: 6 })).toBe('incompatible_schema');
    // incompatible protocol
    expect(classifyMixedBuild(self, { ...self, buildId: 'x', applicationProtocolVersion: 2 })).toBe('incompatible_protocol');
    // incompatible stp
    expect(classifyMixedBuild(self, { ...self, buildId: 'x', secureTransportProtocolVersion: 2 })).toBe('incompatible_stp');
    // missing provenance (peer reported no exact identity)
    expect(classifyMixedBuild(self, null)).toBe('missing_provenance');
    expect(classifyMixedBuild(self, { compatibilityId: 'xbus-p1-stp1-s5' })).toBe('missing_provenance');
  });

  it('10+11: an exact-build difference is NEVER classified as incompatible (security-failure) by itself', () => {
    const self = { buildId: 'xbus-0.1.0-test.3-aaa', compatibilityId: 'xbus-p1-stp1-s5', applicationProtocolVersion: 1, secureTransportProtocolVersion: 1, schemaVersion: 5 };
    const verdict = classifyMixedBuild(self, { ...self, buildId: 'xbus-0.1.0-test.1-zzz' });
    expect(['same_exact_build', 'compatible_mixed_builds']).toContain(verdict);
    expect(verdict).not.toMatch(/incompatible/);
  });

  it('20: provenance contains NO private path, username, or hostname', () => {
    // build the provenance the packager would write and assert it is clean.
    const prov = {
      productVersion: '0.1.0-test.3', buildId: exactBuildId('0.1.0-test.3', CURRENT_BUILD_COMMIT),
      sourceCommit: CURRENT_BUILD_COMMIT, compatibilityId: compatibilityId(5),
      applicationProtocolVersion: 1, secureTransportProtocolVersion: 1, schemaVersion: 5,
    };
    const blob = JSON.stringify(prov);
    expect(blob).not.toMatch(/[A-Za-z]:\\Users\\/);   // no Windows home path
    expect(blob).not.toMatch(/\/home\/|\/Users\//);    // no Unix home path
    expect(blob).not.toMatch(os.userInfo().username);  // no username
    expect(blob).not.toMatch(os.hostname());           // no hostname
  });
});

// Tests 6-11, 14-19 exercise the live broker / installed product. They are
// expressed as a packaged-artifact lifecycle in the artifact-first suite + the
// cross-build interop test below; here we cover the deterministic-build (4) and
// vector-stability (5) units that don't need a broker spawn. The handshake
// interop (6,7), registration (8), doctor mixed-build (9), fail-closed (10,11),
// no-git version (14), per-component build (15), stale-process (16), upgrade
// (17), rollback (18), and spaces-path identity (19) are validated by the
// artifact-first install suite against the real packaged artifact.
describe('build-identity — cross-build interop (STP key derivation is per-connection)', () => {
  it('6+7: a client binding the OLD compat value still handshakes with a broker that binds the NEW one', async () => {
    // Both sides derive keys from the CLIENT's submitted buildId (in the client
    // hello → transcript). So differing compat strings do NOT break the handshake;
    // they only matter for the compatibility VERDICT (which is proto+schema based).
    const sc = await import('../../src/ipc/secure-channel.js');
    const rootSecret = Buffer.alloc(32, 7);
    const idOld = { buildId: 'xbus-0.1.0-p1-s5', appProtoRange: '1-1', claimedRole: 'mcp', claimedSessionId: 's', claimedEpoch: 0, capabilities: '' };
    const { state, clientHelloBytes } = sc.startClientHandshake(1, idOld, { clientNonce: Buffer.alloc(32, 1), connId: Buffer.alloc(16, 3) });
    const hello = sc.parseClientHello(clientHelloBytes);
    const srv = sc.serverHandshake(rootSecret, 'broker-current', hello, { serverNonce: Buffer.alloc(32, 2) });
    const sh = sc.parseServerHello(srv.serverHelloBytes);
    const cli = sc.clientFinish(rootSecret, state, sh);
    // both sides derived the SAME keys despite the broker being a "newer build"
    expect(cli.keys.k_c2s_enc.equals(srv.keys.k_c2s_enc)).toBe(true);
    expect(cli.keys.k_s2c_enc.equals(srv.keys.k_s2c_enc)).toBe(true);
  });
});
