/**
 * SqliteDriver seam (ADR 0002). Wraps Node's built-in `node:sqlite` behind a
 * minimal interface so the engine choice is localized. Synchronous API.
 */
import { createRequire } from 'node:module';

// Load node:sqlite via createRequire so bundlers (Vite/Vitest) don't try to
// transform the built-in module. `DatabaseSync` is the synchronous SQLite API
// shipped with Node (ADR 0002).
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  transaction<T>(fn: () => T): T;
  pragma(stmt: string): unknown;
  close(): void;
  readonly filename: string;
}

export interface OpenOptions {
  /** Apply WAL + foreign_keys + busy_timeout on open. */
  applyPragmas?: boolean;
  busyTimeoutMs?: number;
  /**
   * Beta.5 Phase 1 (ADR 0020 Q5): open a PHYSICALLY read-only handle
   * (`DatabaseSync({ readOnly: true })`, landed node:sqlite 22.12/22.13 — the reason the
   * runtime floor is >=22.13). INSERT/UPDATE/DELETE/DDL and write-pragmas all throw
   * `ERR_SQLITE_ERROR` — there is no writer handle in this process, so the dashboard read
   * worker cannot mutate the DB (I4: broker stays the single writer). A read-only WAL
   * handle reads correct, current rows while the broker (writer) is live; it cannot
   * create/recover `-wal`/`-shm` or checkpoint, so write pragmas are SKIPPED here.
   */
  readOnly?: boolean;
}

/** Open (or create) a database with XBus's standard durability pragmas. */
export function openDatabase(filename: string, opts: OpenOptions = {}): SqliteDriver {
  // `readOnly` is supported by the node:sqlite RUNTIME (landed 22.12/22.13 — the reason the
  // floor is >=22.13) and is declared on @types/node's DatabaseSyncOptions, so it is passed
  // directly. Verified at runtime on Node 22.13+ and 24/25.
  const db = opts.readOnly === true
    ? new DatabaseSync(filename, { readOnly: true })
    : new DatabaseSync(filename);
  const busy = opts.busyTimeoutMs ?? 5000;

  // A read-only handle cannot run write pragmas (journal_mode/synchronous/foreign_keys
  // are writes on the DB) — attempting them throws. Skip ALL pragma writes; the writer
  // broker already established WAL. busy_timeout is a read-side setting but is redundant
  // for a single-reader worker, so we skip the whole block for readOnly to stay pure-read.
  if (opts.readOnly !== true && opts.applyPragmas !== false) {
    // Durability posture documented in docs/protocol.md. WAL for concurrent
    // readers + a single writer; synchronous=NORMAL is the standard WAL pairing
    // (loss window = last txn on OS crash, acceptable for a local message bus).
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`PRAGMA busy_timeout = ${busy};`);
  }

  let depth = 0;
  const driver: SqliteDriver = {
    filename,
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): PreparedStatement {
      const stmt = db.prepare(sql);
      return {
        run: (...p: unknown[]) => stmt.run(...(p as never[])) as { changes: number; lastInsertRowid: number | bigint },
        get: (...p: unknown[]) => stmt.get(...(p as never[])),
        all: (...p: unknown[]) => stmt.all(...(p as never[])),
      };
    },
    transaction<T>(fn: () => T): T {
      // Reentrancy via savepoints so nested transactions compose.
      if (depth > 0) {
        const sp = `sp_${depth}`;
        db.exec(`SAVEPOINT ${sp};`);
        depth += 1;
        try {
          const r = fn();
          db.exec(`RELEASE ${sp};`);
          depth -= 1;
          return r;
        } catch (e) {
          db.exec(`ROLLBACK TO ${sp};`);
          db.exec(`RELEASE ${sp};`);
          depth -= 1;
          throw e;
        }
      }
      db.exec('BEGIN IMMEDIATE;');
      depth = 1;
      try {
        const r = fn();
        db.exec('COMMIT;');
        depth = 0;
        return r;
      } catch (e) {
        db.exec('ROLLBACK;');
        depth = 0;
        throw e;
      }
    },
    pragma(stmt: string): unknown {
      return db.prepare(`PRAGMA ${stmt}`).get();
    },
    close(): void {
      db.close();
    },
  };
  return driver;
}
