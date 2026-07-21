/**
 * BETA.10 WS1 — ownership-authority static guard. A 5-agent bypass audit (wf_50494ea9) confirmed
 * ZERO production direct-SQL bypasses of the identity-authority tables: every write routes through a
 * named WS1 primitive (setNameOwnershipActive, the single releaseNameOwnership, register reclaim/
 * self-heal, reapExpiredSessions GC, operatorRemoveRecord, nextEpochToken). This test PINS that
 * result so the boundary can't silently erode: the four DEDICATED authority tables may be written
 * (INSERT/UPDATE/DELETE) ONLY from the allow-listed files that host those primitives. A new file
 * that reaches into name_ownership / physical_session_map / session_epochs / fencing_counter with
 * raw SQL fails here — forcing the write back through a primitive (or an explicit, reviewed
 * allow-list addition + ADR update), exactly like the WS4 adapter-boundary guard.
 *
 * SCOPE NOTE (deliberate): this guards the four *dedicated* authority tables by name, where a
 * table-name match is unambiguous. It does NOT regex sessions.active_epoch / sessions.fencing_token
 * columns — those are covered by the epoch-fencing + ownership-atomicity suites, and a column-name
 * guard would false-positive on the legitimately-different deliveries.fencing_token per-delivery
 * lease column (delivery.ts). Table-scoped is the crisp, low-false-positive invariant.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'src');

/** The dedicated identity-authority tables (each has its own table; writes must be primitive-routed). */
const AUTHORITY_TABLES = ['name_ownership', 'physical_session_map', 'session_epochs', 'fencing_counter'];

/**
 * Files permitted to write these tables, each because it hosts a sanctioned WS1 primitive:
 *  - store.ts       — setNameOwnershipActive / releaseNameOwnership / register / operatorRemoveRecord / nextEpochToken
 *  - reaper.ts      — reapExpiredSessions expiry-GC (dormancy)
 *  - migrations.ts  — schema DDL + one-time backfill (test-or-migration-only, excluded from the primitive rule)
 * Adding a file here REQUIRES a reviewed reason + ADR note (see ADR 0033/0035).
 */
const ALLOWED_WRITERS = new Set([
  path.join('broker', 'store.ts'),
  path.join('broker', 'reaper.ts'),
  path.join('database', 'migrations.ts'),
]);

/** Strip line + block comments so a table name mentioned in prose never trips the guard. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** A DML write to `table`: INSERT [OR REPLACE|IGNORE] INTO t | UPDATE t | DELETE FROM t. NOT CREATE. */
function writeRegex(table: string): RegExp {
  return new RegExp(
    String.raw`(INSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+)?INTO\s+${table}\b` +
    String.raw`|UPDATE\s+${table}\b` +
    String.raw`|DELETE\s+FROM\s+${table}\b)`,
    'i',
  );
}

describe('WS1 ownership-authority guard — dedicated authority tables are primitive-routed only', () => {
  for (const table of AUTHORITY_TABLES) {
    it(`only allow-listed WS1-primitive files write ${table}`, () => {
      const re = writeRegex(table);
      const offenders: string[] = [];
      for (const f of tsFiles(SRC)) {
        const rel = path.relative(SRC, f);
        if (ALLOWED_WRITERS.has(rel)) continue;
        if (re.test(stripComments(fs.readFileSync(f, 'utf8')))) offenders.push(rel);
      }
      expect(
        offenders,
        `${table} written outside a WS1 primitive in: ${offenders.join(', ')} — route it through a ` +
        `store primitive or add a reviewed allow-list entry (+ ADR).`,
      ).toEqual([]);
    });
  }

  it('every allow-listed writer still exists (roster is not stale)', () => {
    for (const rel of ALLOWED_WRITERS) {
      expect(fs.existsSync(path.join(SRC, rel)), `allow-listed writer missing: ${rel}`).toBe(true);
    }
  });

  it('nextFencingToken dead code stays removed (only nextEpochToken bumps the fence)', () => {
    // The audit flagged private nextFencingToken() as a zero-caller footgun; it was removed.
    // If it (or any second live fencing_counter bumper) returns, this pins the regression.
    const store = fs.readFileSync(path.join(SRC, 'broker', 'store.ts'), 'utf8');
    expect(store.includes('nextFencingToken'), 'nextFencingToken was removed as dead code').toBe(false);
  });
});
