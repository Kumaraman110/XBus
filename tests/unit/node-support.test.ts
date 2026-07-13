/**
 * §8 — the Node support boundary (>=22.13 <25) + actionable unsupported-Node error.
 * Beta.5 raised the floor 22.5 -> 22.13 because the control-plane dashboard needs
 * node:sqlite `DatabaseSync({ readOnly: true })` (landed 22.12/22.13) for a physically
 * read-only worker; an older 22.x silently ignores it, yielding a WRITABLE handle.
 */
import { describe, it, expect } from 'vitest';
import { evaluateNodeSupport, assertSupportedNode, parseNodeVersion } from '../../src/shared/node-support.js';

describe('node support boundary (>=22.13 <25)', () => {
  it('parses versions', () => {
    expect(parseNodeVersion('v22.13.1')).toEqual({ major: 22, minor: 13 });
    expect(parseNodeVersion('24.0.0')).toEqual({ major: 24, minor: 0 });
  });
  it('accepts Node 22.13+, 23, 24 (readOnly-capable)', () => {
    for (const v of ['v22.13.0', 'v22.14.0', 'v23.6.0', 'v24.0.0', 'v24.9.9']) {
      expect(evaluateNodeSupport(v).ok, v).toBe(true);
    }
  });
  it('rejects < 22.13 (incl. 22.5-22.12, which lack node:sqlite readOnly) with an actionable message', () => {
    for (const v of ['v22.4.0', 'v22.5.0', 'v22.12.0', 'v20.11.0']) {
      const r = evaluateNodeSupport(v);
      expect(r.ok, v).toBe(false);
    }
    expect(evaluateNodeSupport('v22.5.0').message).toMatch(/requires Node\.js >= 22\.13/);
  });
  it('rejects Node 25+ (not yet validated) with an actionable message', () => {
    const r = evaluateNodeSupport('v25.8.1');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/does not yet support Node\.js 25/);
    expect(r.message).toMatch(/Node 24|Node 22 LTS/);
    expect(evaluateNodeSupport('v26.0.0').ok).toBe(false);
  });
});

describe('assertSupportedNode', () => {
  it('returns without exiting on a supported version', () => {
    let exited = -1;
    const r = assertSupportedNode({ version: 'v24.0.0', exit: ((c: number) => { exited = c; return undefined as never; }), warn: () => {} });
    expect(r.ok).toBe(true);
    expect(exited).toBe(-1);
  });
  it('exits non-zero with the actionable message on an unsupported version', () => {
    // The global test setup sets XBUS_ALLOW_UNSUPPORTED_NODE=1 (the dev suite runs on
    // Node 25); clear it here so we exercise the real fail-closed exit path.
    const prev = process.env.XBUS_ALLOW_UNSUPPORTED_NODE;
    delete process.env.XBUS_ALLOW_UNSUPPORTED_NODE;
    try {
      let exited = -1; let warned = '';
      assertSupportedNode({ version: 'v25.8.1', exit: ((c: number) => { exited = c; return undefined as never; }), warn: (s) => { warned = s; } });
      expect(exited).toBe(1);
      expect(warned).toMatch(/does not yet support Node\.js 25/);
    } finally {
      if (prev === undefined) delete process.env.XBUS_ALLOW_UNSUPPORTED_NODE; else process.env.XBUS_ALLOW_UNSUPPORTED_NODE = prev;
    }
  });
  it('bypasses (with a visible warning) when XBUS_ALLOW_UNSUPPORTED_NODE=1', () => {
    const prev = process.env.XBUS_ALLOW_UNSUPPORTED_NODE;
    process.env.XBUS_ALLOW_UNSUPPORTED_NODE = '1';
    try {
      let exited = -1; let warned = '';
      const r = assertSupportedNode({ version: 'v25.8.1', exit: ((c: number) => { exited = c; return undefined as never; }), warn: (s) => { warned = s; } });
      expect(exited).toBe(-1);           // did NOT exit
      expect(r.ok).toBe(false);          // but did NOT lie about support
      expect(warned).toMatch(/WARNING.*unsupported Node bypassed/);
    } finally {
      if (prev === undefined) delete process.env.XBUS_ALLOW_UNSUPPORTED_NODE; else process.env.XBUS_ALLOW_UNSUPPORTED_NODE = prev;
    }
  });
});
