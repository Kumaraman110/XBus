/**
 * Stale Unix-socket recovery (beta.4, ADR 0012 D7 — adversarial-review major).
 *
 * On POSIX the broker endpoint is a filesystem Unix socket (<dataDir>/broker.sock).
 * A HARD-KILLED broker never runs its graceful unlink, leaving the socket file on
 * disk; Node's net.Server.listen() then fails EADDRINUSE forever, silently wedging
 * auto-start. The IpcServer must detect a STALE (unreachable) socket on a failed
 * bind, unlink it, and retry — while NEVER unlinking a socket a live broker owns.
 *
 * POSIX-only: Windows named pipes are not filesystem paths and never go stale this way.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { IpcServer } from '../../src/ipc/server.js';

const itPosix = process.platform === 'win32' ? it.skip : it;
const dirs: string[] = [];
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-stale-sock-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

/** A minimal IpcServer with no-op frame/close handlers (we only test bind/listen). */
function makeServer(endpoint: string): IpcServer {
  return new IpcServer(endpoint, () => { /* no frames in this test */ }, () => { /* no-op */ });
}

describe('IpcServer stale-socket recovery (POSIX)', () => {
  itPosix('binds after unlinking a STALE socket file left by a hard-killed broker', async () => {
    const endpoint = path.join(tmp(), 'broker.sock');
    // Simulate the leftover: a regular file at the socket path with NO listener.
    fs.writeFileSync(endpoint, ''); // stale artifact (not a live socket)
    expect(fs.existsSync(endpoint)).toBe(true);
    const server = makeServer(endpoint);
    await expect(server.listen()).resolves.toBeUndefined(); // recovered (unlinked + bound)
    // It is now a real listening socket.
    const reachable = await new Promise<boolean>((resolve) => {
      const s = net.createConnection(endpoint);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    expect(reachable).toBe(true);
    await server.close();
  });

  itPosix('does NOT unlink a socket a LIVE server owns (refuses to steal it)', async () => {
    const endpoint = path.join(tmp(), 'broker.sock');
    const live = makeServer(endpoint);
    await live.listen(); // first server owns the socket
    // A second server trying the same endpoint must FAIL (not unlink the live one).
    const intruder = makeServer(endpoint);
    await expect(intruder.listen()).rejects.toThrow();
    // The live server is still reachable (its socket was not stolen).
    const reachable = await new Promise<boolean>((resolve) => {
      const s = net.createConnection(endpoint);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    expect(reachable).toBe(true);
    await live.close();
  });
});
