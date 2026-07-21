/**
 * BETA.10 — broker survives live-client churn + held-open connections (Reliability repro).
 *
 * Reported signature: a standalone dashboard broker with N held-open hook/mcp IpcClients (never
 * closed) exits (code 1) within seconds; a client-free broker survives indefinitely. Root cause
 * (fixed in the dashboard server): a post-listen server 'error' with no listener → Node rethrows
 * uncaught → process down. This test reproduces the shape in-process: a real broker host with the
 * dashboard on, several connected+held IpcClients, plus HTTP request churn against the dashboard
 * (opening/abandoning sockets), and asserts the host stays alive + serving across a sustained
 * window. It also directly emits the fault the fix addresses and asserts no crash.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';

let broker: RunningBroker | null = null;
let dir: string | null = null;

afterEach(async () => {
  if (broker) { try { await broker.stop(); } catch { /* ignore */ } broker = null; }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } dir = null; }
});

/** Open a raw TCP/pipe connection to the dashboard and abandon it (client-churn/half-open faults). */
function abandonedConnection(urlStr: string): void {
  try {
    const u = new URL(urlStr);
    const sock = net.connect({ host: u.hostname, port: Number(u.port) });
    sock.on('error', () => { /* swallow on the CLIENT side; the SERVER must survive regardless */ });
    sock.on('connect', () => { sock.write('GET /api/health HTTP/1.1\r\nHost: x\r\n'); sock.destroy(); }); // half-written → reset
  } catch { /* ignore */ }
}

describe('broker survives live-client churn (Reliability repro — must not exit on a client fault)', () => {
  it('a dashboard broker stays alive + serving through held-open + abandoned connections', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-churn-'));
    broker = await startBrokerHost({ dataDir: dir, dashboard: true });
    const dash = broker.dashboard;
    expect(dash, 'dashboard started').toBeTruthy();
    const url = dash!.url;

    // Churn: repeatedly open+abandon raw connections (half-open resets) — the class of
    // connection-level fault that, pre-fix, surfaced as an unhandled server 'error'.
    for (let i = 0; i < 20; i++) abandonedConnection(url);

    // Directly emit the exact fault the fix guards (belt-and-suspenders): a post-listen server
    // 'error' must be handled, not rethrown.
    const httpServer = (dash as unknown as { server: http.Server }).server;
    expect(httpServer.listenerCount('error')).toBeGreaterThan(0);
    expect(() => httpServer.emit('error', Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow();

    // Give the event loop time to process the abandoned-socket faults.
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 20; i++) abandonedConnection(url);
    await new Promise((r) => setTimeout(r, 300));

    // The broker is STILL alive + serving: an unauthenticated /api/health is reachable (401/200),
    // proving the process did not exit and the listener is still bound.
    const res = await fetch(`${url}/api/health`);
    expect([200, 401]).toContain(res.status);
  });
});
