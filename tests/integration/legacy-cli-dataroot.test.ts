/**
 * §5 — canonical data root + newly-exposed CLI capabilities.
 *
 * Covers two install-observability behaviours:
 *   resolveDataDir() is the SINGLE authoritative root with the
 *     precedence env override → installed-manifest dataDir → uninstalled default.
 *   the `dead_letter` admin IPC verb (backed by DeadLetterStore)
 *     is reachable + admin-gated; non-admin is refused.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { doHello } from '../../src/ipc/hello.js';
import { ComponentRole } from '../../src/identity/components.js';
import { resolveDataDir, defaultDataDir, manifestPath, defaultInstallRoot } from '../../src/launcher/install-paths.js';

let broker: RunningBroker;
const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
function freshDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-rc4-')); dirs.push(d); return d; }

beforeEach(() => {
  savedEnv.XBUS_DATA_DIR = process.env.XBUS_DATA_DIR;
  savedEnv.XBUS_INSTALL_ROOT = process.env.XBUS_INSTALL_ROOT;
});
afterEach(async () => {
  try { await broker?.stop(); } catch { /* ignore */ }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
  if (savedEnv.XBUS_DATA_DIR === undefined) delete process.env.XBUS_DATA_DIR; else process.env.XBUS_DATA_DIR = savedEnv.XBUS_DATA_DIR;
  if (savedEnv.XBUS_INSTALL_ROOT === undefined) delete process.env.XBUS_INSTALL_ROOT; else process.env.XBUS_INSTALL_ROOT = savedEnv.XBUS_INSTALL_ROOT;
});

describe('§5 — canonical data root (resolveDataDir precedence)', () => {
  it('1) explicit XBUS_DATA_DIR wins over everything', () => {
    const d = freshDir();
    process.env.XBUS_DATA_DIR = d;
    expect(resolveDataDir()).toBe(d);
  });

  it('2) with no env override, the INSTALLED manifest dataDir is authoritative', () => {
    delete process.env.XBUS_DATA_DIR;
    const installRoot = freshDir();
    process.env.XBUS_INSTALL_ROOT = installRoot;
    const dataDir = path.join(installRoot, 'data');
    const manifest = {
      schema: 1, name: 'xbus', version: '0.1.0', commit: 'x', buildId: 'b',
      installedAt: '2026-01-01T00:00:00.000Z', installRoot,
      pluginDir: path.join(installRoot, 'plugin'), dataDir, files: [], backups: [],
    };
    fs.writeFileSync(manifestPath(installRoot), JSON.stringify(manifest));
    expect(defaultInstallRoot()).toBe(installRoot);
    expect(resolveDataDir()).toBe(dataDir);
  });

  it('3) uninstalled (no env, no manifest) falls back to the default data dir', () => {
    delete process.env.XBUS_DATA_DIR;
    process.env.XBUS_INSTALL_ROOT = freshDir(); // empty install root, no manifest
    expect(resolveDataDir()).toBe(defaultDataDir());
  });
});

describe('§5 — dead_letter admin IPC verb', () => {
  async function client(b: RunningBroker, role: 'admin' | 'mcp'): Promise<IpcClient> {
    const c = new IpcClient(b.endpoint, { requestTimeoutMs: 4000, rootSecret: b.rootSecret!, helloIdentity: { claimedRole: role } });
    await c.connect();
    await doHello(c, role === 'admin' ? ComponentRole.ADMIN : ComponentRole.MCP);
    await c.request('register_session', { sessionId: `${role}-${Date.now()}`, instanceId: `i-${role}`, processId: process.pid, projectId: 'p', cwd: '/', receiveMode: 'poll_only', capabilities: ['cli'], role: role === 'admin' ? ComponentRole.ADMIN : ComponentRole.MCP });
    return c;
  }

  it('admin can list dead letters (empty on a fresh broker) — safe-metadata shape', async () => {
    broker = await startBrokerHost({ dataDir: freshDir() });
    const c = await client(broker, 'admin');
    const r = await c.request('dead_letter', { action: 'list' });
    c.close();
    expect(r.frameType).toBe('dead_letter_ack');
    expect((r.payload as { records: unknown[] }).records).toEqual([]);
  });

  it('inspect of an unknown id returns null (not an error)', async () => {
    broker = await startBrokerHost({ dataDir: freshDir() });
    const c = await client(broker, 'admin');
    const r = await c.request('dead_letter', { action: 'inspect', messageId: 'nope' });
    c.close();
    expect(r.frameType).toBe('dead_letter_ack');
    expect((r.payload as { record: unknown }).record).toBeNull();
  });

  it('a non-admin (mcp) role is REFUSED the dead_letter op (fail closed)', async () => {
    broker = await startBrokerHost({ dataDir: freshDir() });
    const c = await client(broker, 'mcp');
    const r = await c.request('dead_letter', { action: 'list' });
    c.close();
    expect(r.frameType).toBe('error');
    expect((r.payload as { code: string }).code).toBe('XBUS_FORBIDDEN_ROLE');
  });
});
