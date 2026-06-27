import { describe, it, expect } from 'vitest';
import {
  validateSendInput,
  isReservedMetadataKey,
  byteLen,
  LIMITS,
} from '../../src/protocol/schemas.js';
import { XBusErrorCode, isXBusError } from '../../src/protocol/errors.js';

function expectReject(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error('expected rejection but none thrown');
  } catch (e) {
    expect(isXBusError(e)).toBe(true);
    if (isXBusError(e)) expect(e.code).toBe(code);
  }
}

describe('validateSendInput', () => {
  it('accepts a minimal valid send', () => {
    const r = validateSendInput({ to: 'backend', text: 'hello' });
    expect(r.to).toBe('backend');
    expect(r.kind).toBe('request');
    expect(r.requiresAck).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expectReject(() => validateSendInput({ to: 'x', text: 'y', senderSessionId: 'spoof' }), XBusErrorCode.PROTOCOL_VIOLATION);
  });

  it('rejects oversized text (byte-accurate)', () => {
    const big = 'a'.repeat(LIMITS.TEXT_BYTES + 1);
    expectReject(() => validateSendInput({ to: 'x', text: big }), XBusErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('counts UTF-8 bytes, not chars, for limits', () => {
    // '€' is 3 bytes in UTF-8; a string of N euros has 3N bytes.
    const euros = '€'.repeat(Math.floor(LIMITS.TEXT_BYTES / 3) + 1);
    expect(byteLen(euros)).toBeGreaterThan(LIMITS.TEXT_BYTES);
    expectReject(() => validateSendInput({ to: 'x', text: euros }), XBusErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('rejects reserved metadata keys (F16)', () => {
    for (const key of ['permission', 'approve', 'mode', 'policy', 'authority']) {
      expectReject(
        () => validateSendInput({ to: 'x', text: 'y', metadata: { [key]: 'v' } }),
        XBusErrorCode.RESERVED_METADATA_KEY,
      );
    }
  });

  it('rejects __proto__ delivered the way an attacker would (JSON own-key)', () => {
    // A wire payload with a literal __proto__ OWN property (JSON.parse creates it
    // as own, unlike an object literal which invokes the prototype setter).
    const payload = JSON.parse('{"to":"x","text":"y","metadata":{"__proto__":"polluted"}}');
    expectReject(() => validateSendInput(payload), XBusErrorCode.RESERVED_METADATA_KEY);
  });

  it('rejects claude/* and xbus/* namespaced + slash-containing metadata keys', () => {
    for (const key of ['claude_internal', 'xbus_route', 'a/b']) {
      expectReject(
        () => validateSendInput({ to: 'x', text: 'y', metadata: { [key]: 'v' } }),
        XBusErrorCode.RESERVED_METADATA_KEY,
      );
    }
  });

  it('rejects too many metadata entries', () => {
    const md: Record<string, string> = {};
    for (let i = 0; i < LIMITS.METADATA_ENTRIES + 1; i++) md[`k${i}`] = 'v';
    expectReject(() => validateSendInput({ to: 'x', text: 'y', metadata: md }), XBusErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('does not allow kind=system or other control kinds via send', () => {
    // schema enum only permits request|event; anything else is a protocol violation
    expectReject(() => validateSendInput({ to: 'x', text: 'y', kind: 'system' }), XBusErrorCode.PROTOCOL_VIOLATION);
    expectReject(() => validateSendInput({ to: 'x', text: 'y', kind: 'reply' }), XBusErrorCode.PROTOCOL_VIOLATION);
  });
});

describe('isReservedMetadataKey', () => {
  it('is case-insensitive and trims', () => {
    expect(isReservedMetadataKey('  Permission ')).toBe(true);
    expect(isReservedMetadataKey('APPROVE')).toBe(true);
  });
  it('allows ordinary keys', () => {
    expect(isReservedMetadataKey('priority')).toBe(false);
    expect(isReservedMetadataKey('topic')).toBe(false);
  });
});
