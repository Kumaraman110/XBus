# ADR 0002 — Persistence via built-in `node:sqlite` (not better-sqlite3)

**Status:** Accepted · **Date:** 2026-06-25

## Context
The distribution design proposed `better-sqlite3`. It **fails to install** on this
machine: it is a native addon requiring `node-gyp` + a Visual Studio toolchain
(absent), and Node v25 has no prebuilt binary for it. Node v25 ships a built-in
SQLite (`node:sqlite`, `DatabaseSync`), **verified working** here: WAL mode,
prepared statements, parameterized queries.

## Decision
Use **`node:sqlite`** as the persistence engine, behind a thin `SqliteDriver`
seam (`src/database/connection.ts`) so the rest of the code depends on a small
interface (`exec`, `prepare(sql).run/get/all`, `transaction`), not the concrete
library. Swapping engines later is localized to the driver.

## Rationale
- **Forced:** `better-sqlite3` is unbuildable in this environment.
- **Strengthens offline-after-install (Section 20):** zero native modules → nothing
  to compile, no per-arch `.node` to ship; SQLite is inside the bundled Node runtime.
- **Same code shape:** `node:sqlite` is synchronous with a prepared-statement API
  very close to `better-sqlite3`, so broker logic is unchanged.

## Consequences / risks
- `node:sqlite` is **experimental** in Node (emits a runtime warning; API may shift
  across Node majors). Mitigated by: (1) the `SqliteDriver` seam; (2) pinning the
  bundled Node version in release artifacts so the API is fixed for a given XBus build;
  (3) a driver-level contract test asserting the SQL/dialect behavior we rely on.
- Requires running Node with `--experimental-sqlite` on versions where the flag is
  needed; the bundled runtime/launcher sets it. The warning is suppressed in the
  packaged launcher, not in dev.
- ADR is reversible: re-introducing `better-sqlite3` (on a host with a toolchain, or
  via prebuilt binaries) means implementing the same `SqliteDriver` interface.
