/**
 * The NORMATIVE installable-artifact contract.
 *
 * Root cause it addresses: the artifact-to-installer contract was never tested
 * end to end. Packaging, the installer, `doctor`, and `verify:release` each kept
 * their own ad-hoc file lists, and they disagreed (the package shipped runtime
 * but not the plugin metadata the installer required). This module is the SINGLE
 * source of truth: one machine-readable contract, one fail-closed validator, used
 * by all of them.
 *
 * A valid Windows artifact (a `--plugin-dir` target) MUST contain the files in
 * REQUIRED_FILES, and every reference inside the plugin metadata MUST resolve to a
 * file that exists INSIDE the artifact root — never the source repo, never an
 * absolute path, never escaping the root, never needing a dev toolchain.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readProvenance } from './build-identity.js';

/**
 * The PLUGIN PAYLOAD — files present both in the artifact AND in an installed
 * `--plugin-dir`. This is what makes the directory a usable Claude plugin.
 */
export const PLUGIN_PAYLOAD_FILES = [
  '.claude-plugin/plugin.json',   // plugin manifest (the --plugin-dir entry)
  '.mcp.json',                    // MCP server registration
  'hooks/hooks.json',             // SessionStart + UserPromptSubmit + Stop hooks
  'dist/cli/main.js',             // xbus CLI entry
  'dist/launcher/xclaude.js',     // xclaude launcher entry
  'dist/channel/server.js',       // MCP server (spawned by .mcp.json)
  'dist/channel/hook-entry.js',   // checkpoint hook entry (UserPromptSubmit + Stop)
  'dist/channel/session-start-hook.js', // beta.5 SessionStart lifecycle hook (visibility)
  'package.json',                 // runtime manifest (bin + deps + engines)
  'provenance.json',              // exact build identity, read at runtime (see ADR 0011)
] as const;

/**
 * Artifact-only metadata (present in the packaged artifact, NOT copied into an
 * installed plugin dir — they describe the artifact, not the runtime plugin).
 */
export const ARTIFACT_ONLY_FILES = [
  'runtime.json',                 // pinned runtime descriptor
  'build-manifest.json',          // provenance (version/commit/buildId)
  'sbom.json',                    // CycloneDX SBOM
  'SHA256SUMS',                   // per-file checksums
  'INSTALL.txt',                  // self-contained release-asset install guide (no source checkout needed)
  'install.ps1',                  // PATH-free release-asset installer
] as const;

/** Files a complete installable ARTIFACT must contain. */
export const REQUIRED_FILES = [...PLUGIN_PAYLOAD_FILES, ...ARTIFACT_ONLY_FILES] as const;

/** Required production dependency dirs under node_modules/. */
export const REQUIRED_DEP_DIRS = ['node_modules/uuid', 'node_modules/zod'] as const;

/** License notices that should accompany a public artifact (warn, not fail, in
 *  preview: deps carry their own license fields in the SBOM). */
export const EXPECTED_LICENSE_FILES = ['node_modules/uuid/LICENSE.md', 'node_modules/zod/LICENSE'] as const;

/** Dev-only tokens that must NOT appear in any packaged command/runtime ref. */
const FORBIDDEN_COMMAND_TOKENS = ['npx', 'tsx', 'ts-node', 'npm install', 'npm ci', 'vite-node', 'node-gyp', 'tsc'];

export interface ContractViolation {
  rule: string;
  detail: string;
}

export interface ContractResult {
  ok: boolean;
  violations: ContractViolation[];
  checkedReferences: number;
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve a `${CLAUDE_PLUGIN_ROOT}/...`-style reference to an artifact path. */
function resolvePluginRef(root: string, ref: string): { resolved: string; rule?: string; detail?: string } | null {
  // Strip surrounding quotes a hook command may carry.
  const r = ref.trim().replace(/^["']|["']$/g, '');
  // Reject absolute paths and repo references outright.
  if (/^[A-Za-z]:[\\/]/.test(r) || r.startsWith('/')) return { resolved: r, rule: 'absolute-path', detail: ref };
  if (/(^|[\\/])src[\\/]/.test(r) || r.includes('\\Users\\') || r.includes('/Users/')) return { resolved: r, rule: 'repo-or-source-ref', detail: ref };
  const m = r.match(/\$\{CLAUDE_PLUGIN_ROOT\}[\\/](.+)$/);
  if (m) {
    const inner = m[1]!.replace(/\\/g, '/');
    if (inner.includes('..')) return { resolved: inner, rule: 'path-escapes-root', detail: ref };
    return { resolved: path.join(root, inner) };
  }
  // A plain relative ref (e.g. "./.mcp.json").
  if (r.startsWith('./') || r.startsWith('.\\') || !path.isAbsolute(r)) {
    const resolved = path.resolve(root, r);
    if (!isInsideRoot(root, resolved)) return { resolved, rule: 'path-escapes-root', detail: ref };
    return { resolved };
  }
  return null;
}

/**
 * Validate an artifact directory against the contract. Fail-closed: any missing
 * file, unresolved reference, escaping/absolute/repo path, dev-dependency command,
 * malformed metadata, metadata-version disagreement, or reparse point is a
 * violation.
 */
export function validateArtifact(root: string, opts: { expectedVersion?: string; expectedBuildId?: string; expectedCommit?: string; scope?: 'artifact' | 'plugin' } = {}): ContractResult {
  const v: ContractViolation[] = [];
  let checkedReferences = 0;
  const add = (rule: string, detail: string): void => { v.push({ rule, detail }); };
  const scope = opts.scope ?? 'artifact';

  if (!fs.existsSync(root)) { return { ok: false, violations: [{ rule: 'artifact-missing', detail: root }], checkedReferences: 0 }; }

  // 1) Required files present. The 'plugin' scope validates an INSTALLED
  //    --plugin-dir (payload only); 'artifact' adds the artifact-only metadata.
  const required = scope === 'plugin' ? PLUGIN_PAYLOAD_FILES : REQUIRED_FILES;
  for (const f of required) {
    if (!fs.existsSync(path.join(root, f))) add('required-file-missing', f);
  }
  for (const d of REQUIRED_DEP_DIRS) {
    if (!fs.existsSync(path.join(root, d))) add('required-dep-missing', d);
  }

  // 2) No reparse points anywhere in the artifact (symlink/junction).
  try {
    for (const file of walk(root)) {
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) add('reparse-point', path.relative(root, file));
    }
  } catch (e) { add('walk-failed', (e as Error).message); }

  // 3) plugin.json — valid JSON, required fields, version match, refs resolve.
  const pluginPath = path.join(root, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(pluginPath)) {
    let plugin: Record<string, unknown> | null = null;
    try { plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8')) as Record<string, unknown>; } catch (e) { add('malformed-metadata', `.claude-plugin/plugin.json: ${(e as Error).message}`); }
    if (plugin) {
      for (const field of ['name', 'version']) if (!plugin[field]) add('plugin-field-missing', field);
      if (opts.expectedVersion && plugin.version !== opts.expectedVersion) add('metadata-version-disagree', `plugin.json version ${String(plugin.version)} != ${opts.expectedVersion}`);
      // mcpServers + hooks references must resolve inside the artifact.
      for (const key of ['mcpServers', 'hooks'] as const) {
        const ref = plugin[key];
        if (typeof ref === 'string') {
          checkedReferences++;
          const res = resolvePluginRef(root, ref);
          if (res?.rule) add(res.rule, `plugin.json ${key} -> ${res.detail}`);
          else if (res && !fs.existsSync(res.resolved)) add('reference-unresolved', `plugin.json ${key} -> ${ref}`);
        }
      }
    }
  }

  // 4) .mcp.json — command resolves to the runtime; script in artifact; no dev tool.
  const mcpPath = path.join(root, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    type McpJson = { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };
    let mcp: McpJson | null = null;
    try { mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as McpJson; } catch (e) { add('malformed-metadata', `.mcp.json: ${(e as Error).message}`); }
    for (const [name, srv] of Object.entries(mcp?.mcpServers ?? {})) {
      const cmd = srv.command ?? '';
      if (FORBIDDEN_COMMAND_TOKENS.some((t) => cmd.includes(t))) add('dev-dependency-command', `.mcp.json ${name} command "${cmd}"`);
      // No root secret in args/env.
      const argStr = (srv.args ?? []).join(' ') + ' ' + Object.values(srv.env ?? {}).join(' ');
      if (/root\.secret|XBUS_ROOT_SECRET|[0-9a-f]{64}/.test(argStr)) add('secret-in-launch', `.mcp.json ${name}`);
      for (const a of srv.args ?? []) {
        if (FORBIDDEN_COMMAND_TOKENS.some((t) => a.includes(t))) add('dev-dependency-command', `.mcp.json ${name} arg "${a}"`);
        if (a.includes('${CLAUDE_PLUGIN_ROOT}') || a.includes('dist/')) {
          checkedReferences++;
          const res = resolvePluginRef(root, a);
          if (res?.rule) add(res.rule, `.mcp.json ${name} arg -> ${res.detail}`);
          else if (res && !fs.existsSync(res.resolved)) add('reference-unresolved', `.mcp.json ${name} arg -> ${a}`);
        }
      }
    }
  }

  // 5) hooks.json — every hook command resolves to a packaged file; SessionStart (beta.5
  //    visibility) + UserPromptSubmit + Stop (checkpoint delivery) present.
  const hooksPath = path.join(root, 'hooks', 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    type HooksJson = { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    let hooks: HooksJson | null = null;
    try { hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as HooksJson; } catch (e) { add('malformed-metadata', `hooks.json: ${(e as Error).message}`); }
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      if (!hooks?.hooks?.[event]) add('hook-event-missing', event);
    }
    for (const [event, groups] of Object.entries(hooks?.hooks ?? {})) {
      for (const g of groups) for (const h of g.hooks ?? []) {
        const cmd = h.command ?? '';
        if (FORBIDDEN_COMMAND_TOKENS.some((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(cmd))) add('dev-dependency-command', `hooks.json ${event} "${cmd}"`);
        const refs = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}[^"']+/g) ?? [];
        for (const ref of refs) {
          checkedReferences++;
          const res = resolvePluginRef(root, ref);
          if (res?.rule) add(res.rule, `hooks.json ${event} -> ${res.detail}`);
          else if (res && !fs.existsSync(res.resolved)) add('reference-unresolved', `hooks.json ${event} -> ${ref}`);
        }
      }
    }
  }

  // 6) runtime.json / build-manifest provenance agreement (artifact scope only —
  //    the installed plugin dir intentionally doesn't carry these).
  const rt = scope === 'artifact' ? readJson(path.join(root, 'runtime.json')) : null;
  const bm = scope === 'artifact' ? readJson(path.join(root, 'build-manifest.json')) : null;
  if (rt && bm) {
    if (rt.version !== bm.version) add('metadata-version-disagree', `runtime ${String(rt.version)} != build-manifest ${String(bm.version)}`);
    if (rt.buildId !== bm.buildId) add('metadata-version-disagree', `runtime buildId ${String(rt.buildId)} != build-manifest ${String(bm.buildId)}`);
    if (opts.expectedCommit && rt.commit !== opts.expectedCommit) add('metadata-version-disagree', `runtime commit ${String(rt.commit)} != ${opts.expectedCommit}`);
    if (opts.expectedBuildId && rt.buildId !== opts.expectedBuildId) add('metadata-version-disagree', `runtime buildId ${String(rt.buildId)} != ${opts.expectedBuildId}`);
    if (rt.buildToolchainRequiredAtRuntime !== false) add('toolchain-required', 'runtime.json buildToolchainRequiredAtRuntime != false');
  }

  // 7) provenance.json is REQUIRED (in PLUGIN_PAYLOAD_FILES, so
  //    checked for both scopes) and must be a well-formed, internally-consistent
  //    exact-identity manifest. A present-but-malformed/contradictory provenance
  //    is a fail-closed violation (readProvenance throws); a missing one is already
  //    caught by the required-file check above.
  const provPath = path.join(root, 'provenance.json');
  if (fs.existsSync(provPath)) {
    try {
      const prov = readProvenance(provPath);
      if (prov) {
        if (opts.expectedVersion && prov.productVersion !== opts.expectedVersion) add('metadata-version-disagree', `provenance productVersion ${prov.productVersion} != ${opts.expectedVersion}`);
        if (opts.expectedCommit && prov.sourceCommit !== opts.expectedCommit) add('metadata-version-disagree', `provenance sourceCommit ${prov.sourceCommit} != ${opts.expectedCommit}`);
        // exact buildId must NOT be the bare compatibility tuple (an earlier-build bug)
        if (prov.buildId === prov.compatibilityId) add('identity-conflated', `provenance buildId equals compatibilityId (${prov.buildId}) — exact id must embed the commit`);
      }
    } catch (e) { add('malformed-metadata', `provenance.json: ${(e as Error).message}`); }
  }

  return { ok: v.length === 0, violations: v, checkedReferences };
}

function readJson(p: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function* walk(dir: string): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(full); else yield full;
  }
}

/**
 * Checksum-coverage validation (§7): every payload file must be in
 * SHA256SUMS; only SHA256SUMS itself + documented detached metadata are excluded.
 */
export const CHECKSUM_EXCLUSIONS = ['SHA256SUMS', '.xbus-staging'] as const;

export interface ChecksumCoverage {
  ok: boolean;
  totalRegularFiles: number;
  checksummedPayloadFiles: number;
  explicitExclusions: string[];
  missingEntries: string[]; // payload files lacking a checksum
  extraEntries: string[];   // checksum entries pointing at a missing file
  normalizedCollisions: string[];
}

export function validateChecksumCoverage(root: string): ChecksumCoverage {
  const sumsPath = path.join(root, 'SHA256SUMS');
  const listed = new Map<string, string>(); // rel -> hash
  const normalized = new Map<string, string[]>(); // lower(rel) -> [rel,...]
  if (fs.existsSync(sumsPath)) {
    for (const line of fs.readFileSync(sumsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const hash = line.slice(0, 64);
      const rel = line.slice(66).trim().replace(/\\/g, '/');
      listed.set(rel, hash);
      const key = rel.toLowerCase();
      normalized.set(key, [...(normalized.get(key) ?? []), rel]);
    }
  }
  const payload: string[] = [];
  for (const f of walk(root)) payload.push(path.relative(root, f).replace(/\\/g, '/'));
  const excluded = [...CHECKSUM_EXCLUSIONS];
  const payloadToCheck = payload.filter((p) => !excluded.includes(p as typeof CHECKSUM_EXCLUSIONS[number]));
  const missingEntries = payloadToCheck.filter((p) => !listed.has(p));
  const extraEntries = [...listed.keys()].filter((rel) => !fs.existsSync(path.join(root, rel)));
  const normalizedCollisions = [...normalized.entries()].filter(([, arr]) => arr.length > 1).map(([k]) => k);
  return {
    ok: missingEntries.length === 0 && extraEntries.length === 0 && normalizedCollisions.length === 0,
    totalRegularFiles: payload.length,
    checksummedPayloadFiles: payloadToCheck.filter((p) => listed.has(p)).length,
    explicitExclusions: excluded.filter((e) => payload.includes(e)),
    missingEntries, extraEntries, normalizedCollisions,
  };
}
