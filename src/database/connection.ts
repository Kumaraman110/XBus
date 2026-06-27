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
}

/** Open (or create) a database with XBus's standard durability pragmas. */
export function openDatabase(filename: string, opts: OpenOptions = {}): SqliteDriver {
  const db = new DatabaseSync(filename);
  const busy = opts.busyTimeoutMs ?? 5000;

  if (opts.applyPragmas !== false) {
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
