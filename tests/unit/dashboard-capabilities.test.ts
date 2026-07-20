/**
 * Beta.10 (Train B) — dashboard capability probe (capabilities.js static asset).
 *
 * Pre-staging for the WS1 broker batch (#1 redelivery, #2 instances[], #5 /api/health, collections
 * /api). The dashboard must render NO dead control before an endpoint exists (its own release gate),
 * so optional features are gated on a capability probe: GET /api/health (+ its advertised capability
 * list) and GET /api/collections. When those endpoints don't exist yet the probe reports them absent
 * and the features stay hidden; the flip is automatic the moment WS1 ships them.
 */
import { describe, it, expect } from 'vitest';
import {
  parseHealthCapabilities, probeCapabilities, emptyCaps,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain JS static asset, intentionally untyped
} from '../../src/broker/dashboard/static/capabilities.js';

describe('parseHealthCapabilities — derive feature flags from a /api/health body', () => {
  it('honors an explicit capabilities array exactly', () => {
    const c = parseHealthCapabilities({ build: {}, capabilities: ['redeliver'] });
    expect(c).toEqual({ health: true, redeliver: true, instances: false });
  });
  it('with both advertised, enables both', () => {
    const c = parseHealthCapabilities({ capabilities: ['redeliver', 'instances'] });
    expect(c.redeliver).toBe(true);
    expect(c.instances).toBe(true);
  });
  it('health present but NO explicit list → infer the WS1 batch ships together (both on)', () => {
    const c = parseHealthCapabilities({ build: { version: '0.1.0' }, runtime: {}, ledger: {} });
    expect(c).toEqual({ health: true, redeliver: true, instances: true });
  });
  it('a null/garbage body → nothing enabled (health absent)', () => {
    expect(parseHealthCapabilities(null)).toEqual({ health: false, redeliver: false, instances: false });
    expect(parseHealthCapabilities('nope')).toEqual({ health: false, redeliver: false, instances: false });
  });
});

describe('probeCapabilities — cheap GET probes, never throws, absent endpoints stay off', () => {
  it('health 200 + collections 200 → all flags set from the responses', async () => {
    const api = {
      get: async (path: string) => {
        if (path === '/api/health') return { capabilities: ['redeliver', 'instances'] };
        if (path === '/api/collections') return { version: 1, collections: [], members: {} };
        throw new Error('request failed: 404');
      },
      post: async () => ({ ok: true, status: 200, body: {} }),
    };
    const caps = await probeCapabilities(api);
    expect(caps).toEqual({ health: true, redeliver: true, instances: true, collectionsServer: true });
  });

  it('endpoints absent (both 404) → empty caps, never throws (zero dead controls)', async () => {
    const api = {
      get: async () => { throw new Error('request failed: 404'); },
      post: async () => ({ ok: false, status: 404, body: {} }),
    };
    const caps = await probeCapabilities(api);
    expect(caps).toEqual(emptyCaps());
    expect(caps.health).toBe(false);
    expect(caps.collectionsServer).toBe(false);
  });

  it('health present but collections absent → server-collections stays off, health/redeliver on', async () => {
    const api = {
      get: async (path: string) => {
        if (path === '/api/health') return { build: {}, runtime: {} }; // no explicit caps → inferred
        throw new Error('request failed: 404'); // /api/collections absent
      },
      post: async () => ({ ok: true, status: 200, body: {} }),
    };
    const caps = await probeCapabilities(api);
    expect(caps.health).toBe(true);
    expect(caps.redeliver).toBe(true);
    expect(caps.collectionsServer).toBe(false);
  });
});
