/**
 * Beta.9 (ADR 0029): unit tests for the approved-runtime resolver — the pure decision function
 * behind `agentel verify`. Driven entirely by injected probes (no real fs / no spawning), so it
 * exhaustively exercises the precedence order + fail-closed remediation.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveApprovedRuntime, findNpmCli, isRuntimeComplete, VENDORED_RUNTIME_DIR_REL, type ResolverProbes } from '../../src/tools/runtime-resolver.js';

const REPO = process.platform === 'win32' ? 'C:\\repo' : '/repo';

/** Build probes with an explicit set of "existing files", version map, and env. */
function probes(over: Partial<ResolverProbes> & { files?: string[]; versions?: Record<string, string> }): ResolverProbes {
  const files = new Set((over.files ?? []).map((f) => path.normalize(f)));
  const versions = over.versions ?? {};
  return {
    isFile: (p) => files.has(path.normalize(p)),
    nodeVersion: (b) => versions[path.normalize(b)] ?? null,
    execPath: over.execPath ?? path.join('/usr', 'bin', 'node'),
    currentVersion: over.currentVersion ?? 'v22.23.1',
    env: over.env ?? {},
    platform: over.platform ?? process.platform,
  };
}

/** The npm-cli path a windows dist would expose next to a node binary. */
function winNpm(nodeBin: string): string {
  return path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}
/** The Windows CLI shims a COMPLETE dist ships next to node.exe. */
function winShims(nodeBin: string): string[] {
  const d = path.dirname(nodeBin);
  return [path.join(d, 'npm.cmd'), path.join(d, 'npx.cmd')];
}

describe('findNpmCli', () => {
  it('finds npm next to a windows-layout node.exe', () => {
    const node = 'C:\\node22\\node.exe';
    const npm = winNpm(node);
    expect(findNpmCli(node, (p) => path.normalize(p) === path.normalize(npm))).toBe(path.normalize(npm));
  });
  it('returns null for an interpreter-only runtime (no npm sibling)', () => {
    expect(findNpmCli('C:\\plugin\\runtime\\node.exe', () => false)).toBeNull();
  });
});

describe('isRuntimeComplete', () => {
  it('true when npm.cmd + npx.cmd shims sit next to node.exe (Windows)', () => {
    const node = 'C:\\node22\\node.exe';
    const present = new Set(winShims(node).map(path.normalize));
    expect(isRuntimeComplete(node, 'win32', (p) => present.has(path.normalize(p)))).toBe(true);
  });
  it('false when only node.exe is present (partial vendored dist — the real failure mode)', () => {
    const node = 'C:\\vend\\node.exe';
    // node.exe + node_modules present, but NO npm.cmd/npx.cmd shims
    expect(isRuntimeComplete(node, 'win32', (p) => path.normalize(p) === path.normalize(node))).toBe(false);
  });
  it('POSIX: true when bin/npm + bin/npx are present next to bin/node', () => {
    const node = '/opt/node/bin/node';
    const shims = new Set(['/opt/node/bin/npm', '/opt/node/bin/npx'].map(path.normalize));
    expect(isRuntimeComplete(node, 'linux', (p) => shims.has(path.normalize(p)))).toBe(true);
  });
});

describe('resolveApprovedRuntime precedence', () => {
  it('1) explicit AGENTEL_VERIFY_NODE wins when in-floor + has npm', () => {
    const envNode = 'C:\\pin\\node.exe';
    const r = resolveApprovedRuntime(REPO, probes({
      env: { AGENTEL_VERIFY_NODE: envNode },
      files: [envNode, winNpm(envNode)],
      versions: { [path.normalize(envNode)]: 'v22.23.1' },
      platform: 'win32',
    }));
    expect(r.ok).toBe(true);
    expect(r.source).toBe('env');
    expect(r.nodePath).toBe(envNode);
    expect(r.version).toBe('v22.23.1');
  });

  it('legacy XBUS_VERIFY_NODE is honored as a fallback env key', () => {
    const envNode = 'C:\\pin\\node.exe';
    const r = resolveApprovedRuntime(REPO, probes({
      env: { XBUS_VERIFY_NODE: envNode },
      files: [envNode, winNpm(envNode)],
      versions: { [path.normalize(envNode)]: 'v24.4.0' },
      platform: 'win32',
    }));
    expect(r.ok).toBe(true);
    expect(r.source).toBe('env');
  });

  it('an out-of-floor explicit node is rejected and falls through', () => {
    const envNode = 'C:\\old\\node.exe';
    const vendored = path.join(REPO, VENDORED_RUNTIME_DIR_REL, 'node.exe');
    const r = resolveApprovedRuntime(REPO, probes({
      env: { AGENTEL_VERIFY_NODE: envNode },
      files: [envNode, winNpm(envNode), vendored, winNpm(vendored)],
      versions: { [path.normalize(envNode)]: 'v25.8.1', [path.normalize(vendored)]: 'v22.23.1' },
      platform: 'win32',
    }));
    // env is out of floor (25) → rejected; vendored (22.23.1) wins.
    expect(r.ok).toBe(true);
    expect(r.source).toBe('vendored');
  });

  it('2) repo-vendored dist is used when no env override', () => {
    const vendored = path.join(REPO, VENDORED_RUNTIME_DIR_REL, 'node.exe');
    const r = resolveApprovedRuntime(REPO, probes({
      files: [vendored, winNpm(vendored)],
      versions: { [path.normalize(vendored)]: 'v22.13.0' },
      platform: 'win32',
      currentVersion: 'v25.8.1', // current is out of floor, so vendored must win
      execPath: 'C:\\sys\\node.exe',
    }));
    expect(r.ok).toBe(true);
    expect(r.source).toBe('vendored');
  });

  it('3) falls back to the current process runtime when in-floor + npm present', () => {
    const exec = 'C:\\current\\node.exe';
    const r = resolveApprovedRuntime(REPO, probes({
      files: [exec, winNpm(exec)],
      versions: { [path.normalize(exec)]: 'v22.23.1' },
      execPath: exec,
      currentVersion: 'v22.23.1',
      platform: 'win32',
    }));
    expect(r.ok).toBe(true);
    expect(r.source).toBe('current');
    expect(r.nodePath).toBe(exec);
  });

  it('4) fails closed with actionable remediation naming every avenue', () => {
    const exec = 'C:\\current\\node.exe';
    const r = resolveApprovedRuntime(REPO, probes({
      // current is in-floor but has NO npm (interpreter-only), nothing else provided
      files: [exec],
      versions: { [path.normalize(exec)]: 'v22.23.1' },
      execPath: exec,
      currentVersion: 'v22.23.1',
      platform: 'win32',
    }));
    expect(r.ok).toBe(false);
    expect(r.nodePath).toBeUndefined();
    expect(r.error).toContain('AGENTEL_VERIFY_NODE');
    expect(r.error).toContain(VENDORED_RUNTIME_DIR_REL);
    expect(r.error).toContain('No PATH edit or NVM install is required');
  });

  it('does NOT clutter remediation with a vendored rejection when nothing is vendored', () => {
    const exec = 'C:\\current\\node.exe';
    const r = resolveApprovedRuntime(REPO, probes({
      files: [exec], // no npm, no vendored file at all
      versions: { [path.normalize(exec)]: 'v25.0.0' }, // out of floor too
      execPath: exec,
      currentVersion: 'v25.0.0',
      platform: 'win32',
    }));
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('vendored: no node binary');
  });

  it('a current runtime out of floor is reported as such', () => {
    const r = resolveApprovedRuntime(REPO, probes({
      files: [],
      execPath: 'C:\\sys\\node.exe',
      currentVersion: 'v25.8.1',
      platform: 'win32',
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('out of the supported floor');
  });
});
