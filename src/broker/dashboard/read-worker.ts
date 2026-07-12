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
export interface ReadRequest { id: number; method: 'sessions' | 'session' | 'ledger' | 'unmanagedBanner'; args?: unknown; }
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
export class WorkerReadExecutor implements ReadExecutor {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private crashed: Error | null = null;

  constructor(private readonly dbPath: string, private readonly opts: { requestTimeoutMs?: number } = {}) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(workerEntryPath(), { workerData: { dbPath: this.dbPath } });
    w.on('message', (m: ReadResponse) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error ?? 'read failed'));
    });
    const fail = (e: Error) => {
      this.crashed = e;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('read worker crashed')); }
      this.pending.clear();
      this.worker = null; // allow a fresh spawn on the next call (self-heal)
    };
    w.on('error', fail);
    w.on('exit', (code) => { if (code !== 0) fail(new Error(`read worker exited ${code}`)); });
    this.worker = w;
    return w;
  }

  run(method: ReadRequest['method'], args?: unknown): Promise<unknown> {
    const w = this.ensure();
    const id = ++this.seq;
    const timeoutMs = this.opts.requestTimeoutMs ?? 5000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('read timed out'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { w.postMessage({ id, method, args } satisfies ReadRequest); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('closing')); }
    this.pending.clear();
    const w = this.worker; this.worker = null;
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
