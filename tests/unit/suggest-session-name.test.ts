/**
 * Session-name SUGGESTION (beta.4, ADR 0012 Decision 3 "Automatic suggestion").
 *
 * When Claude starts, XBus derives a suggested name from, in precedence order:
 *   1. a saved workspace preference (workspace -> name memory)
 *   2. the Git repository name
 *   3. the current directory name
 *   4. agentType + project fallback
 * The suggestion is sanitized to the session-name grammar and only RETURNED as a
 * suggestion if it passes validation; otherwise null (caller must prompt). Pure —
 * the git/dir/saved inputs are passed in, nothing touches the filesystem here.
 */
import { describe, it, expect } from 'vitest';
import { suggestSessionName, sanitizeToSessionName } from '../../src/identity/session-name.js';
import { isValidSessionName } from '../../src/identity/session-name.js';

describe('sanitizeToSessionName', () => {
  it('lowercases, replaces runs of unsafe chars with a single dash, trims edges', () => {
    expect(sanitizeToSessionName('SeatMap API')).toBe('seatmap-api');
    expect(sanitizeToSessionName('My_Cool.Service')).toBe('my_cool.service'); // _ and . are legal
    expect(sanitizeToSessionName('  spaced  out  ')).toBe('spaced-out');
    expect(sanitizeToSessionName('weird@@@chars###here')).toBe('weird-chars-here');
    expect(sanitizeToSessionName('---leading-and-trailing---')).toBe('leading-and-trailing');
  });

  it('strips a leading non-alphanumeric so the result starts [a-z0-9]', () => {
    expect(sanitizeToSessionName('.config')).toBe('config');
    expect(sanitizeToSessionName('_private')).toBe('private');
  });

  it('truncates to the 48-char max', () => {
    const long = 'a'.repeat(80);
    expect(sanitizeToSessionName(long).length).toBeLessThanOrEqual(48);
  });

  it('returns null when nothing usable remains', () => {
    expect(sanitizeToSessionName('@@@')).toBeNull();
    expect(sanitizeToSessionName('')).toBeNull();
    expect(sanitizeToSessionName('   ')).toBeNull();
  });

  it('every non-null result is a VALID session name', () => {
    for (const raw of ['SeatMap API', 'My-Repo', 'a.b.c', 'Service 2024', 'CAPS', 'x']) {
      const s = sanitizeToSessionName(raw);
      if (s !== null) expect(isValidSessionName(s)).toBe(true);
    }
  });
});

describe('suggestSessionName precedence', () => {
  it('1. uses the saved workspace preference first (if valid)', () => {
    const s = suggestSessionName({ savedName: 'my-saved-name', gitRepo: 'repo-x', dirName: 'dir-y', agentType: 'claude', projectId: 'proj' });
    expect(s).toBe('my-saved-name');
  });

  it('2. falls to the git repo name when no saved pref', () => {
    const s = suggestSessionName({ gitRepo: 'SeatMap-API', dirName: 'dir-y', agentType: 'claude', projectId: 'proj' });
    expect(s).toBe('seatmap-api');
  });

  it('3. falls to the directory name when no git repo', () => {
    const s = suggestSessionName({ dirName: 'Payments Service', agentType: 'claude', projectId: 'proj' });
    expect(s).toBe('payments-service');
  });

  it('4. falls to agentType+project when nothing else is usable', () => {
    const s = suggestSessionName({ agentType: 'codex', projectId: 'abc123' });
    expect(s).toBe('codex-abc123');
  });

  it('skips a candidate that sanitizes to a RESERVED/GENERIC/invalid name and tries the next', () => {
    // git repo 'system' is reserved -> skip to dir name.
    const s = suggestSessionName({ gitRepo: 'system', dirName: 'real-dir', agentType: 'claude', projectId: 'p' });
    expect(s).toBe('real-dir');
  });

  it('skips a saved pref that is no longer valid', () => {
    const s = suggestSessionName({ savedName: 'admin', gitRepo: 'good-repo', agentType: 'claude', projectId: 'p' });
    expect(s).toBe('good-repo');
  });

  it('returns null when NOTHING yields a valid name (caller must prompt)', () => {
    const s = suggestSessionName({ gitRepo: '@@@', dirName: '###', agentType: '', projectId: '' });
    expect(s).toBeNull();
  });

  it('any non-null suggestion is a valid session name', () => {
    for (const inp of [
      { gitRepo: 'Some Repo' },
      { dirName: 'Another.Dir' },
      { agentType: 'hermes', projectId: 'xyz' },
      { savedName: 'kept-name' },
    ]) {
      const s = suggestSessionName(inp);
      if (s !== null) expect(isValidSessionName(s)).toBe(true);
    }
  });
});
