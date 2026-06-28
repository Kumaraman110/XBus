/**
 * Adapter-SDK contract version (§34 axis 5). Independent of PROTOCOL_VERSION,
 * STP_VERSION, and SCHEMA_VERSION (the three frozen wire axes). Bumping this does
 * NOT bump the wire composite `xbus-p1-stp1-s5`.
 */
export const ADAPTER_SDK_VERSION = '0.1.0' as const;
