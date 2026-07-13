/**
 * Off-loop READ WORKER (ADR 0020 Q5 #2). `node:sqlite` `DatabaseSync` is SYNCHRONOUS; an
 * in-process dashboard read (e.g. a large `/api/ledger` scan) would run ON the broker's
 * event loop and stall delivery — request timeouts don't help (they bound a slow socket,
 * not a slow query). So the dashboard's DB reads run in a SEPARATE `worker_thread` with
 * its own PHYSICALLY read-only connection; the broker loop only does a cheap
 * message-passing handoff.
 *
 * This file is BOTH the worker entry (when run as a worker_thread) AND exports the
 * `ReadExecutor` seam + a `WorkerReadExecutor` the server uses. Tests can substitute an
 * `InProcessReadExecutor` to exercise the read model directly without a thread.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { openDatabase } from '../../database/connection.js';
import { DashboardReadModel } from './read-model.js';

/**
 * Resolve the worker ENTRY file. A Node `Worker` needs an executable JS file. In a packaged
 * install this module is already `dist/broker/dashboard/read-worker.js`, so `import.meta.url`
 * is correct. Under vitest the module runs from `src/.../read-worker.ts`, which a Worker
 * can't execute — map `/src/`→`/dist/` + `.ts`→`.js` and use the compiled file if present.
 */
export function workerEntryPath(): string {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.js')) return here;
  const compiled = here.replace(/([\\/])src\1/, '$1dist$1').replace(/\.ts$/, '.js');
  if (fs.existsSync(compiled)) return compiled;
  return here; // last resort (a loader-enabled runtime); tests that need the worker build dist first
}

/** A read request the server sends to the worker. `method` names a DashboardReadModel op. */
export interface ReadRequest { id: number; method: 'sessions' | 'session' | 'ledger' | 'unmanagedBanner' | 'auditStatus'; args?: unknown; }
export interface ReadResponse { id: number; ok: boolean; result?: unknown; error?: string; }

/** The seam the HTTP server depends on — a bounded, cancelable read call. */
export interface ReadExecutor {
  run(method: ReadRequest['method'], args?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** Dispatch one read against the read model (shared by worker + in-process executor). */
export function dispatchRead(model: DashboardReadModel, method: ReadRequest['method'], args: unknown): unknown {
  switch (method) {
    case 'sessions': return model.sessions();
    case 'session': return model.session(String((args as { sessionId?: string })?.sessionId ?? ''));
    case 'ledger': return model.ledger((args as { beforeSeq?: number; limit?: number }) ?? {});
    case 'unmanagedBanner': return model.unmanagedBanner();
    case 'auditStatus': return model.auditStatus();
    default: throw new Error(`unknown read method ${String(method)}`);
  }
}

/**
 * In-process executor (tests / fallback). Opens its OWN read-only handle so the
 * write-rejection guarantee is identical to the worker; runs synchronously but wrapped in
 * a resolved promise. NOT used on the broker loop in production (the worker is), but proves
 * the read-model contract in isolation.
 */
export class InProcessReadExecutor implements ReadExecutor {
  private readonly db: ReturnType<typeof openDatabase>;
  private readonly model: DashboardReadModel;
  constructor(dbPath: string) {
    this.db = openDatabase(dbPath, { readOnly: true });
    this.model = new DashboardReadModel(this.db);
  }
  run(method: ReadRequest['method'], args?: unknown): Promise<unknown> {
    return Promise.resolve(dispatchRead(this.model, method, args));
  }
  close(): Promise<void> { try { this.db.close(); } catch { /* ignore */ } return Promise.resolve(); }
}

/**
 * Worker-thread executor: spawns read-worker.js as a worker with a read-only handle,
 * correlates requests by id, and bounds each read with a timeout so a hung/pathological
 * read can NEVER block the caller (the broker loop). A timed-out or crashed worker is
 * surfaced as a rejected promise; the server maps it to a 503 and the loop is unaffected.
 */
/** Thrown when the bounded in-flight queue is full — the server maps it to a clean 503. */
export class ReadOverloadedError extends Error {
  constructor() { super('read worker overloaded'); this.name = 'ReadOverloadedError'; }
}

interface PendingCall { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; generation: number; }

/** Minimal worker surface WorkerReadExecutor depends on — lets tests inject a fake worker
 *  (to drive message/error/exit/timeout deterministically) without spawning a real thread. */
export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: 'message', cb: (m: ReadResponse) => void): void;
  on(event: 'error', cb: (e: Error) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
  terminate(): Promise<number> | void;
}

export interface WorkerReadExecutorOpts {
  requestTimeoutMs?: number;
  /** Max concurrent in-flight reads before run() rejects with ReadOverloadedError → 503. */
  maxInFlight?: number;
  /** Injectable worker factory (tests). Default: spawn the real read-worker thread. */
  spawnWorker?: (dbPath: string) => WorkerLike;
}

/**
 * Worker-thread read executor with the beta.5 reliability bounds (blocker #5):
 *  - GENERATION-tagged: every worker spawn increments `generation`; a pending call records
 *    the generation it was issued on, and message/error/exit handlers close over the SPECIFIC
 *    generation `g`. A stale worker's late `error`/`exit` can only fail calls from ITS OWN
 *    generation — it can never reject a fresh worker's in-flight calls.
 *  - TIMEOUT terminates + replaces: on a per-read timeout we terminate the wedged worker (its
 *    generation's pending calls all reject) and drop it, so a pathological query cannot pin the
 *    thread for later reads — the next run() spawns a clean worker.
 *  - BOUNDED in-flight: at most `maxInFlight` concurrent reads; beyond that run() rejects with
 *    ReadOverloadedError (503 backpressure), so a flood cannot grow `pending` without limit.
 */
export class WorkerReadExecutor implements ReadExecutor {
  private worker: WorkerLike | null = null;
  private generation = 0;              // increments on every spawn; tags calls + handlers
  private seq = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly spawnWorker: (dbPath: string) => WorkerLike;
  private closed = false;

  constructor(private readonly dbPath: string, opts: WorkerReadExecutorOpts = {}) {
    this.timeoutMs = opts.requestTimeoutMs ?? 5000;
    this.maxInFlight = opts.maxInFlight ?? 64;
    this.spawnWorker = opts.spawnWorker ?? ((dbPath) => new Worker(workerEntryPath(), { workerData: { dbPath } }));
  }

  private ensure(): { worker: WorkerLike; generation: number } {
    if (this.worker) return { worker: this.worker, generation: this.generation };
    const g = ++this.generation;
    const w = this.spawnWorker(this.dbPath);
    // Handlers close over THIS generation `g`. They no-op once the executor has moved past g
    // (a newer worker spawned), so an old worker's late event can never touch newer calls.
    w.on('message', (m: ReadResponse) => {
      if (g !== this.generation) return;          // stale worker's message — ignore
      const p = this.pending.get(m.id);
      if (!p || p.generation !== g) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error ?? 'read failed'));
    });
    const fail = (reason: string) => {
      if (g !== this.generation) return;          // an OLD worker's late error/exit — ignore
      // Reject only THIS generation's calls, drop the worker so the next run() self-heals.
      for (const [id, p] of this.pending) { if (p.generation === g) { clearTimeout(p.timer); this.pending.delete(id); p.reject(new Error(reason)); } }
      this.worker = null;
    };
    w.on('error', () => fail('read worker crashed'));
    w.on('exit', (code) => { if (code !== 0) fail(`read worker exited ${code}`); });
    this.worker = w;
    return { worker: w, generation: g };
  }

  /** Terminate the current worker (e.g. after a timeout wedged it) and drop it so the next
   *  run() spawns a clean one. Bumps the generation so the dying worker's events are ignored. */
  private replaceWorker(reason: string): void {
    const dying = this.worker;
    this.worker = null;
    this.generation++;                            // invalidate the dying worker's handlers
    for (const [id, p] of this.pending) { clearTimeout(p.timer); this.pending.delete(id); p.reject(new Error(reason)); }
    if (dying) { try { void Promise.resolve(dying.terminate()).catch(() => { /* ignore */ }); } catch { /* ignore */ } }
  }

  run(method: ReadRequest['method'], args?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('read executor closed'));
    // Bounded in-flight: shed load with a typed error the server maps to 503 backpressure.
    if (this.pending.size >= this.maxInFlight) return Promise.reject(new ReadOverloadedError());
    const { worker, generation } = this.ensure();
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Timeout: the worker may be WEDGED on a pathological query — terminate + replace it
        // so it can't pin the thread for subsequent reads. replaceWorker rejects this call.
        if (this.pending.has(id)) this.replaceWorker('read timed out');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, generation });
      try { worker.postMessage({ id, method, args } satisfies ReadRequest); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  /** Diagnostics: current in-flight count. */
  inFlight(): number { return this.pending.size; }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('closing')); }
    this.pending.clear();
    const w = this.worker; this.worker = null; this.generation++;
    if (w) { try { await w.terminate(); } catch { /* ignore */ } }
  }
}

// ---- Worker entry: runs only when loaded as a worker_thread ----
if (!isMainThread && parentPort) {
  const { dbPath } = workerData as { dbPath: string };
  let model: DashboardReadModel | null = null;
  try {
    const db = openDatabase(dbPath, { readOnly: true });
    model = new DashboardReadModel(db);
  } catch (e) {
    // A failed read-only open (e.g. Node too old — but the floor is 22.13) must not hang
    // callers: answer every request with an error rather than silently dropping it.
    parentPort.on('message', (m: ReadRequest) => parentPort!.postMessage({ id: m.id, ok: false, error: `read-only open failed: ${(e as Error).message}` } satisfies ReadResponse));
  }
  if (model) {
    const m = model;
    parentPort.on('message', (req: ReadRequest) => {
      try {
        const result = dispatchRead(m, req.method, req.args);
        parentPort!.postMessage({ id: req.id, ok: true, result } satisfies ReadResponse);
      } catch (e) {
        parentPort!.postMessage({ id: req.id, ok: false, error: (e as Error).message } satisfies ReadResponse);
      }
    });
  }
}
