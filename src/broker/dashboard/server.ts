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
import { fileURLToPath } from 'node:url';
import type { DashboardAuth } from './auth.js';
import { ReadOverloadedError, type ReadExecutor } from './read-worker.js';

/**
 * Resolve the packaged static UI dir (`<this-dir>/static`). Returns undefined if it isn't
 * present (e.g. running before the static assets were copied into dist) so the server falls
 * back to the inert built-in shell. Works from both dist (`.js`) and, in tests, source.
 */
export function defaultStaticDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'static'), path.join(here.replace(/([\\/])src\1/, '$1dist$1'), 'static')];
  for (const c of candidates) { try { if (fs.existsSync(path.join(c, 'index.html'))) return c; } catch { /* ignore */ } }
  return undefined;
}

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
  /** Max concurrent authenticated streams (blocker #5). Beyond it, /api/stream → 503. Default 64. */
  maxStreams?: number;
  /**
   * Beta.6 Phase 2 (ADR 0021): the operator console's WRITE callbacks. These run on the
   * broker loop (the single writer) — the dashboard's own DB handle is read-only, so a write
   * route CANNOT touch SQLite; it forwards the (already authenticated) payload here. Wired in
   * host.ts to the daemon's in-process operator methods, exactly like onChange. When absent
   * (headless API before the console ships, or a construction failure), the write routes
   * return 503 and the read-only dashboard is unaffected. A callback may throw a typed error
   * (mapped to a 4xx) or resolve a JSON result. The browser NEVER supplies a sender/actor —
   * identity is stamped server-side to 'local-operator'.
   */
  onOperatorSend?: (payload: unknown) => unknown;
  onMarkThreadRead?: (payload: unknown) => unknown;
  /** Beta.7 (ADR 0024): operator session-control callback (rename alias / pause-DND / pin /
   *  archive / remove-record / stop-managed). Payload carries {action, sessionId, ...}. */
  onOperatorControl?: (payload: unknown) => unknown;
  /** Beta.7 (ADR 0025): operator schedule callback (create / pause / resume / cancel). */
  onOperatorSchedule?: (payload: unknown) => unknown;
  /** Max operator-send request-body bytes (defense-in-depth over LIMITS.TEXT_BYTES). Default 96 KiB. */
  maxWriteBodyBytes?: number;
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
  private readonly maxStreams: number;
  private readonly onOperatorSend: ((payload: unknown) => unknown) | undefined;
  private readonly onMarkThreadRead: ((payload: unknown) => unknown) | undefined;
  private readonly onOperatorControl: ((payload: unknown) => unknown) | undefined;
  private readonly onOperatorSchedule: ((payload: unknown) => unknown) | undefined;
  private readonly maxWriteBodyBytes: number;
  private streams = new Set<http.ServerResponse>();

  constructor(opts: DashboardServerOptions) {
    this.auth = opts.auth;
    this.reader = opts.reader;
    // Default to the packaged static UI dir; if it isn't present the built-in inert shell
    // is served instead (so the API is reachable even before the assets are copied).
    this.staticDir = opts.staticDir ?? defaultStaticDir();
    this.host = opts.host ?? '127.0.0.1';
    this.wantPort = opts.port ?? 0;
    this.log = opts.log ?? (() => {});
    this.onChange = opts.onChange;
    this.maxStreams = opts.maxStreams ?? 64;
    this.onOperatorSend = opts.onOperatorSend;
    this.onMarkThreadRead = opts.onMarkThreadRead;
    this.onOperatorControl = opts.onOperatorControl;
    this.onOperatorSchedule = opts.onOperatorSchedule;
    this.maxWriteBodyBytes = opts.maxWriteBodyBytes ?? 96 * 1024;
  }

  /** Actual bound port (after start). */
  get port(): number {
    const a = this.server?.address() as AddressInfo | null;
    return a ? a.port : 0;
  }
  get url(): string { return `http://${this.host}:${this.port}`; }

  /**
   * PUBLIC controller entry (beta.5 blocker #3): mint a fresh one-time nonce and return the
   * browser-open URL with the nonce in the URL FRAGMENT (`…/#n=<nonce>`). The fragment is
   * never sent to the server / never logged / never in query params (ADR 0018 D2). This is
   * the ONLY supported way to obtain an open-URL — the nonce store stays encapsulated (auth
   * is private), so tests + the `xbus dashboard` CLI drive the SAME public path a user does,
   * never a private field. Callers must NOT log the returned URL (it carries a live nonce).
   */
  mintOpenUrl(): string {
    return `${this.url}/#n=${encodeURIComponent(this.auth.mintNonce())}`;
  }

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
        return this.handleExchange(req, res);
      }

      // Authenticated data API (every /api/* incl. reads, writes + the stream). The BEARER
      // TOKEN CHECK RUNS FIRST for every /api/* request regardless of method — a write route
      // never bypasses auth (ADR 0018/0021). AWAIT so a read/write rejection is caught here.
      if (p.startsWith('/api/')) {
        if (!this.auth.validateToken(bearer(req))) return this.json(res, 401, { error: 'unauthorized' });
        // Beta.6 write routes (POST): operator-send + mark-read. These forward to the broker
        // loop via the injected callbacks (the dashboard handle is read-only).
        if (method === 'POST') return await this.handleWrite(p, req, res);
        if (method !== 'GET' && method !== 'HEAD') return this.json(res, 405, { error: 'method_not_allowed' });
        return await this.handleApi(p, u, res);
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
      body += c.toString('utf8');
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

  /**
   * Read a bounded JSON request body. Resolves the parsed object, or null after having
   * ALREADY responded (413 too-large / 400 bad-JSON) — callers must check for null and stop.
   * Mirrors handleExchange's discipline: cap bytes, respond 413 once + req.pause (never
   * destroy the socket), 400 on parse failure. maxBytes defaults to the write-body cap.
   */
  private readJsonBody(req: http.IncomingMessage, res: http.ServerResponse, maxBytes: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let body = '';
      let done = false;
      const finish = (v: Record<string, unknown> | null): void => { if (!done) { done = true; resolve(v); } };
      req.on('data', (c: Buffer) => {
        if (done) return;
        body += c.toString('utf8');
        if (body.length > maxBytes) {
          // Respond 413 once. The request still has unread body bytes; on a keep-alive
          // connection those would wedge the socket and reset the NEXT request. Close the
          // connection cleanly (Connection: close) rather than pause-and-leak, so the client
          // sees a clean 413 and opens a fresh connection for its next request.
          if (!res.headersSent) {
            res.writeHead(413, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close' });
            res.end(JSON.stringify({ error: 'payload_too_large' }));
          }
          finish(null);
        }
      });
      req.on('end', () => {
        if (done) return;
        let parsed: unknown;
        try { parsed = JSON.parse(body || '{}'); } catch { this.json(res, 400, { error: 'bad_request' }); return finish(null); }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { this.json(res, 400, { error: 'bad_request' }); return finish(null); }
        finish(parsed as Record<string, unknown>);
      });
      req.on('error', () => { try { this.json(res, 400, { error: 'bad_request' }); } catch { /* ignore */ } finish(null); });
    });
  }

  /**
   * Beta.6 Phase 2 (ADR 0021): the operator console's WRITE routes. Auth already validated
   * by the caller (handle()). Routes:
   *   POST /api/thread                 — open a new thread + send its first operator turn
   *   POST /api/thread/:id/send        — send a follow-up operator turn in an existing thread
   *   POST /api/thread/:id/read        — mark the thread read up to a sequence
   * All forward to the injected broker-loop callback (the dashboard handle is read-only).
   * A missing callback → 503 (dashboard write path not wired). A callback throw is mapped to
   * a typed 4xx (validation/expiry) or 500, and NEVER crashes the broker (the callback runs a
   * transactional store op on the broker loop). The browser never supplies a sender/actor.
   */
  private async handleWrite(p: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Route match first (so an unknown POST path 404s without reading a body).
    const sendNew = p === '/api/thread';
    const sendFollow = /^\/api\/thread\/([^/]+)\/send$/.exec(p);
    const markRead = /^\/api\/thread\/([^/]+)\/read$/.exec(p);
    const control = /^\/api\/session\/([^/]+)\/control$/.exec(p); // beta.7 operator controls
    const scheduleNew = p === '/api/schedule';                    // beta.7 create schedule
    const scheduleState = /^\/api\/schedule\/([^/]+)\/state$/.exec(p); // pause/resume/cancel
    if (!sendNew && !sendFollow && !markRead && !control && !scheduleNew && !scheduleState) return this.json(res, 404, { error: 'not_found' });

    const body = await this.readJsonBody(req, res, this.maxWriteBodyBytes);
    if (body === null) return; // already responded (413/400)

    try {
      if (sendNew || sendFollow) {
        if (!this.onOperatorSend) return this.json(res, 503, { error: 'write_unavailable' });
        // For a follow-up, the thread id comes from the PATH (not a spoofable body field).
        const payload = sendFollow ? { ...body, threadId: decodeURIComponent(sendFollow[1]!) } : { ...body };
        // A NEW-thread POST must NOT carry a threadId (that is the follow-up route's job).
        if (sendNew && 'threadId' in payload) delete (payload as { threadId?: unknown }).threadId;
        const result = await this.onOperatorSend(payload);
        return this.json(res, 200, result);
      }
      if (control) {
        if (!this.onOperatorControl) return this.json(res, 503, { error: 'write_unavailable' });
        // The target sessionId comes from the PATH (not a spoofable body field); action + params from the body.
        const result = await this.onOperatorControl({ ...body, sessionId: decodeURIComponent(control[1]!) });
        return this.json(res, 200, result);
      }
      if (scheduleNew || scheduleState) {
        if (!this.onOperatorSchedule) return this.json(res, 503, { error: 'write_unavailable' });
        // Create: action defaults to 'create'. State-change: scheduleId + action from the PATH/body.
        const payload = scheduleState
          ? { ...body, scheduleId: decodeURIComponent(scheduleState[1]!) }
          : { action: 'create', ...body };
        const result = await this.onOperatorSchedule(payload);
        return this.json(res, 200, result);
      }
      // markRead
      if (!this.onMarkThreadRead) return this.json(res, 503, { error: 'write_unavailable' });
      const result = await this.onMarkThreadRead({ ...body, threadId: decodeURIComponent(markRead![1]!) });
      return this.json(res, 200, result);
    } catch (e) {
      // Map a typed XBusError to a clean 4xx; anything else to 500. Never leak a stack.
      const err = e as { code?: string; message?: string };
      const code = typeof err.code === 'string' ? err.code : undefined;
      const status = code && /VALIDATION|PROTOCOL|RESERVED|PAYLOAD|NOT_FOUND|UNKNOWN_RECIPIENT|EXPIRED|BLOCKED|ILLEGAL_STATE|FORBIDDEN|TAKEN|INVALID_SESSION/i.test(code) ? 400 : 500;
      this.log(`dashboard write failed: ${err.message ?? 'error'}`);
      return this.json(res, status, { error: code ?? 'internal', message: status === 400 ? (err.message ?? 'invalid request') : 'internal' });
    }
  }

  private async handleApi(p: string, u: URL, res: http.ServerResponse): Promise<void> {
    try {
      if (p === '/api/sessions') return this.json(res, 200, { sessions: await this.reader.run('sessions') });
      if (p === '/api/unmanaged') return this.json(res, 200, await this.reader.run('unmanagedBanner'));
      if (p === '/api/audit') return this.json(res, 200, await this.reader.run('auditStatus'));
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
      // Beta.6 (ADR 0021): operator thread projections (read-only, off-loop). List + detail.
      if (p === '/api/threads') {
        const limit = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : undefined;
        return this.json(res, 200, await this.reader.run('threads', { limit }));
      }
      const tm = /^\/api\/thread\/([^/]+)$/.exec(p);
      if (tm) {
        const limit = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : undefined;
        const t = await this.reader.run('thread', { threadId: decodeURIComponent(tm[1]!), limit });
        return t ? this.json(res, 200, t) : this.json(res, 404, { error: 'not_found' });
      }
      if (p === '/api/stream') return this.handleStream(res);
      return this.json(res, 404, { error: 'not_found' });
    } catch (e) {
      // A read timeout / worker crash / OVERLOAD → 503, loop unaffected (reads are off-loop).
      // Overload gets a distinct body + a Retry-After so a client can back off cleanly.
      this.log(`dashboard read failed: ${(e as Error).message}`);
      if (e instanceof ReadOverloadedError || (e as Error).name === 'ReadOverloadedError') {
        res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '1' });
        res.end(JSON.stringify({ error: 'overloaded' }));
        return;
      }
      return this.json(res, 503, { error: 'read_unavailable' });
    }
  }

  /**
   * Live-update stream via fetch-streaming (NOT EventSource — EventSource can't carry an
   * Authorization header; ADR 0018 D2). Newline-delimited JSON of already-committed state
   * snapshots. Authenticated (checked in handle()). Blocker #5 bounds:
   *  - the authenticated stream count is CAPPED (maxStreams); beyond it the request is
   *    refused 503 and NOT added to the set (a stream flood cannot grow it without limit);
   *  - a hung/slow client is dropped on socket close AND every resource (set entry, timer)
   *    is removed in cleanup;
   *  - a broadcast is ONE coalesced `sessions` read fanned out to all streams (broadcast()),
   *    not one read per stream, so N streams don't cause N reads per mutation.
   */
  private handleStream(res: http.ServerResponse): void {
    if (this.streams.size >= this.maxStreams) { this.json(res, 503, { error: 'too_many_streams' }); return; }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Transfer-Encoding': 'chunked' });
    this.streams.add(res);
    // Fallback heartbeat ONLY when no change-feed is wired: a bounded coalesced broadcast.
    const timer = this.onChange ? null : setInterval(() => this.broadcast(), 2000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    const cleanup = (): void => { this.streams.delete(res); if (timer) clearInterval(timer); };
    res.on('close', cleanup);
    res.on('error', cleanup);
    // Send this new stream an initial snapshot (its own reads; broadcasts thereafter are shared):
    // sessions (selector) + threads (list + unread) so the console populates immediately.
    void this.reader.run('sessions').then((sessions) => {
      if (!res.writableEnded) { try { res.write(JSON.stringify({ type: 'sessions', sessions }) + '\n'); } catch { /* dropped */ } }
    }).catch(() => { /* off-loop read failed; skip */ });
    void this.reader.run('threads').then((threads) => {
      if (threads && typeof threads === 'object' && !res.writableEnded) { try { res.write(JSON.stringify({ type: 'threads', ...(threads as Record<string, unknown>) }) + '\n'); } catch { /* dropped */ } }
    }).catch(() => { /* off-loop read failed; skip */ });
  }

  /**
   * Coalesced broadcast: do ONE `sessions` read and fan the SAME result out to every open
   * stream (blocker #5). If a broadcast is already in flight, mark pending + collapse — so a
   * burst of mutations yields at most one extra read, never one-per-stream-per-mutation. A
   * failed off-loop read simply skips this tick; delivery is unaffected.
   */
  private broadcasting = false;
  private broadcastPending = false;
  private broadcast(): void {
    if (this.streams.size === 0) return;
    if (this.broadcasting) { this.broadcastPending = true; return; }
    this.broadcasting = true;
    const done = (): void => {
      this.broadcasting = false;
      if (this.broadcastPending) { this.broadcastPending = false; this.broadcast(); }
    };
    // reader.run() can throw SYNCHRONOUSLY (a worker respawn failure inside ensure()), which
    // would escape BEFORE .finally attaches and leave `broadcasting` wedged true forever —
    // permanently disabling live updates. Wrap in try/catch so the flag is ALWAYS reset, then
    // coalesce via .finally on the async path. (D2 fix.)
    let p: Promise<unknown[]>;
    // Coalesced fan-out of BOTH a sessions snapshot (selector) AND a threads snapshot (list +
    // unread badges), so the console's session picker and thread list refresh live on any
    // mutation. Each is ONE off-loop read fanned to all streams (not per-stream). A failure in
    // either read simply skips that line this tick; delivery is unaffected.
    try { p = Promise.all([this.reader.run('sessions'), this.reader.run('threads').catch(() => null)]); }
    catch { done(); return; }
    void p.then(([sessions, threads]) => {
      const lines = [JSON.stringify({ type: 'sessions', sessions }) + '\n'];
      if (threads && typeof threads === 'object') lines.push(JSON.stringify({ type: 'threads', ...(threads as Record<string, unknown>) }) + '\n');
      const blob = lines.join('');
      for (const res of this.streams) { if (!res.writableEnded) { try { res.write(blob); } catch { /* per-stream write failure; cleanup on close */ } } }
    }).catch(() => { /* skip this tick */ }).finally(done);
  }

  /** Notify all open streams that state changed (broker calls this after a mutation) — one
   *  coalesced read fanned out to all streams. */
  notifyChange(): void { this.broadcast(); }

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
