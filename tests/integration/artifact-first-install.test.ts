/**
 * ARTIFACT-FIRST install lifecycle. These tests build the packaged
 * artifact and exercise install / launch / hooks / MCP entirely FROM THE
 * ARTIFACT, never from the repo source. This closes an integration gap where
 * earlier installer tests installed from the repo (which has the
 * plugin metadata), so the artifact↔installer mismatch went unexercised.
 *
 * Containment proof: after packaging, the artifact is copied to a path WITH
 * SPACES, the install runs from there, and the installed plugin's metadata
 * references are validated to resolve inside the installed plugin (never the
 * repo). The installed MCP server + both hooks are executed from installed paths.
 *
 * Slow (real packaging + broker spawns); generous timeouts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildPackage } from '../../src/tools/package-win.js';
import { validateArtifact, validateChecksumCoverage, REQUIRED_FILES } from '../../src/shared/artifact-contract.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let base: string;        // temp root WITH A SPACE in the name (see §5.8)
let artifact: string;    // packaged artifact (copied under the spaces-path)
let installRoot: string;
let legacyDir: string;   // hermetic, empty legacy data root so install never depends on the real ~/.claude/xbus
let retainForDiagnosis = false; // §7: when an install gate fails, keep the temp tree for inspection

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { cwd: opts.cwd ?? REPO, env: { ...process.env, ...opts.env }, encoding: 'utf8', timeout: 120_000 });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/**
 * §6 — OBSERVABLE broker-readiness gate (replaces arbitrary sleeps). Polls
 * `xbus doctor --json` until the broker's `broker` check reports ok (its secure
 * named pipe is bound AND it completes a handshake), with bounded retries + a
 * short backoff. Throws an actionable error on timeout. Synchronous (uses the
 * blocking `Atomics.wait` sleep) so it composes with the test's execFileSync flow
 * without changing the test to async.
 */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}
function waitForBrokerReady(brokerCli: string, dataDir: string, timeoutMs: number): void {
  const deadlineMs = timeoutMs;
  const stepMs = 250;
  let waited = 0;
  let lastDetail = '(no doctor output)';
  while (waited <= deadlineMs) {
    const r = (() => {
      try { return { ok: true, out: execFileSync(process.execPath, [brokerCli, 'doctor', '--json'], { env: { ...process.env, XBUS_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10_000 }) }; }
      catch (e) { return { ok: false, out: ((e as { stdout?: string }).stdout ?? '') + ((e as { stderr?: string }).stderr ?? '') }; }
    })();
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{'))) as { checks?: Array<{ name: string; ok: boolean; detail: string }> };
      const brokerCheck = (j.checks ?? []).find((c) => c.name === 'broker');
      if (brokerCheck?.ok) return; // broker is reachable + handshakes — observably ready
      lastDetail = brokerCheck?.detail ?? lastDetail;
    } catch { /* doctor not parseable yet — broker still coming up */ }
    sleepSync(stepMs);
    waited += stepMs;
  }
  throw new Error(`broker did not become ready within ${timeoutMs}ms (last broker check: ${lastDetail}); data dir ${dataDir}`);
}

beforeAll(() => {
  if (!fs.existsSync(path.join(REPO, 'dist', 'tools', 'package-win.js'))) throw new Error('dist/ missing — run `npm run build`');
  // A base dir WITH A SPACE, to prove space-containing paths work end to end.
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus rc3 ')); // note the spaces
  const staging = path.join(base, 'staged artifact');         // spaces here too
  buildPackage(staging);
  artifact = staging;
  installRoot = path.join(base, 'install root');              // spaces here too
  // Hermetic legacy data root: an isolated, empty dir so the install's migration
  // decision is always `no_migration` and never depends on the real ~/.claude/xbus
  // on the test machine (which would otherwise turn these clean installs into a
  // migration and leave no plugin dir).
  legacyDir = path.join(base, 'isolated legacy root');
}, 180_000);

afterAll(() => {
  if (retainForDiagnosis) { process.stderr.write(`[artifact-first] retaining temp tree for diagnosis: ${base}\n`); return; }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('artifact-first — contract + composition (tests 1-4)', () => {
  it('1-3: artifact contains plugin metadata (.claude-plugin/plugin.json, .mcp.json, hooks/hooks.json)', () => {
    expect(fs.existsSync(path.join(artifact, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifact, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifact, 'hooks', 'hooks.json'))).toBe(true);
    // and every other required file
    for (const f of REQUIRED_FILES) expect(fs.existsSync(path.join(artifact, f)), `required ${f}`).toBe(true);
  });

  it('4: every plugin metadata reference resolves INSIDE the artifact (contract VALID)', () => {
    const r = validateArtifact(artifact);
    if (!r.ok) throw new Error('artifact contract violations: ' + JSON.stringify(r.violations));
    expect(r.ok).toBe(true);
    expect(r.checkedReferences).toBeGreaterThan(0);
    // checksum coverage too
    const cc = validateChecksumCoverage(artifact);
    expect(cc.missingEntries).toHaveLength(0);
    expect(cc.extraEntries).toHaveLength(0);
    expect(cc.normalizedCollisions).toHaveLength(0);
  });
});

describe('artifact-first — install lifecycle (tests 5-11)', () => {
  // §7 FAIL-FAST GATE: do the real install ONCE up front and assert the installed
  // plugin is complete. If install fails or rolls back, this throws with the full
  // diagnostics (installer/health/contract/rollback) AND retains the install dir —
  // and because it runs before the MCP/hook/launcher tests below, those never run
  // against a missing plugin (the "artifact-first tests execute missing installed
  // files" failure class).
  let installGateError: string | null = null;
  beforeAll(() => {
    const r = run(process.execPath, [path.join(artifact, 'dist', 'cli', 'main.js'), 'install', '--json'],
      { cwd: artifact, env: { XBUS_INSTALL_ROOT: installRoot, HOME: path.join(base, 'home'), XBUS_LEGACY_DATA_DIR: legacyDir } });
    let j: { ok?: boolean; error?: string; health?: { ok?: boolean; detail?: string }; rolledBack?: boolean } = {};
    try { j = JSON.parse(r.out); } catch { /* leave j empty; r.out captured below */ }
    if (r.code !== 0 || !j.ok) {
      installGateError = `INSTALL FAILED — aborting artifact-first lifecycle.\n`
        + `  exit=${r.code} ok=${j.ok} rolledBack=${j.rolledBack}\n`
        + `  error=${j.error ?? '(none)'}\n`
        + `  health=${JSON.stringify(j.health ?? null)}\n`
        + `  install dir RETAINED for diagnosis: ${installRoot}\n`
        + `  raw: ${r.out.slice(0, 600)}`;
      retainForDiagnosis = true;
      return; // do not throw here; the it() below reports it as a clean failure
    }
    // Assert every required installed file exists + the contract is valid.
    const pluginDir = path.join(installRoot, 'plugin');
    const required = [
      path.join('dist', 'channel', 'server.js'),
      path.join('dist', 'channel', 'hook-entry.js'),
      path.join('dist', 'cli', 'main.js'),
      path.join('dist', 'launcher', 'xclaude.js'),
      path.join('.claude-plugin', 'plugin.json'),
    ];
    const missing = required.filter((f) => !fs.existsSync(path.join(pluginDir, f)));
    const manifestOk = fs.existsSync(path.join(installRoot, 'install-manifest.json'));
    const contract = validateArtifact(pluginDir, { scope: 'plugin' });
    if (missing.length || !manifestOk || !contract.ok) {
      installGateError = `INSTALLED PLUGIN INCOMPLETE — aborting artifact-first lifecycle.\n`
        + `  missing files: ${missing.join(', ') || '(none)'}\n`
        + `  install-manifest present: ${manifestOk}\n`
        + `  contract valid: ${contract.ok} violations=${JSON.stringify(contract.violations ?? [])}\n`
        + `  install dir RETAINED for diagnosis: ${installRoot}`;
      retainForDiagnosis = true;
    }
  }, 120_000);

  it('FAIL-FAST: install succeeded and the installed plugin has all required files (gates the rest)', () => {
    if (installGateError) throw new Error(installGateError);
    // explicit positive assertions (also documents the §7 required set)
    const pluginDir = path.join(installRoot, 'plugin');
    for (const f of ['dist/channel/server.js', 'dist/channel/hook-entry.js', 'dist/cli/main.js', 'dist/launcher/xclaude.js', '.claude-plugin/plugin.json']) {
      expect(fs.existsSync(path.join(pluginDir, ...f.split('/'))), `installed ${f}`).toBe(true);
    }
    expect(fs.existsSync(path.join(installRoot, 'install-manifest.json'))).toBe(true);
    expect(validateArtifact(pluginDir, { scope: 'plugin' }).ok).toBe(true);
  });

  it('5: xbus install --dry-run accepts a freshly built artifact (a previously failing case)', () => {
    const r = run(process.execPath, [path.join(artifact, 'dist', 'cli', 'main.js'), 'install', '--dry-run', '--json'],
      { cwd: artifact, env: { XBUS_INSTALL_ROOT: installRoot, XBUS_LEGACY_DATA_DIR: legacyDir } });
    expect(r.code, r.out).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(true);
    expect(j.dryRun).toBe(true);
    expect(j.plan.filesToWrite).toBeGreaterThan(0);
  });

  it('6+8: real isolated install FROM the artifact at a SPACES path succeeds + passes health', () => {
    const r = run(process.execPath, [path.join(artifact, 'dist', 'cli', 'main.js'), 'install', '--json'],
      { cwd: artifact, env: { XBUS_INSTALL_ROOT: installRoot, HOME: path.join(base, 'home'), XBUS_LEGACY_DATA_DIR: legacyDir } });
    expect(r.code, r.out).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.ok, j.error).toBe(true);
    expect(j.health.ok).toBe(true);
    expect(fs.existsSync(path.join(installRoot, 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('4(installed): the INSTALLED plugin satisfies the plugin-scope contract (refs resolve inside it)', () => {
    const r = validateArtifact(path.join(installRoot, 'plugin'), { scope: 'plugin' });
    if (!r.ok) throw new Error('installed plugin violations: ' + JSON.stringify(r.violations));
    expect(r.ok).toBe(true);
    expect(r.checkedReferences).toBeGreaterThan(0);
  });

  it('7+9: source checkout is NOT referenced — installed plugin metadata points only inside the plugin', () => {
    // Read the installed metadata and assert no reference mentions the repo path
    // or a src/ path. (Strong form of "source removed after packaging still works".)
    const mcp = fs.readFileSync(path.join(installRoot, 'plugin', '.mcp.json'), 'utf8');
    const hooks = fs.readFileSync(path.join(installRoot, 'plugin', 'hooks', 'hooks.json'), 'utf8');
    for (const text of [mcp, hooks]) {
      expect(text).not.toContain(REPO);
      expect(text.replace(/\\/g, '/')).not.toMatch(/\/src\//);
      expect(text).toContain('${CLAUDE_PLUGIN_ROOT}'); // artifact-relative only
    }
  });

  it('11: the installed MCP server initializes from the INSTALLED path (no repo access)', () => {
    const server = path.join(installRoot, 'plugin', 'dist', 'channel', 'server.js');
    let out = '';
    try {
      out = execFileSync(process.execPath, [server], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\n',
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'aaaa1111-0000-4000-8000-0000000000a1', XBUS_DATA_DIR: path.join(installRoot, 'data') },
        encoding: 'utf8', timeout: 10_000,
      });
    } catch (e) { out = (e as { stdout?: string }).stdout ?? ''; }
    expect(out).toContain('"name":"xbus"');
    expect(out).toContain('"version":"0.1.0-beta.4.1"');
  });

  it('12+13: installed UserPromptSubmit and Stop hooks execute from the INSTALLED path', () => {
    const hookEntry = path.join(installRoot, 'plugin', 'dist', 'channel', 'hook-entry.js');
    for (const event of ['UserPromptSubmit', 'Stop']) {
      const r = (() => {
        try {
          execFileSync(process.execPath, [hookEntry], {
            input: JSON.stringify({ session_id: 'test', hook_event_name: event }) + '\n',
            env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(installRoot, 'plugin'), XBUS_DATA_DIR: path.join(installRoot, 'data') },
            encoding: 'utf8', timeout: 10_000,
          });
          return 0;
        } catch (e) { return (e as { status?: number }).status ?? 1; }
      })();
      expect(r, `hook ${event} exit`).toBe(0);
    }
  });
});

describe('artifact-first — installed launcher + secure exchange (tests 10, 14)', () => {
  it('10: the installed xclaude launches from a NON-project dir using only installed files', () => {
    // Re-install (the uninstall test runs in a later describe; ensure plugin present).
    if (!fs.existsSync(path.join(installRoot, 'plugin', '.claude-plugin', 'plugin.json'))) {
      run(process.execPath, [path.join(artifact, 'dist', 'cli', 'main.js'), 'install'],
        { cwd: artifact, env: { XBUS_INSTALL_ROOT: installRoot, HOME: path.join(base, 'home'), XBUS_LEGACY_DATA_DIR: legacyDir } });
    }
    const launcher = path.join(installRoot, 'plugin', 'dist', 'launcher', 'xclaude.js');
    // Fake claude that echoes argv; non-project cwd = a fresh temp dir.
    const fake = path.join(base, 'fakeclaude.cmd');
    if (process.platform === 'win32') fs.writeFileSync(fake, '@echo off\r\necho FAKECLAUDE: %*\r\n');
    else { fs.writeFileSync(fake, '#!/bin/sh\necho "FAKECLAUDE: $@"\n', { mode: 0o755 }); }
    const nonProject = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-nonproj-'));
    const before = fs.readdirSync(nonProject).join(',');
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const res = spawnSync(process.execPath, [launcher, '--model', 'sonnet', 'a b'], {
      cwd: nonProject, env: { ...process.env, XBUS_INSTALL_ROOT: installRoot, CLAUDE_CODE_EXECPATH: fake }, encoding: 'utf8', timeout: 15_000,
    });
    const out = (res.stdout ?? '') + (res.stderr ?? ''); // banner on stderr, fake echo on stdout
    expect(out).toContain('--plugin-dir');
    expect(out).toContain(path.join(installRoot, 'plugin')); // installed plugin, not repo
    expect(out).toContain('a b'); // spaces preserved
    expect(fs.readdirSync(nonProject).join(',')).toBe(before); // no project-local files
    fs.rmSync(nonProject, { recursive: true, force: true });
  });

  it('14: a secure checkpoint request/ack/reply completes using ONLY installed files', () => {
    // Drive two MCP-style clients against a broker started from the INSTALLED CLI,
    // importing only installed dist modules (never the repo).
    const idist = path.join(installRoot, 'plugin', 'dist');
    const dataDir = path.join(installRoot, 'data');
    const driver = path.join(base, 'exchange.cjs');
    fs.writeFileSync(driver, `
const { IpcClient } = require(${JSON.stringify(path.join(idist, 'ipc', 'client.js'))});
const { doHello } = require(${JSON.stringify(path.join(idist, 'ipc', 'hello.js'))});
const { ComponentRole } = require(${JSON.stringify(path.join(idist, 'identity', 'components.js'))});
const { loadOrCreateRootSecret } = require(${JSON.stringify(path.join(idist, 'ipc', 'root-secret.js'))});
const { defaultEndpoint } = require(${JSON.stringify(path.join(idist, 'ipc', 'transport.js'))});
const dir = process.env.XBUS_DATA_DIR, secret = loadOrCreateRootSecret(dir), ep = defaultEndpoint(dir);
async function sess(id, alias){ const c=new IpcClient(ep,{rootSecret:secret,helloIdentity:{claimedRole:'mcp',claimedSessionId:id}}); await c.connect(); await doHello(c,ComponentRole.MCP); await c.request('register_session',{sessionId:id,instanceId:'i-'+alias,processId:process.pid,projectId:'rc3',cwd:process.cwd(),receiveMode:'hook_checkpoint',capabilities:['ack','reply'],role:ComponentRole.MCP}); await c.request('signal_readiness',{ackAvailable:true,versionOk:true}); await c.request('register_alias',{alias}); return c; }
(async()=>{ const a=await sess('aaaa3333-0000-4000-8000-0000000000a3','rc3A'); const b=await sess('bbbb3333-0000-4000-8000-0000000000b3','rc3B');
  const snd=await a.request('send_message',{to:'rc3B',text:'installed-only exchange',requiresAck:true,requiresReply:true}); const sp=snd.payload;
  const inb=(await b.request('inbox',{limit:5})).payload; const inj=inb.messages[0].injectionId;
  await b.request('ack_message',{messageId:sp.messageId,status:'accepted',injectionId:inj});
  await b.request('reply_message',{messageId:sp.messageId,text:'done',outcome:'completed',injectionId:inj});
  const ainb=(await a.request('inbox',{limit:5})).payload;
  console.log('RESULT '+sp.state+' '+inb.messages[0].bodyIncluded+' '+ainb.messages[0].kind+' '+(ainb.messages[0].correlationId===sp.correlationId));
  a.close(); b.close(); process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
`);
    // start broker from installed CLI
    const brokerCli = path.join(installRoot, 'plugin', 'dist', 'cli', 'main.js');
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const broker = spawn(process.execPath, [brokerCli, 'start'], { env: { ...process.env, XBUS_DATA_DIR: dataDir }, stdio: 'ignore', detached: false });
    try {
      // §6 (de-flake): replace the arbitrary 3.5s sleep with an OBSERVABLE
      // readiness gate — poll `xbus doctor --json` until the broker actually answers
      // (its secure pipe is bound + handshakes), bounded to ~20s with actionable
      // diagnostics on timeout. This removes the `connect ENOENT` race where the
      // driver connected before the named pipe existed.
      waitForBrokerReady(brokerCli, dataDir, 20_000);
      const out = (() => { try { return execFileSync(process.execPath, [driver], { env: { ...process.env, XBUS_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 20_000 }); } catch (e) { return ((e as { stdout?: string }).stdout ?? '') + ((e as { stderr?: string }).stderr ?? ''); } })();
      expect(out, `exchange driver output:\n${out}`).toContain('RESULT');
      const line = out.split('\n').find((l) => l.startsWith('RESULT')) ?? '';
      const [, state, bodyOnce, kind, corr] = line.split(' ');
      expect(state).toBe('queued_until_checkpoint');
      expect(bodyOnce).toBe('true');
      expect(kind).toBe('reply');
      expect(corr).toBe('true');
    } finally {
      try { run(process.execPath, [brokerCli, 'stop'], { env: { XBUS_DATA_DIR: dataDir } }); } catch { /* ignore */ }
      try { broker.kill(); } catch { /* ignore */ }
    }
  }, 60_000);
});

describe('artifact-first — uninstall + fail-closed (tests 15-16)', () => {
  it('15: uninstall removes only manifest-owned files; unrelated install-root files survive', () => {
    const unrelated = path.join(installRoot, 'unrelated.txt');
    fs.writeFileSync(unrelated, 'keep me');
    const r = run(process.execPath, [path.join(installRoot, 'plugin', 'dist', 'cli', 'main.js'), 'uninstall', '--json'],
      { env: { XBUS_INSTALL_ROOT: installRoot } });
    // (run from the installed CLI; data retained by default)
    expect(r.code, r.out).toBe(0);
    expect(fs.existsSync(path.join(installRoot, 'plugin'))).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true); // unrelated file preserved
    expect(fs.existsSync(path.join(installRoot, 'data', 'auth', 'root.secret'))).toBe(true); // data retained
  });

  it('16: a failed artifact validation changes nothing — installing an INVALID artifact is refused before any write', () => {
    // Make an artifact missing .mcp.json (invalid), install from it → must refuse,
    // create no plugin dir, no manifest.
    const broken = path.join(base, 'broken artifact');
    fs.rmSync(broken, { recursive: true, force: true });
    fs.cpSync(artifact, broken, { recursive: true });
    fs.rmSync(path.join(broken, '.mcp.json'));
    const brokenRoot = path.join(base, 'broken install');
    const r = run(process.execPath, [path.join(broken, 'dist', 'cli', 'main.js'), 'install', '--json'],
      { cwd: broken, env: { XBUS_INSTALL_ROOT: brokenRoot } });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not a valid XBus plugin payload|\.mcp\.json/);
    expect(fs.existsSync(path.join(brokenRoot, 'plugin'))).toBe(false);
    expect(fs.existsSync(path.join(brokenRoot, 'install-manifest.json'))).toBe(false);
  });
});
