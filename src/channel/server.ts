/**
 * XBus MCP server entrypoint. Started by Claude Code as a stdio MCP server.
 *
 * Identity: CLAUDE_CODE_SESSION_ID (hard-fail if absent — never invent one).
 * Endpoint + data dir resolved from XBUS_DATA_DIR (set by the launcher/plugin)
 * or the default user-level location.
 */
import { v7 as uuidv7 } from 'uuid';
import { McpServer } from './mcp-server.js';
import { loadOrCreateRootSecret } from '../ipc/root-secret.js';
import { defaultEndpoint } from '../ipc/transport.js';
import { computeProjectId, deriveWorkspaceSuggestion } from '../identity/project.js';
import { suggestSessionName } from '../identity/session-name.js';
import { resolveDurableName } from './owner-secret-store.js';
import { ensureBrokerDefault } from '../broker/ensure.js';
import { resolveDataDir as resolveCanonicalDataDir } from '../launcher/install-paths.js';
import { readConfigEnv } from '../shared/env-config.js';

/**
 * The MCP server resolves the SINGLE canonical data root (env override →
 * installed manifest dataDir → uninstalled default). Re-exported so the checkpoint
 * hook (`hook-entry.ts`) shares the exact same resolution. Both the broker and the
 * runtime now agree on one root — no orphaned `<installRoot>/data`.
 */
export function resolveDataDir(): string {
  return resolveCanonicalDataDir();
}

export function main(): void {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId || sessionId.trim() === '') {
    // Hard failure: a Channel/MCP server with no session id cannot register.
    process.stderr.write('[xbus] FATAL: CLAUDE_CODE_SESSION_ID is not set; cannot register session.\n');
    process.exit(1);
  }
  const cwd = process.cwd();
  const dataDir = resolveDataDir();
  const endpoint = defaultEndpoint(dataDir);
  // The root secret load can THROW (malformed/unreadable/concurrently-replaced secret).
  // Degrade gracefully rather than crash with an uncaught exception: emit an actionable
  // diagnostic and exit non-fatally. Claude itself keeps running; only the xbus MCP tools
  // are absent this session (the "Claude remains usable when XBus is degraded" contract).
  let rootSecret: Buffer;
  try {
    rootSecret = loadOrCreateRootSecret(dataDir);
  } catch (e) {
    process.stderr.write(`[xbus] XBus MCP unavailable this session (root secret load failed): ${(e as Error).message}\n`);
    process.exit(0);
  }
  const projectId = computeProjectId(cwd);
  const agentType = readConfigEnv('AGENT_TYPE') ?? 'claude';
  // Beta.4 (ADR 0012 D3): derive a suggested session name from the workspace
  // (git repo / dir / agent+project). The broker awards it if valid+unclaimed,
  // else the session enters pending_name and the model is prompted to choose one.
  const savedName = readConfigEnv('SESSION_NAME'); // explicit override / saved pref (AGENTEL_/XBUS_)
  // BETA.11 (ADR 0037): recover the DURABLE name this (projectId, agentType) last held, so a
  // resumed session (new Claude session id) re-requests the name it actually owns — making
  // loadOwnerSecret hit the correct anchor and the broker's reclaim run automatically. Precedence:
  // an explicit SESSION_NAME override wins (a user deliberately pinning a name), then the recovered
  // durable name, then the workspace suggestion (first-ever launch / never-named). Without this a
  // resume requests the workspace suggestion, misses its own owner-secret, and lands pending.
  const durableName = savedName === undefined ? resolveDurableName(dataDir, projectId, agentType) : undefined;
  const suggestion = savedName !== undefined
    ? suggestSessionName(deriveWorkspaceSuggestion(cwd, { agentType, projectId, savedName }))
    : (durableName ?? suggestSessionName(deriveWorkspaceSuggestion(cwd, { agentType, projectId })));

  const server = new McpServer({
    sessionId,
    instanceId: uuidv7(),
    projectId,
    cwd,
    endpoint,
    rootSecret,
    agentType,
    // Beta.8 (ADR 0027): the ACL-protected data dir where the durable-identity ownership
    // secret is persisted, so a NEW session id can reclaim this name + inbox automatically.
    dataDir,
    ...(suggestion !== null ? { requestedSessionName: suggestion } : {}),
    // Zero-friction: auto-start the broker if none is running (race-safe, degraded-
    // tolerant). A failure is non-fatal — the MCP connect will surface a clean error.
    ensureBroker: async () => { await ensureBrokerDefault(dataDir, { log: (m) => process.stderr.write(`[xbus-mcp] ${m}\n`) }); },
    write: (line) => process.stdout.write(line),
    log: (line) => process.stderr.write(`[xbus-mcp] ${line}\n`),
  });
  server.start(process.stdin);
}

// Run when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  main();
}
