/**
 * EXPERIMENTAL / UNVALIDATED — federation error taxonomy (beta.7, ADR 0026).
 *
 * A SEPARATE experimental enum, deliberately NOT added to the live `XBusErrorCode`
 * (src/protocol/errors.ts): a new live wire error code implies a wire surface, and federation
 * has none yet. Keeping this standalone keeps the shipped wire taxonomy clean until federation
 * is actually implemented and wired (a future ADR).
 */
export const FederationErrorCode = {
  PAIRING_REJECTED: 'FEDERATION_PAIRING_REJECTED',
  RELAY_UNTRUSTED: 'FEDERATION_RELAY_UNTRUSTED',
  SSO_PRINCIPAL_EXPIRED: 'FEDERATION_SSO_PRINCIPAL_EXPIRED',
  TENANT_BOUNDARY_VIOLATION: 'FEDERATION_TENANT_BOUNDARY_VIOLATION',
  PROXY_UNREACHABLE: 'FEDERATION_PROXY_UNREACHABLE',
} as const;
export type FederationErrorCode = (typeof FederationErrorCode)[keyof typeof FederationErrorCode];
