/**
 * Beta.8 (ADR 0028): AgenTel rebrand — configuration env-var compatibility.
 *
 * The product is renamed XBus → AgenTel. To honor "agentel is primary; xbus stays a
 * deprecated alias for >=2 releases" without breaking any existing install or script, every
 * CONFIGURATION env var is now read under its `AGENTEL_*` name FIRST, falling back to the
 * legacy `XBUS_*` name. `AGENTEL_*` wins when both are set.
 *
 * SCOPE: this helper is ONLY for configuration inputs the user/launcher sets (data dir,
 * plugin dir, session name, dashboard toggle, unsupported-node override, …). It is deliberately
 * NOT used for the `XBUS_*`-prefixed PROTOCOL ERROR CODE strings (those are wire/contract values
 * and stay `XBUS_*`), nor for on-disk layout, the MCP tool names, or the STP wire tuple — all of
 * which are preserved for compatibility (ADR 0028 Category B).
 */

/** Read a config value under its AgenTel name, falling back to the legacy XBus name.
 *  Pass the bare suffix (e.g. 'DATA_DIR' → checks AGENTEL_DATA_DIR then XBUS_DATA_DIR). */
export function readConfigEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const primary = env[`AGENTEL_${suffix}`];
  if (primary !== undefined) return primary;
  return env[`XBUS_${suffix}`];
}

/** Convenience: is a boolean-ish config flag set to the given "on" value under either prefix? */
export function configEnvEquals(suffix: string, onValue: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readConfigEnv(suffix, env) === onValue;
}
