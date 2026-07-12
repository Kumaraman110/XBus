/**
 * Dashboard HTTP server (ADR 0015/0018/0020 Q5). BROKER-OWNED singleton HTTP surface.
 *
 * Security by CONSTRUCTION (not policy), each asserted by a test:
 *  - binds `127.0.0.1` ONLY; a non-loopback host is refused at listen() (assertion).
 *  - strict CSP + nosniff + DENY frame + no-referrer on every response; no inline JS/CSS.
 *  - routes: reads `GET /api/sessions|/api/session/:id|/api/ledger|/api/stream`, `/alive`,
 *    static assets, and the ONE mutating route `POST /auth/exchange` (nonce→token, touches
 *    only the ephemeral auth store — NO product state). Any other method/path → 404/405.
 *  - EVERY `/api/*` request (incl. GET reads + the stream) requires a valid bearer tab
 *    token → else 401. Static assets + `/auth/exchange` + `/alive` are unauthenticated
 *    (inert code / the exchange authenticates by consuming the one-time nonce).
 *  - DB reads run OFF the broker loop via a ReadExecutor (worker_thread) with a per-read
 *    timeout, so a pathological scan / hung client cannot stall delivery.
 *  - the nonce lives only in the URL fragment; the token only in an Authorization header;
 *    neither is ever logged or written to the ledger.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { DashboardAuth } from './auth.js';
import type { ReadExecutor } from './read-worker.js';

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export interface DashboardServerOptions {
  auth: DashboardAuth;
  reader: ReadExecutor;
  /** Directory of inert static assets (no secrets, no session data). Optional: if absent,
   *  a minimal built-in index is served so the headless API is usable before the UI ships. */
  staticDir?: string;
  /** Bind host — MUST be loopback; anything else is refused (ADR 0018 D1). Default 127.0.0.1. */
  host?: string;
  /** Bind port. 0 = ephemeral (tests). */
  port?: number;
  log?: (line: string) => void;
  /** How the live stream learns of changes: a subscribe fn returning an unsubscribe. If
   *  absent, the stream sends periodic snapshots via the reader (still off-loop). */
  onChange?: (cb: () => void) => () => void;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : undefined;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly auth: DashboardAuth;
  private readonly reader: ReadExecutor;
  private readonly staticDir: string | undefined;
  private readonly host: string;
  private readonly wantPort: number;
  private readonly log: (line: string) => void;
  private readonly onChange: ((cb: () => void) => () => void) | undefined;
  private streams = new Set<http.ServerResponse>();

  constructor(opts: DashboardServerOptions) {
    this.auth = opts.auth;
    this.reader = opts.reader;
    this.staticDir = opts.staticDir;
    this.host = opts.host ?? '127.0.0.1';
    this.wantPort = opts.port ?? 0;
    this.log = opts.log ?? (() => {});
    this.onChange = opts.onChange;
  }

  /** Actual bound port (after start). */
  get port(): number {
    const a = this.server?.address() as AddressInfo | null;
    return a ? a.port : 0;
  }
  get url(): string { return `http://${this.host}:${this.port}`; }

  async start(): Promise<void> {
    // ADR 0018 D1: refuse a non-loopback bind BEFORE listening (fail closed).
    if (!isLoopback(this.host)) throw new Error(`dashboard refuses non-loopback bind: ${this.host}`);
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.wantPort, this.host, () => { this.server!.removeListener('error', reject); resolve(); });
    });
    this.log(`dashboard listening on ${this.url}`);
  }

  async stop(): Promise<void> {
    for (const r of this.streams) { try { r.end(); } catch { /* ignore */ } }
    this.streams.clear();
    await new Promise<void>((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); this.server = null; });
    await this.reader.close();
  }

  private send(res: http.ServerResponse, status: number, contentType: string, body: string | Buffer): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType });
    res.end(body);
  }
  private json(res: http.ServerResponse, status: number, obj: unknown): void {
    this.send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const u = new URL(req.url ?? '/', this.url);
      const p = u.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      if (p === '/alive') return this.json(res, 200, { ok: true });

      // The ONE mutating route — nonce→token exchange (writer side; ephemeral store only).
      if (p === '/auth/exchange') {
        if (method !== 'POST') return this.json(res, 405, { error: 'method_not_allowed' });
        return void this.handleExchange(req, res);
      }

      // Authenticated data API (every /api/* incl. reads + the stream).
      if (p.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') return this.json(res, 405, { error: 'method_not_allowed' });
        if (!this.auth.validateToken(bearer(req))) return this.json(res, 401, { error: 'unauthorized' });
        return void this.handleApi(p, u, res);
      }

      // Static assets — inert, unauthenticated (no secrets, no session data).
      if (method === 'GET' || method === 'HEAD') return this.serveStatic(p, res);
      return this.json(res, 405, { error: 'method_not_allowed' });
    } catch (e) {
      // Never leak a raw stack/500 body (the beta.5 lesson).
      this.log(`dashboard request error: ${(e as Error).message}`);
      try { this.json(res, 500, { error: 'internal' }); } catch { /* ignore */ }
    }
  }

  private handleExchange(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    let responded = false;
    const done = (status: number, obj: unknown): void => { if (responded) return; responded = true; this.json(res, status, obj); };
    req.on('data', (c: Buffer) => {
      if (responded) return;
      body += c;
      // Bound the body: respond 413 ONCE and stop accumulating (do NOT destroy the socket —
      // that would surface to the client as a connection error instead of a clean 413). We
      // pause the request so we stop buffering further bytes; the response has been sent.
      if (body.length > 4096) { done(413, { error: 'payload_too_large' }); req.pause(); }
    });
    req.on('end', () => {
      if (responded) return;
      let nonce: string | undefined;
      try { nonce = (JSON.parse(body || '{}') as { nonce?: string }).nonce; } catch { return done(400, { error: 'bad_request' }); }
      const issued = this.auth.exchange(typeof nonce === 'string' ? nonce : '');
      if (!issued) return done(401, { error: 'invalid_or_used_nonce' });
      // Token returned ONLY in the JSON body (never a Set-Cookie, never the URL).
      done(200, { token: issued.token, expiresAt: new Date(issued.expiresAt).toISOString() });
    });
    req.on('error', () => { try { done(400, { error: 'bad_request' }); } catch { /* ignore */ } });
  }

  private async handleApi(p: string, u: URL, res: http.ServerResponse): Promise<void> {
    try {
      if (p === '/api/sessions') return this.json(res, 200, { sessions: await this.reader.run('sessions') });
      if (p === '/api/unmanaged') return this.json(res, 200, await this.reader.run('unmanagedBanner'));
      if (p === '/api/ledger') {
        const beforeSeq = u.searchParams.has('beforeSeq') ? Number(u.searchParams.get('beforeSeq')) : undefined;
        const limit = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : undefined;
        return this.json(res, 200, await this.reader.run('ledger', { beforeSeq, limit }));
      }
      const sm = /^\/api\/session\/([^/]+)$/.exec(p);
      if (sm) {
        const s = await this.reader.run('session', { sessionId: decodeURIComponent(sm[1]!) });
        return s ? this.json(res, 200, s) : this.json(res, 404, { error: 'not_found' });
      }
      if (p === '/api/stream') return this.handleStream(res);
      return this.json(res, 404, { error: 'not_found' });
    } catch (e) {
      // A read timeout / worker crash → 503, loop unaffected (the read ran off-loop).
      this.log(`dashboard read failed: ${(e as Error).message}`);
      return this.json(res, 503, { error: 'read_unavailable' });
    }
  }

  /**
   * Live-update stream via fetch-streaming (NOT EventSource — EventSource can't carry an
   * Authorization header; ADR 0018 D2). Newline-delimited JSON of already-committed state
   * snapshots. Authenticated (checked in handle()). A hung/slow client is simply dropped on
   * socket close; nothing here runs a synchronous query on the broker loop (reads are
   * off-loop via the reader).
   */
  private handleStream(res: http.ServerResponse): void {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Transfer-Encoding': 'chunked' });
    this.streams.add(res);
    const push = () => {
      void this.reader.run('sessions').then((sessions) => {
        if (res.writableEnded) return;
        try { res.write(JSON.stringify({ type: 'sessions', sessions }) + '\n'); } catch { /* dropped below */ }
      }).catch(() => { /* off-loop read failed; skip this tick */ });
    };
    push(); // initial snapshot
    const unsub = this.onChange ? this.onChange(push) : null;
    // Fallback heartbeat if no change-feed wired: a bounded periodic snapshot (unref'd).
    const timer = this.onChange ? null : setInterval(push, 2000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    const cleanup = (): void => { this.streams.delete(res); if (unsub) unsub(); if (timer) clearInterval(timer); };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  /** Notify all open streams that state changed (broker calls this after a mutation). */
  notifyChange(): void {
    for (const res of this.streams) {
      void this.reader.run('sessions').then((sessions) => {
        if (!res.writableEnded) { try { res.write(JSON.stringify({ type: 'sessions', sessions }) + '\n'); } catch { /* ignore */ } }
      }).catch(() => { /* ignore */ });
    }
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    if (!this.staticDir) {
      // Minimal built-in shell so the headless API is reachable before the vanilla UI ships.
      if (pathname === '/' || pathname === '/index.html') {
        return this.send(res, 200, 'text/html; charset=utf-8', BUILTIN_INDEX_HTML);
      }
      return this.json(res, 404, { error: 'not_found' });
    }
    // Path traversal defense (ADR 0018 D4): canonicalize + prefix-check under staticDir.
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(this.staticDir, rel);
    const root = path.resolve(this.staticDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return this.json(res, 403, { error: 'forbidden' });
    fs.readFile(resolved, (err, buf) => {
      if (err) return this.json(res, 404, { error: 'not_found' });
      const ext = path.extname(resolved).toLowerCase();
      this.send(res, 200, STATIC_CONTENT_TYPES[ext] ?? 'application/octet-stream', buf);
    });
  }
}

/** Inert placeholder shell (no secrets, no session data). Real UI ships in the UI slice. */
const BUILTIN_INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>XBus</title></head><body><p>XBus control plane. Open via <code>xbus dashboard</code>.</p></body></html>`;
