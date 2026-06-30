/**
 * Session-name validation + normalization (beta.4, ADR 0012 Decision 3).
 *
 * A session name is the human-readable, case-insensitively-unique routing handle.
 * It is STRICTER than an alias (aliases.ts: ^[A-Za-z0-9_-]{1,128}$): a session name
 * is ^[a-z0-9][a-z0-9._-]{1,47}$ after NFC, must start alphanumeric, and is rejected
 * if it is reserved (xbus/broker/admin/system), generic (session/agent/claude/...),
 * UUID-like, all-numeric, or path-like. ASCII is enforced BEFORE casefolding so a
 * Unicode homoglyph can never normalize INTO a valid name (homoglyph defense).
 *
 * These tests are pure (no DB) — uniqueness against other ACTIVE sessions is a
 * broker/DB concern (ux_session_name_active), tested at the store layer.
 */
import { describe, it, expect } from 'vitest';
import {
  validateSessionName,
  normalizeSessionName,
  isValidSessionName,
  RESERVED_SESSION_NAMES,
  SESSION_NAME_MAX,
} from '../../src/identity/session-name.js';
import { XBusError, XBusErrorCode } from '../../src/protocol/errors.js';

function rejects(raw: string): XBusError {
  try {
    validateSessionName(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(XBusError);
    expect((e as XBusError).code).toBe(XBusErrorCode.INVALID_SESSION_NAME);
    return e as XBusError;
  }
  throw new Error(`expected "${raw}" to be rejected, but it was accepted`);
}

describe('validateSessionName — accepts good names', () => {
  it('accepts canonical kebab/dotted/underscored names', () => {
    for (const ok of ['seatmap-api', 'netomi-flow', 'payments-service', 'release-reviewer', 'codex-security-review', 'hermes-adversarial-test', 'a1', 'x.y.z', 'a_b-c.d', 'svc2024']) {
      const r = validateSessionName(ok);
      expect(r.display).toBe(ok);
      expect(r.normalized).toBe(ok.normalize('NFC').toLowerCase());
      expect(isValidSessionName(ok)).toBe(true);
    }
  });

  it('preserves display case but normalizes case-insensitively', () => {
    const r = validateSessionName('SeatMap-API');
    expect(r.display).toBe('SeatMap-API'); // display preserved
    expect(r.normalized).toBe('seatmap-api'); // ci form
  });

  it('two names differing only in case normalize to the SAME key (collision basis)', () => {
    expect(normalizeSessionName('My-Session-One')).toBe(normalizeSessionName('my-session-one'));
  });

  it('accepts a name at the max length boundary and rejects one over it', () => {
    const atMax = 'a' + 'b'.repeat(SESSION_NAME_MAX - 1); // length === SESSION_NAME_MAX
    expect(atMax.length).toBe(SESSION_NAME_MAX);
    expect(isValidSessionName(atMax)).toBe(true);
    const overMax = 'a' + 'b'.repeat(SESSION_NAME_MAX); // length === MAX+1
    rejects(overMax);
  });
});

describe('validateSessionName — charset + shape rules', () => {
  it('rejects empty / non-string', () => {
    rejects('');
    for (const bad of [undefined, null, 42, {}, []] as unknown[]) {
      expect(() => validateSessionName(bad as string)).toThrow(XBusError);
    }
  });

  it('rejects a single character (min length 2)', () => {
    rejects('a');
  });

  it('rejects a leading non-alphanumeric (must start [a-z0-9])', () => {
    rejects('-abc');
    rejects('.abc');
    rejects('_abc');
  });

  it('rejects uppercase-only-difference that contains illegal chars', () => {
    rejects('Has Space');
    rejects('tab\tname');
    rejects('emoji😀name');
    rejects('a/b');
    rejects('a\\b');
    rejects('a:b');
  });

  it('rejects Unicode homoglyphs BEFORE casefold (no homoglyph slips into a valid name)', () => {
    // Cyrillic 'а' (U+0430) looks like ASCII 'a' but must be rejected by the ASCII gate.
    rejects('seatmаp-api');
    // Fullwidth digits / zero-width / bidi.
    rejects('ｓｅｓｓｉｏｎ');
    rejects('seat​map');
    rejects('seat‮map');
  });
});

describe('validateSessionName — reserved / generic / id-like rejection', () => {
  it('rejects reserved administrative names (case-insensitive)', () => {
    for (const n of [...RESERVED_SESSION_NAMES]) {
      rejects(n);
      rejects(n.toUpperCase());
    }
    // The spec's named reserved identities are present.
    for (const n of ['xbus', 'broker', 'admin', 'system']) {
      expect(RESERVED_SESSION_NAMES.has(n)).toBe(true);
      rejects(n);
    }
  });

  it('rejects generic names', () => {
    for (const n of ['session', 'claude', 'agent', 'test', 'default', 'new-session']) {
      rejects(n);
    }
  });

  it('rejects all-numeric names (process-id-like)', () => {
    rejects('12345');
    rejects('00');
  });

  it('rejects UUID-like names', () => {
    rejects('8f19a2cd-98d1-4f3a-9c2b-1a2b3c4d5e6f');
    // also the lowercased hex-with-dashes general shape
    rejects('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('rejects filesystem-path-like names', () => {
    rejects('C:\\Projects\\App');
    rejects('/usr/local/bin');
    rejects('./relative');
  });
});

describe('isValidSessionName — boolean mirror of validateSessionName', () => {
  it('returns false where validate throws and true where it passes', () => {
    expect(isValidSessionName('seatmap-api')).toBe(true);
    expect(isValidSessionName('xbus')).toBe(false);
    expect(isValidSessionName('Has Space')).toBe(false);
    expect(isValidSessionName('')).toBe(false);
  });
});
