/**
 * The NORMATIVE build-identity model (ADR 0011).
 *
 * An earlier build carried a provenance ambiguity: the single field `buildId` was a
 * compatibility tuple (`xbus-<version>-p<proto>-s<schema>`, NO commit) that was
 * BOTH bound into the XBUS-STP transcript AND named/documented as if it were the
 * exact artifact identity. Successive builds therefore produced an identical `buildId`
 * and were operationally indistinguishable.
 *
 * This module separates the concepts that must never be conflated:
 *
 *   productVersion       human release id (e.g. "0.1.0-test.1")
 *   compatibilityId      STABLE interop tuple bound into the STP handshake:
 *                        "xbus-p<proto>-stp<stp>-s<schema>" — version-INDEPENDENT,
 *                        so different builds interoperate iff this matches. This is
 *                        the value the legacy STP v1 wire field named `buildId`
 *                        carries (see ADR 0011 + the secure-transport spec). The
 *                        wire format + bytes + vectors are UNCHANGED.
 *   buildId (EXACT)      "xbus-<productVersion>-<shortCommit>" — uniquely identifies
 *                        the exact source build; deterministic; NO timestamp /
 *                        username / path / hostname / random. Diagnostics ONLY,
 *                        never bound into the handshake.
 *   sourceCommit         full git commit SHA used to produce the artifact.
 *
 * Exact identity (buildId/sourceCommit) is read from the packaged provenance
 * manifest at runtime (provenance.json), so it works with NO git + NO source
 * checkout. From a source/dev run with no provenance, it degrades to a clearly
 * labelled "source" identity — never a false exact id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, XBUS_VERSION } from '../protocol/version.js';

/** XBUS-STP wire version (kept here to avoid importing the crypto module). MUST
 *  equal STP_VERSION in secure-channel.ts (asserted by a test). */
export const SECURE_TRANSPORT_VERSION = 1;

export interface Provenance {
  productVersion: string;
  buildId: string;        // exact: xbus-<version>-<shortCommit>
  sourceCommit: string;   // full SHA (or 'source' when unbuilt)
  compatibilityId: string;
  applicationProtocolVersion: number;
  secureTransportProtocolVersion: number;
  schemaVersion: number;
}

/** The STABLE compatibility tuple — version-independent; the value bound into the
 *  STP transcript (legacy wire field name `buildId`). */
export function compatibilityId(schemaVersion: number): string {
  return `xbus-p${PROTOCOL_VERSION}-stp${SECURE_TRANSPORT_VERSION}-s${schemaVersion}`;
}

/** §7 — the mixed-build verdict between two components. Exact-build difference
 *  is NEVER a security failure by itself; it is a diagnostic. Incompatibility is
 *  decided by protocol/STP/schema (NOT the exact build id). */
export type MixedBuildStatus =
  | 'same_exact_build'
  | 'compatible_mixed_builds'
  | 'incompatible_protocol'
  | 'incompatible_stp'
  | 'incompatible_schema'
  | 'missing_provenance';

export interface IdentityFacet {
  buildId?: string;
  compatibilityId?: string;
  applicationProtocolVersion?: number;
  secureTransportProtocolVersion?: number;
  schemaVersion?: number;
}

/** Classify the relationship between THIS process's identity and a peer's. */
export function classifyMixedBuild(self: IdentityFacet, peer: IdentityFacet | null | undefined): MixedBuildStatus {
  if (!peer || !peer.buildId || !peer.compatibilityId) return 'missing_provenance';
  if (peer.applicationProtocolVersion !== undefined && self.applicationProtocolVersion !== undefined && peer.applicationProtocolVersion !== self.applicationProtocolVersion) return 'incompatible_protocol';
  if (peer.secureTransportProtocolVersion !== undefined && self.secureTransportProtocolVersion !== undefined && peer.secureTransportProtocolVersion !== self.secureTransportProtocolVersion) return 'incompatible_stp';
  if (peer.schemaVersion !== undefined && self.schemaVersion !== undefined && peer.schemaVersion !== self.schemaVersion) return 'incompatible_schema';
  // compatible — same family. Same exact build, or a compatible mixed build?
  return peer.buildId === self.buildId ? 'same_exact_build' : 'compatible_mixed_builds';
}

/** Deterministic exact build id from a product version + a commit (no clock, no
 *  user, no path, no host, no randomness). `commit` may be a full or short SHA. */
export function exactBuildId(productVersion: string, commit: string): string {
  const short = (commit && commit !== 'unknown') ? commit.slice(0, 12) : 'source';
  return `xbus-${productVersion}-${short}`;
}

/** Locate the packaged provenance manifest relative to a compiled module. The
 *  artifact layout is <root>/dist/...; provenance.json lives at <root>/provenance.json. */
export function provenancePathFromDist(distModuleUrl: string): string {
  // distModuleUrl is e.g. file://<root>/dist/shared/build-identity.js
  const here = path.dirname(fileURLToPath(distModuleUrl)); // <root>/dist/shared
  return path.resolve(here, '..', '..', 'provenance.json'); // <root>/provenance.json
}

/** Read + validate the packaged provenance manifest. Returns null if absent
 *  (source/dev run). THROWS on a present-but-malformed/contradictory manifest
 *  (fail-closed — a tampered provenance must never silently degrade). */
export function readProvenance(provenancePath: string): Provenance | null {
  if (!fs.existsSync(provenancePath)) return null;
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(provenancePath, 'utf8')); }
  catch (e) { throw new Error(`provenance.json is present but malformed: ${(e as Error).message}`, { cause: e }); }
  const p = raw as Partial<Provenance>;
  const required: Array<keyof Provenance> = ['productVersion', 'buildId', 'sourceCommit', 'compatibilityId', 'applicationProtocolVersion', 'secureTransportProtocolVersion', 'schemaVersion'];
  for (const k of required) {
    if (p[k] === undefined || p[k] === null) throw new Error(`provenance.json missing required field: ${String(k)}`);
  }
  // Internal consistency: buildId must embed the productVersion; compatibilityId
  // must match the declared protocol/stp/schema tuple. A mismatch is tampering.
  if (!String(p.buildId).startsWith(`xbus-${String(p.productVersion)}-`)) {
    throw new Error(`provenance.json buildId "${String(p.buildId)}" does not embed productVersion "${String(p.productVersion)}"`);
  }
  const expectCompat = `xbus-p${Number(p.applicationProtocolVersion)}-stp${Number(p.secureTransportProtocolVersion)}-s${Number(p.schemaVersion)}`;
  if (p.compatibilityId !== expectCompat) {
    throw new Error(`provenance.json compatibilityId "${String(p.compatibilityId)}" != computed "${expectCompat}"`);
  }
  return p as Provenance;
}

/**
 * Resolve THIS process's identity: prefer the packaged provenance manifest (exact,
 * install-time truth), else a source-run identity computed from the in-code version
 * + schema with a 'source' commit. `schemaVersion` is passed in to avoid importing
 * the migrations graph here.
 */
export function resolveIdentity(schemaVersion: number, provenance: Provenance | null): Provenance {
  if (provenance) return provenance;
  // Source/dev run: no packaged provenance. Label honestly — exact id is NOT known.
  return {
    productVersion: XBUS_VERSION,
    buildId: exactBuildId(XBUS_VERSION, 'source'),
    sourceCommit: 'source',
    compatibilityId: compatibilityId(schemaVersion),
    applicationProtocolVersion: PROTOCOL_VERSION,
    secureTransportProtocolVersion: SECURE_TRANSPORT_VERSION,
    schemaVersion,
  };
}
