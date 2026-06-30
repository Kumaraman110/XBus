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
import { repairUserScope, defaultClaudeConfigPath } from './user-scope-config.js';
import { readProvenance, resolveIdentity, provenancePathFromDist, classifyMixedBuild, type Provenance } from '../shared/build-identity.js';
import { assertSupportedNode } from '../shared/node-support.js';

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
      `xbus install (dry-run) — no changes made.`,
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
    return { human: `xbus install FAILED: ${r.error ?? 'unknown'}${r.rolledBack ? ' (rolled back)' : ''}\nRun: ${invocationHint('doctor')}`, json: { ...r }, exitCode: 1 };
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
  const r = repairUserScope({
    configPath,
    nodePath: process.execPath,
    serverEntry: path.join(manifest.pluginDir, 'dist', 'channel', 'server.js'),
    hookEntry: path.join(manifest.pluginDir, 'dist', 'channel', 'hook-entry.js'),
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
  const broker = await startBrokerHost({ dataDir: dir, onStopped: () => process.exit(0) });
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
  process.stdout.write(`XBus broker started (instance ${broker.brokerInstanceId}, build ${BUILD_ID}).\nEndpoint: ${broker.endpoint}\nPID: ${process.pid}\nPress Ctrl+C to stop.\n`);
  await new Promise(() => {}); // run until killed
  return { human: '', json: {}, exitCode: 0 };
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
          'xbus <command> [--json]',
          '  install [--dry-run]               install the XBus plugin (user scope)',
          '  uninstall [--dry-run] [--remove-data]',
          '  doctor                            health + installed-plugin contract check',
          '  status                            broker connectivity + versions',
          '  sessions                          list registered sessions',
          '  metrics                           body-free operational health/counters (admin)',
          '  send <recipient> <text>           send a message',
          '  start | stop                      run / stop the broker',
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
  assertSupportedNode();
  void run(process.argv.slice(2));
}
