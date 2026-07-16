/**
 * Beta.9 (ADR 0029): unit tests for the opt-in governance module. Uses a real temp dir for the
 * fs-effecting functions (config read, reviewer install, evidence emission) and asserts the
 * critical invariants: INERT without opt-in, never fabricates evidence for a failing verify,
 * idempotent reviewer install, and gate-evidence format matches the consuming pre-push-gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isGovernanceEnabled, readGovernanceConfig, discoverReviewerAgent, installReviewerAgent,
  emitPreflightEvidence, GOVERNANCE_CONFIG_REL,
} from '../../src/tools/governance.js';

let repo: string;
beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentel-gov-')); });
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* */ } });

function writeConfig(obj: unknown): void {
  fs.mkdirSync(path.join(repo, '.agentel'), { recursive: true });
  fs.writeFileSync(path.join(repo, GOVERNANCE_CONFIG_REL), JSON.stringify(obj));
}

describe('governance opt-in', () => {
  it('is INERT (disabled) for a repo with no config file', () => {
    expect(isGovernanceEnabled(repo)).toBe(false);
    expect(readGovernanceConfig(repo)).toBeNull();
  });

  it('is enabled for a minimal {} config (opt-in = file present in THIS repo)', () => {
    writeConfig({});
    expect(isGovernanceEnabled(repo)).toBe(true);
  });

  it('with an explicit repos list, matches by basename, absolute path, and "*"', () => {
    writeConfig({ repos: [path.basename(repo)] });
    expect(isGovernanceEnabled(repo)).toBe(true);
    writeConfig({ repos: [repo] });
    expect(isGovernanceEnabled(repo)).toBe(true);
    writeConfig({ repos: ['*'] });
    expect(isGovernanceEnabled(repo)).toBe(true);
  });

  it('does NOT govern a repo not in its explicit repos list', () => {
    writeConfig({ repos: ['some-other-repo'] });
    expect(isGovernanceEnabled(repo)).toBe(false);
  });
});

describe('reviewer discovery + install', () => {
  it('discovers a repo-vendored agents/code-reviewer.md', () => {
    fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'agents', 'code-reviewer.md'), '# reviewer');
    const d = discoverReviewerAgent(repo, {}, (p) => fs.existsSync(p));
    expect(d.found).toBe(true);
    expect(d.origin).toBe('repo agents/');
  });

  it('honors AGENTEL_REVIEWER_AGENT override first', () => {
    const custom = path.join(repo, 'custom-reviewer.md');
    fs.writeFileSync(custom, '# custom');
    const d = discoverReviewerAgent(repo, { AGENTEL_REVIEWER_AGENT: custom }, (p) => fs.existsSync(p));
    expect(d.found).toBe(true);
    expect(d.sourcePath).toBe(custom);
    expect(d.origin).toBe('AGENTEL_REVIEWER_AGENT');
  });

  it('installs into .claude/agents and is idempotent on a byte-identical rerun', () => {
    fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
    const body = '# Stage 1 Rubric Reviewer\ncontent';
    fs.writeFileSync(path.join(repo, 'agents', 'code-reviewer.md'), body);
    const disc = discoverReviewerAgent(repo, {}, (p) => fs.existsSync(p));
    const r1 = installReviewerAgent(repo, disc);
    expect(r1.ok).toBe(true);
    expect(r1.alreadyPresent).toBeFalsy();
    expect(fs.readFileSync(path.join(repo, '.claude', 'agents', 'code-reviewer.md'), 'utf8')).toBe(body);
    const r2 = installReviewerAgent(repo, disc);
    expect(r2.ok).toBe(true);
    expect(r2.alreadyPresent).toBe(true); // idempotent — no rewrite
  });

  it('reports a clean failure when no reviewer is found', () => {
    const disc = discoverReviewerAgent(repo, {}, () => false);
    const r = installReviewerAgent(repo, disc);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('no code-reviewer.md');
  });
});

describe('preflight evidence emission', () => {
  it('is skipped (no fabrication) when governance is off', () => {
    const r = emitPreflightEvidence(repo, { verifyPassed: true, headSha: 'abc', nowIso: '2026-07-15T00:00:00Z' });
    expect(r.ok).toBe(false);
    expect(r.written).toHaveLength(0);
    expect(r.skippedReason).toContain('governance not enabled');
  });

  it('REFUSES to write evidence for a FAILING verify, even when governed', () => {
    writeConfig({});
    const r = emitPreflightEvidence(repo, { verifyPassed: false, headSha: 'abc', nowIso: '2026-07-15T00:00:00Z' });
    expect(r.ok).toBe(false);
    expect(r.written).toHaveLength(0);
    expect(r.skippedReason).toContain('did not pass');
  });

  it('writes gate files in the exact pre-push-gate format on a passing governed verify', () => {
    writeConfig({});
    const r = emitPreflightEvidence(repo, { verifyPassed: true, headSha: 'deadbeef', nowIso: '2026-07-15T12:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.written.length).toBe(2); // tests-pass + stage1-clean by default
    const tp = fs.readFileSync(path.join(repo, '.preflight', 'gate', 'tests-pass'), 'utf8');
    expect(tp).toContain('GATE=tests-pass');
    expect(tp).toContain('HEAD=deadbeef');
    expect(tp).toContain('TIMESTAMP=2026-07-15T12:00:00Z');
    expect(tp).toContain('SOURCE=agentel-verify');
  });

  it('honors a custom gateNames list from config', () => {
    writeConfig({ gateNames: ['tests-pass'] });
    const r = emitPreflightEvidence(repo, { verifyPassed: true, headSha: 'x', nowIso: 'now' });
    expect(r.written.length).toBe(1);
    expect(fs.existsSync(path.join(repo, '.preflight', 'gate', 'stage1-clean'))).toBe(false);
  });

  it('can be disabled via emitPreflightEvidence:false even when governed', () => {
    writeConfig({ emitPreflightEvidence: false });
    const r = emitPreflightEvidence(repo, { verifyPassed: true, headSha: 'x', nowIso: 'now' });
    expect(r.ok).toBe(false);
    expect(r.skippedReason).toContain('disabled');
  });
});
