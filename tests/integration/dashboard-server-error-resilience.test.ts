/**
 * BETA.10 — dashboard HTTP server post-listen 'error' resilience (Reliability harness finding).
 *
 * The dashboard http.Server registered its 'error' handler with .once() during start() and
 * REMOVED it on successful listen — so after start() the server had NO 'error' listener. A
 * post-listen server 'error' (a connection-level fault, which real clients churning connections
 * can trigger) is then an EventEmitter 'error' with no listener → Node throws it as an UNCAUGHT
 * exception → the whole broker process exits (code 1, no unhandled-rejection log). This is exactly
 * the crash the Reliability harness reproduced: held-open clients kill the standalone broker in
 * seconds; a client-free broker survives indefinitely.
 *
 * The IPC server (src/ipc/server.ts) already does the correct thing (a PERSISTENT post-listen
 * 'error' handler). This proves the dashboard server now matches: a post-listen server 'error' is
 * caught, not thrown, and the server keeps serving. RED before the fix (emitting 'error' throws,
 * crashing the test worker); GREEN after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { FakeClock } from '../../src/shared/clock.js';
import { DashboardServer } from '../../src/broker/dashboard/server.js';
import { DashboardAuth } from '../../src/broker/dashboard/auth.js';
import { InProcessReadExecutor, type ReadExecutor } from '../../src/broker/dashboard/read-worker.js';

let dir: string; let dbPath: string; let writer: SqliteDriver; let clock: FakeClock;
let auth: DashboardAuth; let reader: ReadExecutor; let server: DashboardServer;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-dasherr-'));
  dbPath = path.join(dir, 'x.sqlite');
  writer = openDatabase(dbPath, { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(writer, clock.nowIso());
  auth = new DashboardAuth(clock);
  reader = new InProcessReadExecutor(dbPath);
  server = new DashboardServer({ auth, reader });
  await server.start();
});
afterEach(async () => {
  await server.stop();
  try { writer.close(); } catch { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

/** Reach the underlying http.Server the way a lifecycle test must (no public accessor). */
function underlyingServer(s: DashboardServer): http.Server {
  return (s as unknown as { server: http.Server }).server;
}

describe('dashboard server — post-listen error resilience (broker must not crash on client churn)', () => {
  it('a post-listen server "error" event is HANDLED (not an uncaught throw that kills the broker)', () => {
    const srv = underlyingServer(server);
    // There MUST be at least one persistent 'error' listener after start() (the .once(reject)
    // used during listen is removed on success). Without one, emitting 'error' throws.
    expect(srv.listenerCount('error'), 'persistent post-listen error handler present').toBeGreaterThan(0);
    // Emitting a synthetic connection-level error must NOT throw (which in prod = process exit 1).
    expect(() => srv.emit('error', Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow();
  });

  it('a "clientError" (malformed request / socket fault) does not crash and the server keeps serving', async () => {
    const srv = underlyingServer(server);
    // A clientError with a live socket: the handler should close the socket cleanly, not throw.
    const fakeSocket = { destroyed: false, writable: true, end: () => {}, destroy: () => {} } as unknown as import('node:net').Socket;
    expect(() => srv.emit('clientError', new Error('bad request bytes'), fakeSocket)).not.toThrow();
    // The server still serves after the fault: an unauthenticated /api/health returns HTTP (401),
    // proving the event loop is alive and the listener still bound.
    const addr = srv.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    expect([200, 401]).toContain(res.status); // reachable — broker did not die
  });
});
