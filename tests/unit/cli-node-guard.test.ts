/**
 * Beta.9 (ADR 0029): the entry-point Node-floor guard must be SKIPPED for the runtime-resolving
 * commands (verify / release-check / govern) so they are launchable under any Node (e.g. a global
 * Node 25 first on PATH), and must NOT be skipped for any other command. The tricky case is a flag
 * before the subcommand — `agentel --json verify` — since `run()` filters `--json` from anywhere.
 */
import { describe, it, expect } from 'vitest';
import { detectSubcommand, shouldSkipNodeGuard, RUNTIME_RESOLVING_COMMANDS } from '../../src/cli/main.js';

describe('CLI Node-floor guard exemption', () => {
  it('detectSubcommand finds the first non-flag token', () => {
    expect(detectSubcommand(['verify'])).toBe('verify');
    expect(detectSubcommand(['--json', 'verify'])).toBe('verify');
    expect(detectSubcommand(['verify', '--skip-acceptance'])).toBe('verify');
    expect(detectSubcommand(['--json', 'release-check', '--bundled-node', 'x'])).toBe('release-check');
    expect(detectSubcommand([])).toBeUndefined();
    expect(detectSubcommand(['--json'])).toBeUndefined();
  });

  it('skips the guard for every runtime-resolving command, in any flag position', () => {
    for (const cmd of RUNTIME_RESOLVING_COMMANDS) {
      expect(shouldSkipNodeGuard([cmd])).toBe(true);
      expect(shouldSkipNodeGuard(['--json', cmd])).toBe(true);          // the regression case
      expect(shouldSkipNodeGuard([cmd, '--json', '--foo'])).toBe(true);
    }
  });

  it('does NOT skip the guard for runtime commands (install/broker/etc.)', () => {
    for (const cmd of ['install', 'doctor', 'start', 'stop', 'send', 'dashboard', 'status', 'uninstall']) {
      expect(shouldSkipNodeGuard([cmd])).toBe(false);
      expect(shouldSkipNodeGuard(['--json', cmd])).toBe(false);
    }
  });

  it('does NOT skip the guard for an empty/flag-only invocation (falls through to help under a supported Node)', () => {
    expect(shouldSkipNodeGuard([])).toBe(false);
    expect(shouldSkipNodeGuard(['--json'])).toBe(false);
  });

  it('does not confuse a value that merely CONTAINS a command name', () => {
    // A recipient/text arg like "verify-something" is not the subcommand token here because it
    // still appears AFTER the real subcommand; but a bare non-flag first token IS the command.
    expect(detectSubcommand(['send', 'verify', 'hello'])).toBe('send');
    expect(shouldSkipNodeGuard(['send', 'verify', 'hello'])).toBe(false);
  });
});
