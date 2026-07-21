/**
 * BETA.10 (ADR 0036) — XBus activation-state model. ONE place that names the states the launcher /
 * plugin / hooks / MCP split can be in, and derives the current state from observable signals so
 * `xbus doctor` and the SessionStart hook report the SAME honest verdict (never "connected" when the
 * plugin did not load).
 *
 * The split-state defect: hooks are user-scoped in settings.json, so a BARE `claude` (no plugin)
 * still fires SessionStart and can announce a HOOK component — while the MCP server (xbus_* tools)
 * never loaded. This model makes that state (PLUGIN_NOT_LOADED / DEGRADED_HOOK_ONLY) explicit and
 * unmistakable instead of presenting hook-only operation as normal XBus.
 *
 * No schema/protocol/compat change — this is a diagnostic derivation over existing broker state
 * (component_instances roles) + a filesystem MCP-load marker.
 */

/** The activation states XBus can be in for a given Claude session. */
export type ActivationState =
  | 'CONNECTED' // MCP server loaded + broker reachable + this session registered an mcp component
  | 'PLUGIN_NOT_LOADED' // bare `claude` (no plugin): the MCP server never loaded this session
  | 'MCP_DISCONNECTED' // plugin loaded (mcp attempted) but the MCP<->broker channel is currently down
  | 'BROKER_UNAVAILABLE' // MCP loaded but no broker is running/reachable
  | 'DEGRADED_HOOK_ONLY'; // explicit, reported hook-only operation (announced, but no mcp capability)

export interface ActivationVerdict {
  state: ActivationState;
  /** Human, one line — safe to print at session start / in doctor. NEVER says "connected" unless CONNECTED. */
  summary: string;
  /** The exact canonical launch command to get a fully-connected session (when not CONNECTED). */
  remedy?: string;
  /** True only for CONNECTED — callers must not describe any other state as connected. */
  connected: boolean;
}

/** The canonical launcher command (never shadows system `claude`). */
export const CANONICAL_LAUNCH = 'xclaude';

/**
 * Signals observable at diagnosis time. All optional/nullable so a caller can supply only what it
 * cheaply knows; the classifier degrades to the most honest state it can prove.
 */
export interface ActivationSignals {
  /** Did the MCP server load in THIS process/session? (the plugin-loaded signal). For the MCP
   *  server itself this is true; for a hook it is derived from the broker + marker, below. */
  mcpLoadedThisSession?: boolean | undefined;
  /** Is a broker running/reachable at all? */
  brokerReachable?: boolean | undefined;
  /** Has an `mcp`-role component ever registered for this session id on the broker? (broker truth) */
  mcpComponentRegistered?: boolean | undefined;
  /** Is the MCP<->broker channel currently connected? (only meaningful when the MCP server loaded) */
  mcpChannelConnected?: boolean | undefined;
  /** Did a hook announce this session (hook-role component present)? */
  hookAnnounced?: boolean | undefined;
}

/**
 * Classify the activation state from signals. Precedence is chosen so the MOST honest,
 * least-overclaiming verdict wins: we never say CONNECTED without a live mcp channel, and a
 * plugin-absent session is PLUGIN_NOT_LOADED (or DEGRADED_HOOK_ONLY if it did announce a hook),
 * never "connected".
 */
export function classifyActivation(s: ActivationSignals): ActivationVerdict {
  const relaunch = `run \`${CANONICAL_LAUNCH}\` to launch Claude Code with the XBus plugin loaded`;

  // 1. No broker at all → BROKER_UNAVAILABLE takes precedence only when the plugin DID load
  //    (an mcp component tried); a bare-claude session with no broker is still PLUGIN_NOT_LOADED,
  //    because the missing plugin is the primary, user-actionable fact.
  const pluginLoaded = s.mcpLoadedThisSession === true || s.mcpComponentRegistered === true;

  if (!pluginLoaded) {
    // The MCP server never loaded this session. If a hook nonetheless announced, that is the
    // dishonest split-state we must name explicitly — but the user-actionable remedy is the same.
    if (s.hookAnnounced === true) {
      return {
        state: 'DEGRADED_HOOK_ONLY',
        summary: 'XBus is running HOOK-ONLY: the plugin (xbus_* MCP tools) did NOT load this session — this is NOT a connected XBus session.',
        remedy: relaunch,
        connected: false,
      };
    }
    return {
      state: 'PLUGIN_NOT_LOADED',
      summary: 'XBus plugin did NOT load this session (bare `claude`): no xbus_* tools are available.',
      remedy: relaunch,
      connected: false,
    };
  }

  // 2. Plugin loaded. Now grade the broker/channel health.
  if (s.brokerReachable === false) {
    return {
      state: 'BROKER_UNAVAILABLE',
      summary: 'XBus plugin loaded, but no broker is reachable.',
      remedy: `run \`${CANONICAL_LAUNCH === 'xclaude' ? 'xbus start' : 'xbus start'}\` (or relaunch) — the broker auto-starts on the next tool call`,
      connected: false,
    };
  }
  if (s.mcpChannelConnected === false) {
    return {
      state: 'MCP_DISCONNECTED',
      summary: 'XBus plugin loaded and a broker is up, but the MCP↔broker channel is currently disconnected (will reconnect on the next tool call).',
      connected: false,
    };
  }

  // 3. Everything up.
  return {
    state: 'CONNECTED',
    summary: 'XBus CONNECTED: plugin loaded, broker reachable, session registered.',
    connected: true,
  };
}
