/**
 * Protocol version + compatibility rules.
 *
 * XBus uses a single integer protocol version negotiated in the `hello`
 * handshake. The broker and channel/CLI clients must agree on a compatible
 * version before any session is registered.
 */

/** Current wire protocol version. Bump on any breaking frame/envelope change. */
export const PROTOCOL_VERSION = 1 as const;

/** Minimum protocol version this build can still talk to. */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1 as const;

/** XBus product version (kept in sync with package.json at build time). */
export const XBUS_VERSION = '0.1.0-beta.2' as const;

/**
 * Decide whether a peer's advertised protocol version is acceptable.
 * Compatibility is intentionally strict for v1: exact-or-within-range only.
 */
export function isProtocolCompatible(peerVersion: number): boolean {
  return (
    Number.isInteger(peerVersion) &&
    peerVersion >= MIN_SUPPORTED_PROTOCOL_VERSION &&
    peerVersion <= PROTOCOL_VERSION
  );
}
