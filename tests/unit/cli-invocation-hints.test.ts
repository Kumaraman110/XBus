/**
 * Install is PATH-free: there is NO bare `xbus` / `xclaude` command on PATH. So no
 * user-facing "run this now" hint may instruct the reader to run a bare `xbus ...`
 * or `xclaude` command — it must show the real `node "<path>"` invocation, or
 * (for broker-side advice that has no CLI path in context) name the SUBCOMMAND
 * without the bare binary prefix.
 *
 * Regression: the install success message printed `Launch Claude with XBus:  xclaude`
 * and several error hints said `Run: xbus doctor` — none of which exist after a
 * PATH-free install, so a clean-profile user hit "command not recognized".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invocationHint, errorResult } from '../../src/cli/output.js';
import { XBusError, XBusErrorCode } from '../../src/protocol/errors.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('PATH-free invocation hints', () => {
  it('invocationHint renders a node "<path>" command, never a bare xbus', () => {
    const h = invocationHint('doctor');
    expect(h).toMatch(/^node /);
    expect(h).toContain('doctor');
    expect(h).not.toMatch(/(^|\s)xbus\s/);
  });

  it('errorResult next-actions use the node-path form, not bare xbus', () => {
    const known = errorResult(new XBusError(XBusErrorCode.BROKER_UNAVAILABLE, 'broker down'));
    expect(known.human).toMatch(/Run: node /);
    expect(known.human).not.toMatch(/Run: xbus /);
    const unknown = errorResult(new Error('boom'));
    expect(unknown.human).toMatch(/Run: node /);
    expect(unknown.human).not.toMatch(/Run: xbus /);
  });

  it('no shipped CLI/launcher source emits a bare-command "run-now" hint', () => {
    // Scan the user-facing source for "run/re-run/use/start with: <bare command>".
    // We flag a hint that tells the user to run `xbus ...` or `xclaude` directly.
    // "Usage:" grammar lines (which document subcommand SYNTAX, not a command to
    // run now) are intentionally allowed.
    const files = [
      'src/cli/main.ts',
      'src/cli/output.ts',
      'src/launcher/xclaude.ts',
      'src/broker/deadletter.ts',
      'src/broker/store.ts',
    ];
    const offenders: string[] = [];
    // Matches: (Run|Re-run|run|start with|with|Use|use)[ :] ... xbus <sub>  OR  ... xclaude
    const runNow = /\b(?:re-?run|run|start with|use)\b[^\n`'"]*?\b(xbus\s+\w|xclaude)\b/i;
    for (const rel of files) {
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
      text.split('\n').forEach((line, i) => {
        // Skip comments and Usage: grammar lines.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (/Usage:/.test(line)) return;
        if (runNow.test(line)) offenders.push(`${rel}:${i + 1}: ${trimmed}`);
      });
    }
    expect(offenders, `bare-command run-now hints found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
