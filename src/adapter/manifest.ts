/**
 * The versioned adapter manifest (§8) + strict, fail-closed validation.
 *
 * Hard rules enforced here (and by the §16 tests):
 *   - unknown REQUIRED manifest version fails closed;
 *   - no absolute entrypoint path; no path escape (`..`);
 *   - no implicit network / shell permission (must be explicitly declared);
 *   - no provider-credential declaration;
 *   - vendorAffiliation is always 'none' (non-affiliation disclosure);
 *   - protocolCompat must equal the frozen xbus-p1-stp1-s5 tuple.
 *
 * An adapter may DECLARE capabilities and a maturity label, but the broker awards
 * the actual support tier (tier.ts) — the manifest cannot self-award.
 */

import { AdapterError, AdapterErrorCode } from './errors.js';
import type { AgentCapabilities } from './capabilities.js';
import { CAPABILITY_STATES } from './capabilities.js';
import { ComponentRole, isComponentRole } from '../identity/components.js';

/** The manifest schema version this build understands. Unknown ⇒ fail closed. */
export const SUPPORTED_MANIFEST_VERSION = 1 as const;

/** The frozen wire compatibility tuple — must match to interoperate as xbus-p1-stp1-s5. */
export const FROZEN_PROTOCOL_COMPAT = { protocol: 1, minProtocol: 1, schema: 5, stp: 1 } as const;

/** Permissions an adapter must explicitly request — nothing is implicit. */
export type AdapterPermission =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'network'
  | 'shell'
  | 'ide.control'
  | 'background.start';

export const ALL_PERMISSIONS: readonly AdapterPermission[] = [
  'filesystem.read', 'filesystem.write', 'network', 'shell', 'ide.control', 'background.start',
];

export type AdapterMaturity = 'experimental' | 'community_validated' | 'xbus_validated' | 'supported';
export const ALL_MATURITY: readonly AdapterMaturity[] = ['experimental', 'community_validated', 'xbus_validated', 'supported'];

/** The only receive mode proven today. Additions are gated behind real-runtime proof. */
export type ReceiveMode = 'hook_checkpoint' | 'manual_pull' | 'live';

export interface AdapterManifest {
  manifestVersion: number;
  adapter: { id: string; name: string; version: string; publisher: string };
  platform: { id: string; displayName: string; supportedRuntimeRange?: string };
  /** Non-affiliation: always 'none'. */
  vendorAffiliation: 'none';
  receiveModes: ReceiveMode[];
  protocolCompat: { protocol: number; minProtocol: number; schema: number; stp: number };
  xbus: { adapterSdkRange: string; protocolRange: string; compatibilityIds?: string[] };
  entrypoint: string;
  declaredCapabilities: AgentCapabilities;
  permissions: AdapterPermission[];
  support: { maturity: AdapterMaturity };
  /** Forwards-compatible: unknown optional keys are preserved + ignored, never error. */
  readonly ext?: Readonly<Record<string, unknown>>;
}

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;            // safe, bounded ids
const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/])/;   // C:\ , /, \\

function fail(message: string, details?: Record<string, unknown>): never {
  throw new AdapterError(AdapterErrorCode.MANIFEST_INVALID, message, details);
}

function assertCapShape(caps: unknown): asserts caps is AgentCapabilities {
  if (!caps || typeof caps !== 'object') fail('declaredCapabilities missing');
  for (const group of ['receive', 'messaging', 'lifecycle', 'execution'] as const) {
    const g = (caps as Record<string, unknown>)[group];
    if (!g || typeof g !== 'object') fail(`declaredCapabilities.${group} missing`);
    for (const [leaf, state] of Object.entries(g as Record<string, unknown>)) {
      if (!(CAPABILITY_STATES as readonly string[]).includes(state as string)) {
        fail(`declaredCapabilities.${group}.${leaf} is not a CapabilityState`, { group, leaf });
      }
    }
  }
}

/**
 * Validate a manifest fail-closed. Returns the typed manifest, or throws AdapterError
 * (MANIFEST_INVALID / INCOMPATIBLE). Never mutates input. The adapter's declared
 * `support.maturity` is accepted as a LABEL only — it does NOT award a tier.
 */
export function validateManifest(raw: unknown): AdapterManifest {
  if (!raw || typeof raw !== 'object') fail('manifest is not an object');
  const m = raw as Partial<AdapterManifest>;

  // Unknown required manifest version ⇒ fail closed (no best-effort parse).
  if (m.manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
    fail(`unsupported manifestVersion ${String(m.manifestVersion)} (this build supports ${SUPPORTED_MANIFEST_VERSION})`, {
      got: typeof m.manifestVersion === 'number' ? m.manifestVersion : -1,
      supported: SUPPORTED_MANIFEST_VERSION,
    });
  }

  if (!m.adapter || !ID_RE.test(m.adapter.id ?? '')) fail('adapter.id missing or not a safe id');
  for (const f of ['name', 'version', 'publisher'] as const) {
    if (typeof m.adapter[f] !== 'string' || !m.adapter[f]) fail(`adapter.${f} missing`);
  }
  if (!m.platform || !ID_RE.test(m.platform.id ?? '')) fail('platform.id missing or not a safe id');
  if (typeof m.platform.displayName !== 'string' || !m.platform.displayName) fail('platform.displayName missing');

  if (m.vendorAffiliation !== 'none') fail("vendorAffiliation must be 'none' (non-affiliation disclosure)");

  if (!Array.isArray(m.receiveModes) || m.receiveModes.length === 0) fail('receiveModes must be a non-empty array');
  for (const rm of m.receiveModes) {
    if (!['hook_checkpoint', 'manual_pull', 'live'].includes(rm)) fail(`unknown receiveMode '${String(rm)}'`, { receiveMode: String(rm) });
  }

  // protocolCompat must equal the frozen tuple (mechanically forbids a silent bump).
  const pc = m.protocolCompat;
  if (!pc || pc.protocol !== FROZEN_PROTOCOL_COMPAT.protocol || pc.minProtocol !== FROZEN_PROTOCOL_COMPAT.minProtocol
        || pc.schema !== FROZEN_PROTOCOL_COMPAT.schema || pc.stp !== FROZEN_PROTOCOL_COMPAT.stp) {
    throw new AdapterError(AdapterErrorCode.INCOMPATIBLE,
      'protocolCompat must equal the frozen xbus-p1-stp1-s5 tuple {protocol:1,minProtocol:1,schema:5,stp:1}',
      { protocol: pc?.protocol ?? -1, schema: pc?.schema ?? -1 });
  }

  if (!m.xbus || typeof m.xbus.adapterSdkRange !== 'string' || typeof m.xbus.protocolRange !== 'string') fail('xbus.adapterSdkRange / protocolRange missing');

  // Entrypoint containment: no absolute path, no parent escape, no URL/scheme.
  const ep = m.entrypoint;
  if (typeof ep !== 'string' || ep.length === 0) fail('entrypoint missing');
  if (ABS_PATH_RE.test(ep)) fail('entrypoint must be a package-relative path, not absolute', { });
  if (ep.split(/[\\/]/).some((seg) => seg === '..')) fail('entrypoint must not escape the package root (no "..")');
  if (/^[a-z][a-z0-9+.-]*:/i.test(ep)) fail('entrypoint must not be a URL/scheme');

  assertCapShape(m.declaredCapabilities);

  if (!Array.isArray(m.permissions)) fail('permissions must be an array (use [] for none)');
  for (const p of m.permissions) {
    if (!(ALL_PERMISSIONS as readonly string[]).includes(p)) fail(`unknown permission '${String(p)}'`, { permission: String(p) });
  }
  // No provider-credential permission may be declared (none exists; reject any attempt).
  if ((m.permissions as string[]).some((p) => /credential|provider|token|apikey|api-key/i.test(p))) {
    fail('adapters must not declare provider-credential permissions');
  }

  if (!m.support || !(ALL_MATURITY as readonly string[]).includes(m.support.maturity)) fail('support.maturity missing or invalid');

  // Build a clean, typed manifest (drops nothing functional; preserves ext).
  // Optional props are included only when present (exactOptionalPropertyTypes).
  const platform: AdapterManifest['platform'] = { id: m.platform.id, displayName: m.platform.displayName };
  if (m.platform.supportedRuntimeRange !== undefined) platform.supportedRuntimeRange = m.platform.supportedRuntimeRange;
  const xbus: AdapterManifest['xbus'] = { adapterSdkRange: m.xbus.adapterSdkRange, protocolRange: m.xbus.protocolRange };
  if (m.xbus.compatibilityIds !== undefined) xbus.compatibilityIds = m.xbus.compatibilityIds;
  const out: AdapterManifest = {
    manifestVersion: SUPPORTED_MANIFEST_VERSION,
    adapter: { id: m.adapter.id, name: m.adapter.name, version: m.adapter.version, publisher: m.adapter.publisher },
    platform,
    vendorAffiliation: 'none',
    receiveModes: [...m.receiveModes],
    protocolCompat: { ...FROZEN_PROTOCOL_COMPAT },
    xbus,
    entrypoint: ep,
    declaredCapabilities: m.declaredCapabilities,
    permissions: [...m.permissions],
    support: { maturity: m.support.maturity },
  };
  if (m.ext !== undefined) (out as { ext?: Readonly<Record<string, unknown>> }).ext = m.ext;
  return out;
}

/** Whether a manifest declared a given permission (default-deny). */
export function hasPermission(m: AdapterManifest, p: AdapterPermission): boolean {
  return m.permissions.includes(p);
}

export { isComponentRole, ComponentRole };
