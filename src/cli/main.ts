/**
 * xbus CLI: install, uninstall, repair, doctor, status, sessions, send, start, stop,
 * pause/resume/dnd, block/unblock, inbox, version. install/uninstall are
 * user-scope + reversible (src/cli/install.ts); update/rollback and PATH /
 * shell-profile integration remain separate, explicitly-requested steps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { IpcClient } from '../ipc/client.js';
import { defaultEndpoint } from '../ipc/transport.js';
import { startBrokerHost } from '../broker/host.js';
import { XBUS_VERSION, PROTOCOL_VERSION } from '../protocol/version.js';
import { SCHEMA_VERSION, BUILD_ID } from '../protocol/handshake.js';
import { doHello, clientHello } from '../ipc/hello.js';
import { ComponentRole } from '../identity/components.js';
import { classifyShutdown, readStateFile, stateFilePath, pidIsAlive } from '../broker/state-file.js';
import { loadOrCreateRootSecret } from '../ipc/root-secret.js';
import { errorResult, emit, formatSessions, formatSendResult, formatMetrics, invocationHint, type CliResult } from './output.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import { install, uninstall } from './install.js';
import { resolveDataDir, defaultInstallRoot, readInstallManifest } from '../launcher/install-paths.js';
import { repairUserScope, defaultClaudeConfigPath, defaultClaudeSettingsPath, inspectUserScopeHooks } from './user-scope-config.js';
import { readProvenance, resolveIdentity, provenancePathFromDist, classifyMixedBuild, type Provenance } from '../shared/build-identity.js';
import { assertSupportedNode } from '../shared/node-support.js';
import { readConfigEnv } from '../shared/env-config.js';
import { bundledNodePath, hasBundledRuntime, BUNDLED_NODE_VERSION } from '../shared/bundled-runtime.js';
import { dashboardAlive } from '../broker/dashboard/browser.js';
// NOTE: verify / release-check / govern are DEVELOPMENT + RELEASE commands. Their
// implementations live under `dist/tools/`, which package-win intentionally STRIPS from the
// shipped end-user artifact (packaging/bench/verify tooling is not shipped). So they are loaded
// via DYNAMIC import inside their handlers — the installed CLI (which never runs them) never
// needs `dist/tools/` present, and importing them statically here would break `agentel <anything>`
// on an installed artifact with ERR_MODULE_NOT_FOUND. Run these from a source checkout only.
type GovernanceModule = typeof import('../tools/governance.js');

/** This process's exact identity: prefer the packaged provenance.json next to the
 *  installed binaries (works with no git/source), else a labelled source identity.
 *  A present-but-malformed provenance throws (fail-closed) — surfaced by callers. */
function thisIdentity(): Provenance {
  const prov = readProvenance(provenancePathFromDist(import.meta.url));
  return resolveIdentity(SCHEMA_VERSION, prov);
}

async function cmdInstall(dryRun: boolean): Promise<CliResult> {
  const r = await install({ dryRun });
  if (dryRun) {
    const lines = [
      `agentel install (dry-run) — no changes made.`,
      `  source:      ${r.plan.source}`,
      `  install root:${r.plan.installRoot}`,
      `  plugin dir:  ${r.plan.pluginDir}`,
      `  data dir:    ${r.plan.dataDir}`,
      `  files:       ${r.plan.filesToWrite} to write`,
      `  backups:     ${r.plan.willBackup.length} existing file(s) would be backed up`,
      `  already installed: ${r.plan.alreadyInstalled}`,
    ];
    return { human: lines.join('\n'), json: { ...r }, exitCode: 0 };
  }
  if (!r.ok) {
    return { human: `agentel install FAILED: ${r.error ?? 'unknown'}${r.rolledBack ? ' (rolled back)' : ''}\nRun: ${invocationHint('doctor')}`, json: { ...r }, exitCode: 1 };
  }
  // Beta.4 (ADR 0012 D8): with user-scope registration, plain `claude` from any
  // directory loads XBus + auto-starts the broker + auto-registers a named session.
  // No --plugin-dir, no xclaude. The CLI itself is still PATH-free (node <path>).
  const cliJs = path.join(r.plan.pluginDir, 'dist', 'cli', 'main.js');
  const launcherJs = path.join(r.plan.pluginDir, 'dist', 'launcher', 'xclaude.js');
  // Did this install register user-scope config? Read it back from the manifest.
  const wired = !!readInstallManifest(r.plan.installRoot)?.userScope;
  const lines = [
    `XBus installed.`,
    `  plugin dir: ${r.plan.pluginDir}`,
    `  data dir:   ${r.plan.dataDir}`,
    `  health:     ${r.health?.detail}`,
    `  manifest:   ${r.manifestPath}`,
    ``,
  ];
  if (wired) {
    lines.push(
      `XBus is registered at user scope — just run plain 'claude' from any directory.`,
      `The broker auto-starts and your session auto-registers with a unique name.`,
      `Verify:  node "${cliJs}" doctor`,
      `Repair (e.g. after node moves):  node "${cliJs}" repair`,
    );
  } else {
    lines.push(
      `Verify:  node "${cliJs}" doctor`,
      `Launch Claude with XBus:  node "${launcherJs}"`,
      `(Plugin-only install: user-scope registration was skipped. PATH / shell-profile`,
      ` integration was NOT changed — request it separately if wanted.)`,
      `See INSTALL.txt in the release asset for verify, launch, and uninstall steps.`,
    );
  }
  return { human: lines.join('\n'), json: { ...r }, exitCode: 0 };
}

function cmdRepair(): CliResult {
  // Re-apply the user-scope Claude config registration for the current install
  // (fixes drift, e.g. the node executable moved). Reads the install manifest for
  // the owning installId so it re-takes ONLY this install's entry.
  const installRoot = defaultInstallRoot();
  const manifest = readInstallManifest(installRoot);
  if (!manifest) {
    return { human: `XBus is not installed (nothing to repair). Run: node "<pluginDir>/dist/cli/main.js" install`, json: { ok: false, notInstalled: true }, exitCode: 1 };
  }
  const configPath = manifest.userScope?.configPath ?? defaultClaudeConfigPath();
  const settingsPath = manifest.userScope?.settingsPath ?? defaultClaudeSettingsPath();
  // Beta.7 (ADR 0022): re-point config at the XBus-OWNED bundled runtime when the installed
  // plugin dir ships one (so repair keeps ignoring system Node), else the running node (dev).
  const repairRuntime = bundledNodePath(manifest.pluginDir);
  const r = repairUserScope({
    configPath,
    settingsPath,
    nodePath: fs.existsSync(repairRuntime) ? repairRuntime : process.execPath,
    serverEntry: path.join(manifest.pluginDir, 'dist', 'channel', 'server.js'),
    hookEntry: path.join(manifest.pluginDir, 'dist', 'channel', 'hook-entry.js'),
    // Beta.5: repair re-applies the SessionStart handler too (fixes a drifted/missing one).
    sessionStartHookEntry: path.join(manifest.pluginDir, 'dist', 'channel', 'session-start-hook.js'),
    dataDir: manifest.dataDir,
    installId: manifest.installId ?? `xbus-repair-${process.pid}`,
  });
  if (!r.ok) return { human: `xbus repair FAILED: ${r.error ?? 'unknown'}`, json: { ...r }, exitCode: 1 };
  return { human: `XBus user-scope config ${r.repaired ? 'repaired' : 'already current'} (${configPath}).`, json: { ...r }, exitCode: 0 };
}

function cmdUninstall(dryRun: boolean, removeData: boolean): CliResult {
  const r = uninstall({ dryRun, removeData });
  if (r.notInstalled) return { human: 'XBus is not installed (nothing to do).', json: { ...r }, exitCode: 0 };
  if (dryRun) {
    return { human: `xbus uninstall (dry-run) — would remove:\n  ${r.removed.join('\n  ')}\n  data ${removeData ? 'REMOVED' : 'RETAINED'}`, json: { ...r }, exitCode: 0 };
  }
  const warn = r.couldNotRemove.length ? `\n  could NOT remove:\n  ${r.couldNotRemove.join('\n  ')}` : '';
  return {
    human: `XBus uninstalled (data ${r.retainedData ? 'retained' : 'removed'}).\n  removed:\n  ${r.removed.join('\n  ')}${warn}`,
    json: { ...r }, exitCode: r.ok ? 0 : 1,
  };
}

function dataDir(): string {
  // One canonical data root (env → installed manifest dataDir → default),
  // so `xbus start/doctor/status/stop` operate on the SAME root the installer
  // provisioned and the MCP server + hooks use.
  return resolveDataDir();
}

async function connectAsAdmin(): Promise<IpcClient> {
  const client = new IpcClient(defaultEndpoint(dataDir()), { requestTimeoutMs: 4000, rootSecret: loadOrCreateRootSecret(dataDir()), helloIdentity: { claimedRole: 'admin' } });
  await client.connect();
  await doHello(client, ComponentRole.ADMIN);
  // The CLI registers a short-lived admin session so it can query/send.
  await client.request('register_session', {
    sessionId: `cli-${process.pid}-${Date.now()}`,
    instanceId: `cli-inst-${process.pid}`,
    processId: process.pid,
    projectId: 'proj-cli',
    cwd: process.cwd(),
    receiveMode: 'poll_only',
    capabilities: ['cli'],
    role: ComponentRole.ADMIN,
  });
  return client;
}

interface ExactBuild { productVersion?: string; buildId?: string; sourceCommit?: string; compatibilityId?: string }
interface BrokerHandshake { compatibility?: string; detail?: string; broker?: { xbusVersion: string; protocolVersion: number; schemaVersion: number; buildId: string; brokerInstanceId: string; exactBuild?: ExactBuild }; code?: string; message?: string }

async function cmdDoctor(): Promise<CliResult> {
  const dir = dataDir();
  const ep = defaultEndpoint(dir);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  checks.push({ name: 'data_dir', ok: fs.existsSync(dir), detail: dir });
  const state = readStateFile(dir);
  // Show the EXACT build id (+ start time) so a stale broker is
  // distinguishable from a newer one — the compatibility `buildId` is identical across the line.
  const brokerPid = state ? `${state.pid} (instance ${state.brokerInstanceId}, build ${state.exactBuildId ?? state.buildId}, started ${state.processStartedAt}, alive=${pidIsAlive(state.pid)})` : '(no state file)';

  let brokerOk: boolean;
  let brokerInfo: string;
  let compatibility = 'unknown';
  // The broker's EXACT build identity (from its registration provenance,
  // reported in the hello ack broker block) + the installed-artifact manifest sha.
  let brokerExactBuild: { productVersion?: string; buildId?: string; sourceCommit?: string; compatibilityId?: string } | null = null;
  let installedManifestSha256: string | null = null;
  try {
    // Secure transport: doctor establishes the encrypted channel first (proves the
    // root secret works), then sends the app-level version hello.
    const c = new IpcClient(ep, { requestTimeoutMs: 2000, rootSecret: loadOrCreateRootSecret(dir), helloIdentity: { claimedRole: 'admin' } });
    await c.connect();
    // Send THIS build's full hello so a version/schema mismatch is reported.
    const h = await c.request('hello', clientHello(ComponentRole.ADMIN));
    const p = h.payload as BrokerHandshake;
    if (h.frameType === 'error') {
      // F-doctor: render the verdict STRING (p.detail.result), never the object.
      const detailObj = (p as { detail?: { result?: string } }).detail;
      compatibility = detailObj?.result ?? p.code ?? 'incompatible';
      brokerOk = false;
      brokerInfo = `INCOMPATIBLE: ${p.message ?? 'version/schema mismatch'}`;
    } else {
      brokerOk = true;
      compatibility = p.compatibility ?? 'compatible';
      const b = p.broker;
      brokerInfo = b ? `v${b.xbusVersion} proto${b.protocolVersion} schema${b.schemaVersion} build=${b.buildId} instance=${b.brokerInstanceId}` : 'connected';
      // Capture the broker's EXACT build identity if it reported one.
      if (b?.exactBuild) brokerExactBuild = b.exactBuild;
    }
    c.close();
  } catch {
    brokerOk = false;
    brokerInfo = `not reachable (start with: ${invocationHint('start')})`;
  }
  checks.push({ name: 'broker', ok: brokerOk, detail: `${brokerInfo}` });
  checks.push({ name: 'broker_pid', ok: true, detail: brokerPid });
  // broker_endpoint just reports the computed path; the load-bearing reachability
  // is the 'broker' check above. Mark ok iff the broker answered (F-doctor).
  checks.push({ name: 'broker_endpoint', ok: brokerOk, detail: ep });
  // Report THIS process's EXACT identity (from provenance.json
  // when installed) — not just the compatibility tuple (see ADR 0011).
  let id: Provenance; let idError: string | null = null;
  try { id = thisIdentity(); }
  catch (e) { idError = (e as Error).message; id = resolveIdentity(SCHEMA_VERSION, null); }
  checks.push({ name: 'this_build', ok: idError === null, detail: idError ? `provenance error: ${idError}` : `${id.buildId} (product ${id.productVersion}, commit ${id.sourceCommit.slice(0, 12)}, compat ${id.compatibilityId})` });
  checks.push({ name: 'compatibility', ok: brokerOk, detail: compatibility });
  // F-doctor: actually PROBE node:sqlite rather than hard-coding ok.
  let sqliteOk = false; let sqliteDetail: string;
  try { const { DatabaseSync } = await import('node:sqlite'); sqliteOk = typeof DatabaseSync === 'function'; sqliteDetail = sqliteOk ? 'node:sqlite available' : 'node:sqlite export missing'; }
  catch (e) { sqliteDetail = `node:sqlite import failed: ${(e as Error).message}`; }
  checks.push({ name: 'node_sqlite', ok: sqliteOk, detail: sqliteDetail });

  // Beta.7 (ADR 0022): the XBus-OWNED bundled Node runtime. Reports whether the installed
  // plugin dir ships runtime/node.exe and whether the user-scope MCP/hook `command` points at
  // it (so installed XBus ignores system Node). Uninstalled / dev-source (no bundled runtime)
  // is INFORMATIONAL — the running Node is then the accepted floor-checked one; a REAL install
  // that ships a runtime but whose config points elsewhere is a fail (the guarantee leaked).
  {
    const manifest = readInstallManifest(defaultInstallRoot());
    const pluginDir = typeof manifest?.pluginDir === 'string' ? manifest.pluginDir : null;
    if (pluginDir && hasBundledRuntime(pluginDir)) {
      const runtime = bundledNodePath(pluginDir);
      // Probe the bundled binary's real version so a swapped/corrupt runtime is caught.
      let rtVersion: string; let versionOk = false;
      try {
        const { execFileSync } = await import('node:child_process');
        rtVersion = execFileSync(runtime, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
        versionOk = assertSupportedNode({ version: rtVersion, exit: () => undefined as never, warn: () => {} }).ok;
      } catch (e) { rtVersion = `probe failed: ${(e as Error).message}`; }
      // Is the user-scope config command actually the bundled runtime? Read it back.
      // Detection MUST be by installed ENTRY PATH (expectedEntries), not the `_xbusOwner` tag:
      // Claude Code strips the non-standard tag when it re-serializes settings.json on the first
      // `claude` run, so a tag-only read would return command=null and false-fail a perfectly
      // wired install (matches the beta.5.1 session_start_hook fix just below). We build the same
      // expectedEntries the SessionStart check uses so a path-matched hook still yields `command`.
      let wired = false;
      try {
        const settingsPath = manifest?.userScope?.settingsPath ?? defaultClaudeSettingsPath();
        const expectedEntries = {
          SessionStart: path.join(pluginDir, 'dist', 'channel', 'session-start-hook.js'),
          UserPromptSubmit: path.join(pluginDir, 'dist', 'channel', 'hook-entry.js'),
          Stop: path.join(pluginDir, 'dist', 'channel', 'hook-entry.js'),
        };
        const hk = inspectUserScopeHooks(settingsPath, expectedEntries);
        const cmd = hk.events.SessionStart.command ?? '';
        wired = cmd.replace(/\\/g, '/').toLowerCase() === runtime.replace(/\\/g, '/').toLowerCase();
      } catch { /* best-effort */ }
      checks.push({ name: 'node_runtime', ok: versionOk && wired, detail: `bundled ${rtVersion} (pinned ${BUNDLED_NODE_VERSION}); config→bundled=${wired}` });
    } else {
      checks.push({ name: 'node_runtime', ok: true, detail: `no bundled runtime (running ${process.version}; system Node — dev/source or non-Windows install)` });
    }
  }

  // Beta.5: SessionStart (+ checkpoint) hooks registered at user scope. Reads the settings
  // file XBus actually writes hooks to (~/.claude/settings.json); an XBus SessionStart
  // handler is what makes plain `claude` announce every session. Absent → informational when
  // running uninstalled, but a FAIL when a plugin IS installed (a broken beta.5 install).
  //
  // Detection is by ENTRY PATH (from the install manifest), not the `_xbusOwner` tag alone:
  // Claude Code strips non-standard handler keys when it re-serializes settings.json, so a
  // tag-only check would false-fail a perfectly-wired hook after the first `claude` run. We
  // still surface owned=false so a host-stripped tag is visible (repair re-applies it), but a
  // path-matched hook is healthy — the hook executes regardless of the tag.
  let sessionStartOk = true; let hooksDetail: string;
  try {
    const manifest = readInstallManifest(defaultInstallRoot());
    // Only derive expected entry paths when the manifest actually carries a pluginDir.
    // readInstallManifest JSON-casts without validating, so a legacy/corrupt manifest could
    // lack pluginDir; guard so path.join(undefined,…) can't throw and mask a broken install
    // as a passing check (the catch would report ok=true, detail 'not checked'). Falls back
    // to tag-only detection, which still correctly reports NOT registered when appropriate.
    const pluginDir = typeof manifest?.pluginDir === 'string' && manifest.pluginDir.length > 0 ? manifest.pluginDir : undefined;
    const expectedEntries = pluginDir ? {
      SessionStart: path.join(pluginDir, 'dist', 'channel', 'session-start-hook.js'),
      UserPromptSubmit: path.join(pluginDir, 'dist', 'channel', 'hook-entry.js'),
      Stop: path.join(pluginDir, 'dist', 'channel', 'hook-entry.js'),
    } : undefined;
    const settingsPath = manifest?.userScope?.settingsPath ?? defaultClaudeSettingsPath();
    const hk = inspectUserScopeHooks(settingsPath, expectedEntries);
    const ss = hk.events.SessionStart;
    const missing = (['SessionStart', 'UserPromptSubmit', 'Stop'] as const).filter((e) => !hk.events[e].registered);
    const installedNow = manifest !== null;
    // Registered (by tag OR installed entry path) is healthy; the tag is not required for the
    // hook to fire. Uninstalled + absent → informational, not a failure.
    sessionStartOk = ss.registered ? true : !installedNow;
    hooksDetail = ss.registered
      ? `SessionStart→${path.basename(ss.entry ?? '?')} (owned=${ss.owned})${missing.length ? `; missing: ${missing.join(',')}` : '; all 3 wired'}`
      : installedNow ? 'SessionStart hook NOT registered (beta.5 session visibility inactive)' : 'no XBus hooks (running uninstalled / from source)';
  } catch (e) { hooksDetail = `not checked: ${(e as Error).message}`; }
  checks.push({ name: 'session_start_hook', ok: sessionStartOk, detail: hooksDetail });

  // Beta.5: the loopback dashboard. When a broker is running it records dashboardUrl in the
  // state file; probe /alive (bounded). Not running / no dashboard → informational, not a fail.
  let dashOk = true; let dashDetail: string;
  const dashUrl = state?.dashboardUrl;
  if (brokerOk && dashUrl) {
    const alive = await dashboardAlive(dashUrl, { timeoutMs: 1500 });
    dashOk = alive;
    dashDetail = alive ? `reachable at ${dashUrl}` : `state file advertises ${dashUrl} but /alive did not answer`;
  } else if (brokerOk && !dashUrl) {
    dashDetail = 'broker running without a dashboard (start advertises XBUS_NO_DASHBOARD?)';
  } else {
    dashDetail = 'broker not running (dashboard starts with the broker)';
  }
  checks.push({ name: 'dashboard', ok: dashOk, detail: dashDetail });

  // Beta.5 blocker #7: audit-ledger chain health. Verify the hash chain over a PHYSICALLY
  // read-only handle (never mutates, never blocks delivery). A broken chain is reported
  // honestly as a failure with the first broken seq; an absent DB is informational.
  let auditOk = true; let auditDetail: string;
  try {
    const dbPath = path.join(dir, 'xbus.sqlite');
    if (fs.existsSync(dbPath)) {
      const { openDatabase } = await import('../database/connection.js');
      const { verifyLedger } = await import('../broker/ledger.js');
      const rdb = openDatabase(dbPath, { readOnly: true });
      try {
        const v = verifyLedger(rdb);
        auditOk = v.ok;
        auditDetail = v.ok ? `chain intact (${v.checked} entries verified)` : `CHAIN BROKEN at seq ${v.firstBreak?.seq ?? '?'} (${v.checked} checked; delivery unaffected, audit history compromised)`;
      } finally { try { rdb.close(); } catch { /* ignore */ } }
    } else { auditDetail = 'no database yet (fresh install / broker never started)'; }
  } catch (e) { auditDetail = `not checked: ${(e as Error).message}`; }
  checks.push({ name: 'audit_ledger', ok: auditOk, detail: auditDetail });

  // If XBus is installed, validate the installed plugin against the SAME
  // normative contract the packager + installer use (consume one contract, not
  // ad-hoc lists). Absent install → informational, not a failure.
  try {
    const { validateArtifact } = await import('../shared/artifact-contract.js');
    const manifest = readInstallManifest(defaultInstallRoot());
    if (manifest) {
      const pc = validateArtifact(manifest.pluginDir, { scope: 'plugin', expectedVersion: XBUS_VERSION });
      checks.push({ name: 'installed_plugin_contract', ok: pc.ok, detail: pc.ok ? `VALID (${pc.checkedReferences} refs resolve in ${manifest.pluginDir})` : pc.violations.map((v) => v.rule).join(', ') });
      // Surface the installed-artifact manifest checksum (exact distributable
      // identity) recorded at install time, if present.
      installedManifestSha256 = (manifest as { artifactManifestSha256?: string }).artifactManifestSha256 ?? null;
    } else {
      checks.push({ name: 'installed_plugin_contract', ok: true, detail: 'no install manifest (running uninstalled / from source)' });
    }
  } catch (e) { checks.push({ name: 'installed_plugin_contract', ok: true, detail: `not checked: ${(e as Error).message}` }); }
  // §1: when the broker is reachable, embed the body-free metrics block so a single
  // command yields health + counts. Best-effort — NEVER fail doctor on it. The
  // existing { ok, version, buildId, checks } shape is preserved and only EXTENDED.
  let metrics: unknown;
  if (brokerOk) {
    try {
      const c = await connectAsAdmin();
      const r = await c.request('get_metrics', {});
      c.close();
      if (r.frameType === 'get_metrics_ack') metrics = (r.payload as { metrics: unknown }).metrics;
    } catch { /* metrics are optional; doctor still reports health */ }
  }
  const human = ['XBus doctor', ...checks.map((c) => `  [${c.ok ? 'ok' : 'XX'}] ${c.name}: ${c.detail}`)].join('\n');
  // The doctor JSON carries the FULL identity model + the
  // installed-artifact manifest checksum + the broker's exact build + a mixed-build
  // verdict (see ADR 0011). Legacy keys (version/buildId) are preserved as the compat values.
  const brokerBuild = brokerOk ? brokerExactBuild : null;
  // Explicit mixed-build verdict (an exact-build difference is a diagnostic,
  // never a security failure). When the broker is reachable, classify self↔broker.
  const mixedBuildStatus = brokerOk
    ? classifyMixedBuild(id, brokerBuild ?? undefined)
    : 'missing_provenance';
  const mixedBuilds = mixedBuildStatus === 'compatible_mixed_builds';
  const json: Record<string, unknown> = {
    ok: brokerOk,
    // Identity model:
    productVersion: id.productVersion,
    buildId: id.buildId,                 // EXACT (was the compat tuple in an earlier build)
    sourceCommit: id.sourceCommit,
    compatibilityId: id.compatibilityId,
    applicationProtocolVersion: id.applicationProtocolVersion,
    secureTransportProtocolVersion: id.secureTransportProtocolVersion,
    schemaVersion: id.schemaVersion,
    installedArtifactManifestSha256: installedManifestSha256,
    brokerExactBuild: brokerBuild,
    compatibilityResult: compatibility,
    mixedBuildStatus,
    mixedBuilds,
    // legacy keys retained:
    version: id.productVersion,
    checks,
  };
  if (metrics !== undefined) json.metrics = metrics;
  return { human, json, exitCode: 0 };
}

async function cmdStatus(): Promise<CliResult> {
  try {
    const c = await connectAsAdmin();
    const s = await c.request('get_status', {});
    c.close();
    return { human: `XBus broker: connected\nProtocol: v${PROTOCOL_VERSION}\nXBus: v${XBUS_VERSION}`, json: { ok: true, ...(s.payload as object) }, exitCode: 0 };
  } catch (e) {
    return errorResult(e instanceof XBusError ? e : new XBusError(XBusErrorCode.BROKER_UNAVAILABLE, 'broker unavailable'));
  }
}

async function cmdSessions(): Promise<CliResult> {
  const c = await connectAsAdmin();
  const r = await c.request('list_sessions', {});
  c.close();
  // Hide the CLI's own short-lived admin session (project 'proj-cli').
  const sessions = (r.payload as { sessions: Array<Record<string, unknown>> }).sessions.filter((s) => String(s.project) !== 'proj-cli');
  return { human: formatSessions(sessions), json: { ok: true, sessions }, exitCode: 0 };
}

async function cmdMetrics(): Promise<CliResult> {
  try {
    const c = await connectAsAdmin();
    const r = await c.request('get_metrics', {});
    c.close();
    if (r.frameType === 'error') {
      const p = r.payload as { code: XBusErrorCode; message: string };
      return errorResult(new XBusError(p.code, p.message));
    }
    const metrics = (r.payload as { metrics: Parameters<typeof formatMetrics>[0] }).metrics;
    return { human: formatMetrics(metrics), json: { ok: true, metrics }, exitCode: 0 };
  } catch (e) {
    return errorResult(e instanceof XBusError ? e : new XBusError(XBusErrorCode.BROKER_UNAVAILABLE, 'broker unavailable'));
  }
}

async function cmdSend(to: string, text: string): Promise<CliResult> {
  const c = await connectAsAdmin();
  const r = await c.request('send_message', { to, text });
  c.close();
  if (r.frameType === 'error') {
    const p = r.payload as { code: XBusErrorCode; message: string };
    return errorResult(new XBusError(p.code, p.message));
  }
  const p = r.payload as { messageId: string; sequence: number; state: string; recipientAlias: string; recipientReceiveMode?: string };
  return { human: formatSendResult(p), json: { ok: true, ...p }, exitCode: 0 };
}

async function cmdStart(): Promise<CliResult> {
  const dir = dataDir();
  // The host writes the identity-rich state file (ADR 0007) + enables IPC shutdown.
  // Beta.5 (blocker #2): the PRODUCTION start path — the single funnel EVERY broker reaches
  // (ensure.ts auto-start spawns `node dist/cli/main.js start`, and the manual CLI runs the
  // same) — enables the control plane: the read-only localhost dashboard AND the metadata-only
  // dormant import. Both are best-effort inside the host (a failure never fails broker start,
  // I5), so turning them on here cannot regress messaging. Opt-OUT via env for constrained
  // environments (headless CI that only needs messaging), never opt-in-for-tests.
  // AGENTEL_* primary, XBUS_* deprecated alias (ADR 0028 Category C).
  const dashboardOff = readConfigEnv('DASHBOARD') === '0' || readConfigEnv('NO_DASHBOARD') === '1';
  const importOff = readConfigEnv('IMPORT_DORMANT') === '0';
  const broker = await startBrokerHost({
    dataDir: dir,
    onStopped: () => process.exit(0),
    ...(dashboardOff ? {} : { dashboard: true }),
    ...(importOff ? {} : { importDormantSessions: true }),
  });
  // F-stopwait: AWAIT a clean stop (WAL checkpoint + state-file removal + db.close)
  // before exiting, so a slow stop never leaks a stale state file. A bounded
  // backstop timer guards against a stop that hangs.
  let stopping = false;
  const gracefulExit = async () => {
    if (stopping) return; stopping = true;
    const backstop = setTimeout(() => process.exit(0), 5000);
    if (typeof backstop.unref === 'function') backstop.unref();
    try { await broker.stop(); } catch { /* ignore */ }
    clearTimeout(backstop);
    process.exit(0);
  };
  process.on('SIGINT', () => { void gracefulExit(); });
  process.on('SIGTERM', () => { void gracefulExit(); });
  const dashLine = broker.dashboardUrl ? `Dashboard: ${broker.dashboardUrl} (open with: ${invocationHint('dashboard')})\n` : '';
  process.stdout.write(`AgenTel broker started (instance ${broker.brokerInstanceId}, build ${BUILD_ID}).\nEndpoint: ${broker.endpoint}\n${dashLine}PID: ${process.pid}\nPress Ctrl+C to stop.\n`);
  await new Promise(() => {}); // run until killed
  return { human: '', json: {}, exitCode: 0 };
}

/**
 * `xbus dashboard [--no-open]` (beta.5 blocker #3): mint a one-time browser-open URL from the
 * RUNNING broker and open the default browser (unless --no-open). The nonce lives only in the
 * URL fragment we hand the browser; it is NEVER printed, logged, or persisted — the CLI prints
 * only the base dashboard URL. Requires a running broker with the dashboard enabled (the
 * production start path enables it; start one with `xbus start` if absent).
 */
async function cmdDashboard(noOpen: boolean): Promise<CliResult> {
  let openUrl: string; let dashboardUrl: string; let available: boolean;
  try {
    const c = await connectAsAdmin();
    const r = await c.request('ensure_dashboard', {});
    c.close();
    if (r.frameType === 'error') {
      const p = r.payload as { code: XBusErrorCode; message: string };
      return errorResult(new XBusError(p.code, p.message));
    }
    const p = r.payload as { available: boolean; openUrl?: string; dashboardUrl?: string };
    available = p.available;
    openUrl = p.openUrl ?? '';
    dashboardUrl = p.dashboardUrl ?? '';
  } catch {
    return { human: `Dashboard unavailable: no broker reachable. Start one with: ${invocationHint('start')}`, json: { ok: false, reason: 'broker_unreachable' }, exitCode: 1 };
  }
  if (!available || !openUrl) {
    return { human: `The running broker has no dashboard enabled (it may be running with XBUS_DASHBOARD=0). Restart with the dashboard enabled.`, json: { ok: false, reason: 'dashboard_disabled' }, exitCode: 1 };
  }
  if (noOpen) {
    // Print the open-URL for a human to paste ONCE (it carries a single-use nonce). This is
    // the explicit --no-open path; the nonce is consumed on first load and expires shortly.
    return { human: `Dashboard: ${dashboardUrl}\nOne-time open link (single-use, expires in ~60s):\n  ${openUrl}`, json: { ok: true, dashboardUrl, opened: false }, exitCode: 0 };
  }
  const { BrowserOpener } = await import('../broker/dashboard/browser.js');
  new BrowserOpener().forceOpen(openUrl); // explicit re-open bypasses debounce
  return { human: `Opened the XBus dashboard in your default browser.\n  ${dashboardUrl}`, json: { ok: true, dashboardUrl, opened: true }, exitCode: 0 };
}

/**
 * Safe stop (ADR 0007): authenticated IPC shutdown is the NORMAL path; forced
 * kill is a fallback that runs ONLY after identity checks pass. Never kills by
 * process name; never signals an unrelated/foreign-owned/mismatched process.
 */
async function cmdStop(): Promise<CliResult> {
  const dir = dataDir();
  const decision = classifyShutdown(dir);
  if (decision.action === 'none') {
    if (decision.reason.includes('stale')) { try { fs.unlinkSync(stateFilePath(dir)); } catch { /* ignore */ } }
    return { human: `Nothing to stop: ${decision.reason}`, json: { ok: true, stopped: false, reason: decision.reason }, exitCode: 0 };
  }
  if (decision.action === 'refuse') {
    return { human: `Refusing to stop: ${decision.reason}`, json: { ok: false, refused: true, reason: decision.reason }, exitCode: 1 };
  }
  // action === 'ipc': try the authenticated graceful path first.
  const state = readStateFile(dir);
  try {
    const c = await connectAsAdmin();
    const ack = await c.request('shutdown', { brokerInstanceId: state?.brokerInstanceId });
    c.close();
    if (ack.frameType === 'shutdown_ack') {
      return { human: `XBus broker (instance ${state?.brokerInstanceId}) shutting down gracefully.`, json: { ok: true, stopped: true, method: 'ipc' }, exitCode: 0 };
    }
    return { human: `Broker refused shutdown: ${JSON.stringify(ack.payload)}`, json: { ok: false, payload: ack.payload }, exitCode: 1 };
  } catch (e) {
    // IPC failed (broker hung/unreachable). Forced kill is eligible ONLY because
    // classifyShutdown already verified owner + alive + (no) instance mismatch.
    const pid = decision.pid;
    if (pid && pidIsAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        return { human: `Broker IPC unreachable (${(e as Error).message}); sent SIGTERM to verified broker pid ${pid}.`, json: { ok: true, stopped: true, method: 'forced', pid }, exitCode: 0 };
      } catch (ke) {
        return { human: `Could not signal verified broker pid ${pid}: ${(ke as Error).message}`, json: { ok: false, pid }, exitCode: 1 };
      }
    }
    return { human: `Broker not reachable and pid not alive; run: ${invocationHint('doctor')}`, json: { ok: false }, exitCode: 1 };
  }
}

/**
 * Beta.9 (ADR 0029): `agentel verify` — the one frictionless verification command. Resolves an
 * approved Node runtime (no PATH/NVM dependence), installs deps on it, runs the full gate +
 * acceptance + audit, proves the deterministic artifact SHA, and fails closed with a precise,
 * class-tagged remediation. This runs OUTSIDE an installed context (in a checkout), so it resolves
 * the repo root from the CLI location, not the install manifest.
 */
async function cmdVerify(args: string[]): Promise<CliResult> {
  // The verify command must run from a source checkout (it builds + tests). Dynamic-import the
  // tool so an installed artifact (no dist/tools/) never fails to load the CLI.
  const repoRoot = resolveRepoRoot();
  let runVerify: typeof import('../tools/verify.js').runVerify;
  try { ({ runVerify } = await import('../tools/verify.js')); }
  catch { return { human: '`agentel verify` runs from a source checkout only (the dev/release tools are not shipped in the installed artifact).', json: { ok: false, reason: 'tools-not-available' }, exitCode: 2 }; }
  const report = runVerify({ repoRoot, skipAcceptance: args.includes('--skip-acceptance') });
  const human = report.ok
    ? `AgenTel verify PASSED — ${report.stages.length} stages, runtime ${report.runtime.version} (${report.runtime.source}), artifact SHA-256 ${report.artifactSha256 ?? '—'}.\nReport: ${path.join(repoRoot, '.agentel', 'verify-report.json')}`
    : `AgenTel verify FAILED at [${report.failure?.class}] ${report.failure?.stage}.\n${report.failure?.remediation}\nReport: ${path.join(repoRoot, '.agentel', 'verify-report.json')}`;
  return { human, json: report, exitCode: report.ok ? 0 : 1 };
}

/**
 * Beta.9 (ADR 0029): `agentel release-check` — pre-tag readiness + reproducible artifact SHA.
 * `--bundled-node <path>` supplies the vetted node.exe so the PUBLISHABLE (bundled) SHA is computed.
 */
async function cmdReleaseCheck(args: string[]): Promise<CliResult> {
  const repoRoot = resolveRepoRoot();
  const bnIdx = args.indexOf('--bundled-node');
  const bundledNode = bnIdx > -1 ? args[bnIdx + 1] : undefined;
  let runReleaseCheck: typeof import('../tools/release-check.js').runReleaseCheck;
  try { ({ runReleaseCheck } = await import('../tools/release-check.js')); }
  catch { return { human: '`agentel release-check` runs from a source checkout only (the dev/release tools are not shipped in the installed artifact).', json: { ok: false, reason: 'tools-not-available' }, exitCode: 2 }; }
  const report = runReleaseCheck({ repoRoot, ...(bundledNode ? { bundledNode } : {}) });
  const lines = [
    `AgenTel release-check ${report.ok ? 'READY' : 'NOT READY'} — commit ${report.commit?.slice(0, 12) ?? '(unknown)'}, tree-clean ${report.treeClean}.`,
    report.runtimeFree ? `  runtime-free SHA-256: ${report.runtimeFree.sha256} (${report.runtimeFree.bytes} B, reproducible=${report.runtimeFree.reproducible})` : '',
    report.bundled ? `  bundled (PUBLISH) SHA-256: ${report.bundled.sha256} (${report.bundled.bytes} B, reproducible=${report.bundled.reproducible}, node ${report.bundled.bundledNodeVersion})` : '  bundled artifact: skipped (pass --bundled-node <path>)',
    ...report.problems.map((p) => `  ! ${p}`),
  ].filter(Boolean);
  return { human: lines.join('\n'), json: report, exitCode: report.ok ? 0 : 1 };
}

/** Beta.9 (ADR 0029): the subcommands whose job is to LOCATE + re-exec an approved runtime, so the
 *  entry-point Node-floor guard must NOT block them (they run under any Node, e.g. a global Node 25
 *  first on PATH). Exported + used by the entry guard AND unit-tested. */
export const RUNTIME_RESOLVING_COMMANDS = new Set(['verify', 'release-check', 'govern']);

/** The subcommand in a raw argv tail = the first NON-flag token. `--json` (and any flag) may
 *  appear before it (`agentel --json verify`), so a positional argv[2] check is wrong. Pure. */
export function detectSubcommand(argvTail: readonly string[]): string | undefined {
  return argvTail.find((a) => !a.startsWith('-'));
}

/** Should the Node-floor guard be skipped for this invocation? True for runtime-resolving cmds. */
export function shouldSkipNodeGuard(argvTail: readonly string[]): boolean {
  return RUNTIME_RESOLVING_COMMANDS.has(detectSubcommand(argvTail) ?? '');
}

/** Resolve the source-checkout repo root from the CLI location (shared by verify/release-check/govern). */
function resolveRepoRoot(): string {
  const here = process.argv[1] ? path.dirname(process.argv[1]) : process.cwd();
  for (const cand of [path.resolve(here, '..', '..', '..'), path.resolve(here, '..', '..'), process.cwd()]) {
    if (fs.existsSync(path.join(cand, 'package.json')) && fs.existsSync(path.join(cand, 'tsconfig.json'))) return cand;
  }
  return process.cwd();
}

/**
 * Beta.9 (ADR 0029): `agentel govern <status|install-reviewer>` — opt-in governance helpers.
 *   status           — is this repo governed? which reviewer resolves? is evidence emitted?
 *   install-reviewer — discover + install the Stage-1 code-reviewer agent into .claude/agents/
 */
async function cmdGovern(args: string[]): Promise<CliResult> {
  const repoRoot = resolveRepoRoot();
  const sub = args[0] ?? 'status';
  let gov: GovernanceModule;
  try { gov = await import('../tools/governance.js'); }
  catch { return { human: '`agentel govern` runs from a source checkout only (the dev/release tools are not shipped in the installed artifact).', json: { ok: false, reason: 'tools-not-available' }, exitCode: 2 }; }
  const { isGovernanceEnabled, readGovernanceConfig, discoverReviewerAgent, installReviewerAgent, GOVERNANCE_CONFIG_REL } = gov;
  const enabled = isGovernanceEnabled(repoRoot);
  if (sub === 'install-reviewer') {
    // Search this repo (env override → .claude/agents → agents/), plus any dirs the operator
    // supplies via AGENTEL_REVIEWER_SEARCH (os-path-delimited). No machine-specific paths are
    // hardcoded — the reviewer is either vendored in-repo, named by env, or on a supplied dir.
    const extra = (process.env.AGENTEL_REVIEWER_SEARCH ?? '').split(path.delimiter).filter(Boolean);
    const disc = discoverReviewerAgent(repoRoot, process.env, (p) => fs.existsSync(p), extra);
    const res = installReviewerAgent(repoRoot, disc);
    return { human: res.ok ? `Reviewer agent: ${res.detail}\n  → ${res.installedTo}` : `Reviewer install FAILED: ${res.detail}`, json: { ...res, discovery: disc }, exitCode: res.ok ? 0 : 1 };
  }
  // status
  const cfg = readGovernanceConfig(repoRoot);
  const disc = discoverReviewerAgent(repoRoot, process.env, (p) => fs.existsSync(p), []);
  const lines = [
    `AgenTel governance for ${repoRoot}`,
    `  enabled:        ${enabled}${enabled ? '' : ` (create ${GOVERNANCE_CONFIG_REL} to opt in)`}`,
    `  config:         ${cfg ? JSON.stringify(cfg) : '(none)'}`,
    `  reviewer agent: ${disc.found ? `${disc.origin} → ${disc.sourcePath}` : 'not installed (run: agentel govern install-reviewer)'}`,
    `  evidence:       ${enabled ? 'emitted under .preflight/gate/ after a passing `agentel verify`' : 'inert (repo not governed)'}`,
  ];
  return { human: lines.join('\n'), json: { enabled, config: cfg, reviewer: disc, repoRoot }, exitCode: 0 };
}

export async function run(argv: string[]): Promise<void> {
  const asJson = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const cmd = args[0];
  try {
    switch (cmd) {
      case 'install':
        return emit(await cmdInstall(args.includes('--dry-run')), asJson);
      case 'uninstall':
        return emit(cmdUninstall(args.includes('--dry-run'), args.includes('--remove-data')), asJson);
      case 'repair':
        return emit(cmdRepair(), asJson);
      case 'verify':
        return emit(await cmdVerify(args.slice(1)), asJson);
      case 'release-check':
        return emit(await cmdReleaseCheck(args.slice(1)), asJson);
      case 'govern':
        return emit(await cmdGovern(args.slice(1)), asJson);
      case 'doctor':
        return emit(await cmdDoctor(), asJson);
      case 'status':
        return emit(await cmdStatus(), asJson);
      case 'sessions':
        return emit(await cmdSessions(), asJson);
      case 'metrics':
        return emit(await cmdMetrics(), asJson);
      case 'send': {
        const to = args[1];
        const text = args.slice(2).join(' ');
        if (!to || !text) return emit({ human: 'Usage: xbus send <recipient> <text>', json: { ok: false }, exitCode: 2 }, asJson);
        return emit(await cmdSend(to, text), asJson);
      }
      case 'start':
        return emit(await cmdStart(), asJson);
      case 'stop':
        return emit(await cmdStop(), asJson);
      case 'dashboard':
        return emit(await cmdDashboard(args.includes('--no-open')), asJson);
      case 'pause':
      case 'resume':
      case 'dnd': {
        const mode = cmd === 'pause' ? 'paused' : cmd === 'resume' ? 'active' : (args[1] === 'off' ? 'active' : 'do_not_disturb');
        const c = await connectAsAdmin();
        const r = await c.request('set_control', { mode });
        c.close();
        return emit({ human: `Receive control set: ${(r.payload as { mode: string }).mode} (applies to the CLI admin session; a Claude session controls its own receipt).`, json: { ok: true, ...(r.payload as object) }, exitCode: 0 }, asJson);
      }
      case 'block':
      case 'unblock': {
        const alias = args[1];
        if (!alias) return emit({ human: `Usage: xbus ${cmd} <alias>`, json: { ok: false }, exitCode: 2 }, asJson);
        const c = await connectAsAdmin();
        const r = await c.request('block_peer', { alias, unblock: cmd === 'unblock' });
        c.close();
        return emit({ human: `${cmd === 'block' ? 'Blocked' : 'Unblocked'} peer alias: ${alias}`, json: { ok: true, ...(r.payload as object) }, exitCode: 0 }, asJson);
      }
      case 'inbox': {
        const c = await connectAsAdmin();
        const r = await c.request('inbox', { markInjected: false });
        c.close();
        const msgs = (r.payload as { messages: Array<{ messageId: string; senderAlias: string; text: string }> }).messages;
        const human = msgs.length === 0 ? 'Inbox empty.' : msgs.map((m) => `${m.messageId.slice(0, 8)}  from ${m.senderAlias}: ${m.text.slice(0, 60)}`).join('\n');
        return emit({ human, json: { ok: true, messages: msgs }, exitCode: 0 }, asJson);
      }
      case 'process-next': {
        // Manual single-step delivery. `process_next` is a RECEIVER-session
        // operation (the session in manual_checkpoint mode steps its OWN inbox via
        // its hook component, role 'hook'); the connection-bound authority model
        // (ADR 0003) means it can only act on the caller's own receiving session —
        // an admin CLI session is poll_only and is NOT a receiver, so the broker
        // returns FORBIDDEN_ROLE. Report that honestly rather than implying the CLI
        // can step another session's inbox (which the model forbids by design).
        const c = await connectAsAdmin();
        const r = await c.request('process_next', {});
        c.close();
        if (r.frameType === 'error') {
          const p = r.payload as { code: string; message: string };
          if (p.code === XBusErrorCode.FORBIDDEN_ROLE) {
            return emit({ human: 'process-next operates on a RECEIVING session in manual_checkpoint mode (invoked by that session, not the admin CLI). The admin CLI session does not receive messages, so there is nothing to step. Use it from a session configured for manual delivery.', json: { ok: true, applicable: false, reason: 'admin session is not a receiver' }, exitCode: 0 }, asJson);
          }
          return emit(errorResult(new XBusError(p.code as XBusErrorCode, p.message)), asJson);
        }
        const msgs = (r.payload as { messages: Array<{ messageId: string; senderAlias: string }> }).messages ?? [];
        const human = msgs.length === 0 ? 'process-next: nothing pending.' : msgs.map((m) => `injected ${m.messageId.slice(0, 8)} from ${m.senderAlias}`).join('\n');
        return emit({ human, json: { ok: true, messages: msgs }, exitCode: 0 }, asJson);
      }
      case 'dead-letter': {
        // `xbus dead-letter [list|inspect <id>]` — read-only inspection of
        // dead-lettered deliveries (safe metadata only; never a message body).
        const sub = args[1] ?? 'list';
        const c = await connectAsAdmin();
        if (sub === 'inspect') {
          const id = args[2];
          if (!id) { c.close(); return emit({ human: 'Usage: xbus dead-letter inspect <messageId>', json: { ok: false }, exitCode: 2 }, asJson); }
          const r = await c.request('dead_letter', { action: 'inspect', messageId: id });
          c.close();
          const record = (r.payload as { record: unknown }).record;
          return emit({ human: record ? JSON.stringify(record, null, 2) : `No dead letter with id ${id}.`, json: { ok: true, record }, exitCode: 0 }, asJson);
        }
        const r = await c.request('dead_letter', { action: 'list' });
        c.close();
        const records = (r.payload as { records: Array<{ messageId: string; sender: string; recipient: string; failureCategory: string; recommendedRecovery: string }> }).records;
        const human = records.length === 0 ? 'No dead letters.' : records.map((d) => `${d.messageId.slice(0, 8)}  ${d.sender}→${d.recipient}  ${d.failureCategory}  [${d.recommendedRecovery}]`).join('\n');
        return emit({ human, json: { ok: true, records }, exitCode: 0 }, asJson);
      }
      case 'version':
      case '--version': {
        // Report the FULL identity model — product version, EXACT
        // build id, source commit, the STABLE compatibility id, and the three
        // version numbers — so different builds are unambiguously distinguishable (see ADR 0011).
        const id = thisIdentity();
        const human = [
          `xbus ${id.productVersion}`,
          `  build:           ${id.buildId}`,
          `  source commit:   ${id.sourceCommit}`,
          `  compatibility:   ${id.compatibilityId}`,
          `  app protocol:    ${id.applicationProtocolVersion}`,
          `  secure transport:${id.secureTransportProtocolVersion}`,
          `  schema:          ${id.schemaVersion}`,
        ].join('\n');
        return emit({ human, json: {
          productVersion: id.productVersion,
          buildId: id.buildId,
          sourceCommit: id.sourceCommit,
          compatibilityId: id.compatibilityId,
          applicationProtocolVersion: id.applicationProtocolVersion,
          secureTransportProtocolVersion: id.secureTransportProtocolVersion,
          schemaVersion: id.schemaVersion,
          // legacy keys retained for back-compat consumers
          version: id.productVersion, protocol: id.applicationProtocolVersion,
        }, exitCode: 0 }, asJson);
      }
      default:
        return emit({ human: [
          'agentel <command> [--json]   (alias: xbus, deprecated)',
          '  install [--dry-run]               install the AgenTel plugin (user scope)',
          '  uninstall [--dry-run] [--remove-data]',
          '  verify [--skip-acceptance]        one-command full verification on an approved runtime',
          '  release-check [--bundled-node <p>] pre-tag readiness + reproducible artifact SHA-256',
          '  govern [status|install-reviewer]  opt-in governance: reviewer install + push-gate evidence',
          '  doctor                            health + installed-plugin contract check',
          '  status                            broker connectivity + versions',
          '  sessions                          list registered sessions',
          '  metrics                           body-free operational health/counters (admin)',
          '  send <recipient> <text>           send a message',
          '  start | stop                      run / stop the broker (start enables the dashboard)',
          '  dashboard [--no-open]             open the control-plane dashboard in your browser',
          '  pause | resume                    suspend / resume automatic delivery',
          '  dnd [on|off]                      do-not-disturb toggle',
          '  block <alias> | unblock <alias>   block / unblock a peer alias',
          '  inbox                             list pending messages',
          '  process-next                      manually inject the next pending message',
          '  dead-letter [list | inspect <id>] inspect dead-lettered deliveries (admin)',
          '  version',
          '(PATH / PowerShell-profile integration is a separate, explicitly-requested step.)',
        ].join('\n'), json: { ok: false }, exitCode: 2 }, asJson);
    }
  } catch (e) {
    return emit(errorResult(e), asJson);
  }
}

if (process.argv[1] && process.argv[1].endsWith('main.js')) {
  // §8: fail fast with an actionable message on an unsupported Node, BEFORE any
  // install/broker machinery runs (rather than failing deep inside it).
  // Beta.9 (ADR 0029): EXEMPT the runtime-resolving commands (verify / release-check / govern).
  // These are the commands whose whole job is to LOCATE + re-exec an approved runtime, so they
  // must be launchable under ANY Node (e.g. a global Node 25 first on PATH) — otherwise the
  // frictionless entry point is unreachable on exactly the machines it exists to help. Their own
  // resolver enforces the floor for the actual build/test work.
  // Detect the subcommand by scanning ALL user args for the first non-flag token — `run()` itself
  // filters `--json` from any position, so `agentel --json verify` is valid and its command is
  // still `verify`. A positional-only (argv[2]) check would miss that and wrongly block verify
  // under Node 25. (Pure helper, unit-tested.)
  if (!shouldSkipNodeGuard(process.argv.slice(2))) assertSupportedNode();
  // Beta.8 (ADR 0028): `xbus` is a DEPRECATED alias of the primary `agentel` command, kept
  // functional for >=2 releases. If invoked via the legacy bin name, print a one-line note
  // (stderr, never blocks) then behave identically.
  if (/[\\/]xbus(\.(cmd|exe|ps1))?$/i.test(process.argv[1] ?? '')) {
    process.stderr.write("[agentel] note: 'xbus' is a deprecated alias of 'agentel' and will be removed in a future release; use 'agentel'.\n");
  }
  void run(process.argv.slice(2));
}
