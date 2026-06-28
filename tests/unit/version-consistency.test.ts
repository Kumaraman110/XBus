/**
 * Guard against the beta.3 release-blocker: the product version is duplicated across
 * package.json, src/protocol/version.ts (XBUS_VERSION), and .claude-plugin/plugin.json.
 * If they DISAGREE, a clean `xbus install` fails contract validation
 * (metadata-version-disagree) and rolls back — exactly the first-run failure beta.3
 * fixes. This test makes any future divergence a CI failure, not a release surprise.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XBUS_VERSION } from '../../src/protocol/version.js';
import { assertVersionConsistency } from '../../src/tools/write-provenance.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8')) as Record<string, unknown>;

describe('version consistency (prevents the beta.3 install-rollback class)', () => {
  it('package.json, XBUS_VERSION, and .claude-plugin/plugin.json all agree', () => {
    const pkg = readJson('package.json').version;
    const plugin = readJson('.claude-plugin/plugin.json').version;
    expect(pkg, 'package.json vs XBUS_VERSION').toBe(XBUS_VERSION);
    expect(plugin, 'plugin.json vs XBUS_VERSION').toBe(XBUS_VERSION);
  });

  it('the build-time gate passes on the real (consistent) tree', () => {
    expect(() => assertVersionConsistency(REPO)).not.toThrow();
  });

  it('the build-time gate FAILS (would fail the build) on a forced mismatch', () => {
    // Build an isolated copy with a tampered plugin.json version; the gate must throw.
    const os = require('node:os') as typeof import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-vc-'));
    fs.mkdirSync(path.join(tmp, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: XBUS_VERSION }));
    fs.writeFileSync(path.join(tmp, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.0.0-bad' }));
    try {
      expect(() => assertVersionConsistency(tmp)).toThrow(/version disagreement|disagree/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the engines range excludes the not-yet-validated Node 25+', () => {
    const engines = (readJson('package.json').engines as { node?: string } | undefined)?.node ?? '';
    expect(engines).toMatch(/<\s*25/); // upper bound below 25
    expect(engines).toMatch(/>=\s*22/); // lower bound at 22
  });
});
