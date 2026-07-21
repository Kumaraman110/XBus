/**
 * BETA.10 (ADR 0036) — activation-state classifier unit tests. Pure signal→state mapping; the
 * single classifier both `xbus doctor` and the Stop hook use. Asserts the honesty rules: only
 * CONNECTED is `connected`; plugin-absence never claims connected; the five states are distinct.
 */
import { describe, it, expect } from 'vitest';
import { classifyActivation, CANONICAL_LAUNCH } from '../../src/channel/activation-state.js';

describe('classifyActivation — signal→state, honesty rules', () => {
  it('CONNECTED requires plugin loaded + broker reachable + mcp channel live', () => {
    const v = classifyActivation({ mcpComponentRegistered: true, brokerReachable: true, mcpChannelConnected: true });
    expect(v.state).toBe('CONNECTED');
    expect(v.connected).toBe(true);
    expect(v.remedy).toBeUndefined();
  });

  it('PLUGIN_NOT_LOADED when no mcp component and no hook announce — never connected, has remedy', () => {
    const v = classifyActivation({ mcpComponentRegistered: false, hookAnnounced: false, brokerReachable: true });
    expect(v.state).toBe('PLUGIN_NOT_LOADED');
    expect(v.connected).toBe(false);
    expect(v.remedy).toContain(CANONICAL_LAUNCH);
    expect(v.summary.toLowerCase()).not.toContain('connected: plugin loaded');
  });

  it('DEGRADED_HOOK_ONLY when a hook announced but the mcp never loaded (the split-state) — not connected', () => {
    const v = classifyActivation({ mcpComponentRegistered: false, hookAnnounced: true, brokerReachable: true });
    expect(v.state).toBe('DEGRADED_HOOK_ONLY');
    expect(v.connected).toBe(false);
    expect(v.remedy).toContain(CANONICAL_LAUNCH);
    expect(v.summary).toMatch(/NOT a connected/i);
  });

  it('MCP_DISCONNECTED when the plugin loaded + broker up but the channel is down — not connected', () => {
    const v = classifyActivation({ mcpComponentRegistered: true, brokerReachable: true, mcpChannelConnected: false });
    expect(v.state).toBe('MCP_DISCONNECTED');
    expect(v.connected).toBe(false);
  });

  it('BROKER_UNAVAILABLE when the plugin loaded but no broker is reachable — not connected', () => {
    const v = classifyActivation({ mcpComponentRegistered: true, brokerReachable: false });
    expect(v.state).toBe('BROKER_UNAVAILABLE');
    expect(v.connected).toBe(false);
  });

  it('plugin-absence takes precedence over broker state (bare claude with no broker = PLUGIN_NOT_LOADED, not BROKER_UNAVAILABLE)', () => {
    const v = classifyActivation({ mcpComponentRegistered: false, hookAnnounced: false, brokerReachable: false });
    expect(v.state).toBe('PLUGIN_NOT_LOADED');
  });

  it('NEVER reports connected for any non-CONNECTED state', () => {
    for (const sig of [
      { mcpComponentRegistered: false, hookAnnounced: false },
      { mcpComponentRegistered: false, hookAnnounced: true },
      { mcpComponentRegistered: true, brokerReachable: true, mcpChannelConnected: false },
      { mcpComponentRegistered: true, brokerReachable: false },
    ]) {
      expect(classifyActivation(sig).connected).toBe(false);
    }
  });
});
