import { describe, it, expect } from 'vitest';
import { checkCompatibility, brokerHelloInfo, SCHEMA_VERSION, BUILD_ID, type HelloInfo } from '../../src/protocol/handshake.js';

const broker = brokerHelloInfo('broker-1');

function client(over: Partial<HelloInfo>): HelloInfo {
  return {
    xbusVersion: '0.1.0', protocolVersion: broker.protocolVersion,
    minimumProtocolVersion: broker.minimumProtocolVersion, maximumProtocolVersion: broker.maximumProtocolVersion,
    schemaVersion: broker.schemaVersion, componentRole: 'mcp', buildId: BUILD_ID, capabilities: [],
    ...over,
  };
}

describe('checkCompatibility (mixed-version matrix)', () => {
  it('identical builds are compatible', () => {
    expect(checkCompatibility(client({}), broker).result).toBe('compatible');
  });

  it('protocol overlap present -> compatible', () => {
    // client supports [1..broker.max], broker [1..max] -> overlap
    const v = checkCompatibility(client({ minimumProtocolVersion: 1, maximumProtocolVersion: broker.maximumProtocolVersion }), broker);
    expect(v.ok).toBe(true);
  });

  it('no protocol overlap, client too old -> upgrade_component', () => {
    const v = checkCompatibility(client({ minimumProtocolVersion: 0, maximumProtocolVersion: broker.minimumProtocolVersion - 1 }), broker);
    expect(v.result).toBe('upgrade_component');
    expect(v.ok).toBe(false);
  });

  it('no protocol overlap, broker too old -> upgrade_broker', () => {
    const v = checkCompatibility(client({ minimumProtocolVersion: broker.maximumProtocolVersion + 1, maximumProtocolVersion: broker.maximumProtocolVersion + 2 }), broker);
    expect(v.result).toBe('upgrade_broker');
    expect(v.ok).toBe(false);
  });

  it('schema too new (broker older) -> restart_broker', () => {
    const v = checkCompatibility(client({ schemaVersion: broker.schemaVersion + 1 }), broker);
    expect(v.result).toBe('restart_broker');
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/restart/i);
  });

  it('schema too old (component older) -> upgrade_component', () => {
    const v = checkCompatibility(client({ schemaVersion: broker.schemaVersion - 1 }), broker);
    expect(v.result).toBe('upgrade_component');
    expect(v.ok).toBe(false);
  });

  it('broker hello info exposes version/protocol/schema/build', () => {
    expect(broker.schemaVersion).toBe(SCHEMA_VERSION);
    expect(broker.buildId).toBe(BUILD_ID);
    expect(broker.protocolVersion).toBeGreaterThanOrEqual(1);
  });

  it('ADR 0012/0019 §3: an older-schema client (s5) is rejected upgrade_component by the current broker', () => {
    // Beta.8 bumped SCHEMA_VERSION to 10 (ADR 0027 durable logical identity + name ownership,
    // migration v10). A still-installed older plugin advertising a lower schema MUST be
    // told to upgrade rather than be allowed to write against a schema it does not
    // understand. This is the fail-closed guard the bump buys (ADR 0019 — no
    // mixed-version operation).
    expect(SCHEMA_VERSION).toBe(10);
    const beta3 = client({ schemaVersion: 5 });
    const v = checkCompatibility(beta3, broker);
    expect(v.result).toBe('upgrade_component');
    expect(v.ok).toBe(false);
  });
});
