/**
 * Broker/plugin/version compatibility handshake (ADR 0004).
 *
 * Every connection's `hello` carries full version info. The broker computes a
 * compatibility verdict BEFORE registration is allowed. Incompatible clients
 * fail closed with an actionable verdict; mixed versions cannot proceed to write
 * incompatible database state.
 */
import { PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION, XBUS_VERSION } from './version.js';
import { MIGRATIONS } from '../database/migrations.js';
import { compatibilityId } from '../shared/build-identity.js';

/** Current DB schema version this build expects (max migration version). */
export const SCHEMA_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

/**
 * The STABLE compatibility tuple bound into the XBUS-STP transcript (ADR 0011).
 * This is `xbus-p<proto>-stp<stp>-s<schema>` = "xbus-p1-stp1-s6" as of beta.4
 * (migration v6 moved the schema 5 -> 6; proto + stp remain 1). It is computed from
 * SCHEMA_VERSION, so it tracks the live schema automatically — the value here is only
 * an example. It is deliberately VERSION-INDEPENDENT so different builds interoperate
 * iff it matches.
 *
 * The XBUS-STP v1 wire field is still named `buildId` for byte-compatibility —
 * but it carries this COMPATIBILITY value, never the exact artifact identity.
 * (Exact identity = `provenance.buildId`/`sourceCommit`, reported post-handshake.)
 * The legacy export name `BUILD_ID` is retained as an alias so the wire-construction
 * sites are unchanged; key derivation uses the CLIENT's submitted value, so cross-
 * build handshakes still succeed and the STP vectors (fixture value) are unchanged.
 */
export const WIRE_COMPATIBILITY_ID = compatibilityId(SCHEMA_VERSION);
/** @deprecated name — this is the wire COMPATIBILITY id, not an exact build id. */
export const BUILD_ID = WIRE_COMPATIBILITY_ID;

export interface HelloInfo {
  xbusVersion: string;
  protocolVersion: number;
  minimumProtocolVersion: number;
  maximumProtocolVersion: number;
  schemaVersion: number;
  componentRole: string;
  buildId: string;
  capabilities: string[];
  /** Defense-in-depth shared secret (optional). */
  auth?: string;
}

export type CompatibilityResult =
  | 'compatible'
  | 'upgrade_component'
  | 'restart_broker'
  | 'upgrade_broker'
  | 'migration_required'
  | 'unsupported';

export interface BrokerHelloInfo {
  xbusVersion: string;
  protocolVersion: number;
  minimumProtocolVersion: number;
  maximumProtocolVersion: number;
  schemaVersion: number;
  buildId: string;
  brokerInstanceId: string;
}

export function brokerHelloInfo(brokerInstanceId: string): BrokerHelloInfo {
  return {
    xbusVersion: XBUS_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    minimumProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
    maximumProtocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    buildId: BUILD_ID,
    brokerInstanceId,
  };
}

export interface CompatibilityVerdict {
  result: CompatibilityResult;
  /** Human-actionable explanation (safe to surface). */
  detail: string;
  /** True only when the connection may proceed to register. */
  ok: boolean;
}

/**
 * Decide compatibility between a connecting component (its hello) and this
 * broker. Pure function — easy to exhaustively test for mixed-version cases.
 *
 * The DB schema is owned by whichever build started the broker (it ran the
 * migrations). So:
 *  - protocol ranges must OVERLAP, else unsupported;
 *  - if the component's schema expectation is HIGHER than the broker's, the
 *    broker is older → restart_broker (with the newer build) / upgrade_broker;
 *  - if the component's schema is LOWER than the broker's, the component is older
 *    → upgrade_component (its migrations would not match the live DB);
 *  - equal schema + overlapping protocol → compatible.
 */
export function checkCompatibility(client: HelloInfo, broker: BrokerHelloInfo): CompatibilityVerdict {
  // Protocol overlap: [client.min, client.max] ∩ [broker.min, broker.max] ≠ ∅
  const lo = Math.max(client.minimumProtocolVersion, broker.minimumProtocolVersion);
  const hi = Math.min(client.maximumProtocolVersion, broker.maximumProtocolVersion);
  if (lo > hi) {
    if (client.maximumProtocolVersion < broker.minimumProtocolVersion) {
      return { result: 'upgrade_component', ok: false, detail: `component protocol too old (max ${client.maximumProtocolVersion} < broker min ${broker.minimumProtocolVersion}); update the XBus plugin` };
    }
    return { result: 'upgrade_broker', ok: false, detail: `broker protocol too old (max ${broker.maximumProtocolVersion} < component min ${client.minimumProtocolVersion}); update + restart the broker` };
  }

  // Schema compatibility (the live DB was migrated by the broker's build).
  if (client.schemaVersion > broker.schemaVersion) {
    // Component expects a newer schema than the running broker has applied.
    return { result: 'restart_broker', ok: false, detail: `broker schema v${broker.schemaVersion} is older than the plugin's expected v${client.schemaVersion}; restart the XBus broker so it runs the newer build's migrations` };
  }
  if (client.schemaVersion < broker.schemaVersion) {
    return { result: 'upgrade_component', ok: false, detail: `plugin expects schema v${client.schemaVersion} but the live DB is v${broker.schemaVersion}; update the XBus plugin` };
  }

  return { result: 'compatible', ok: true, detail: 'compatible' };
}
