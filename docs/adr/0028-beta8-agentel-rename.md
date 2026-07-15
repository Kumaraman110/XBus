# ADR 0028 — beta.8: XBus → AgenTel rename (scope + compatibility)

**Status:** Proposed (beta.8)
**Brand:** **AgenTel** — "The communications network for AI agents."

## Principle

Rename everything **user-facing** to AgenTel; **preserve every identifier that a already-
installed beta.7 depends on** (wire tuple, on-disk layout, env vars, MCP tool names, DB
contents, root secret, ledger). The spec permits internal historical protocol identifiers to
remain XBus-prefixed where changing them creates compatibility risk. Data, SQLite, message/
thread history, config, auth, and the audit ledger MUST be preserved across the upgrade.

## Category A — RENAME (user-facing)

- Product name / brand in README, docs prose, `--help` text, dashboard title + brand mark,
  installer banners (`INSTALL.txt`, `install.ps1`), CONTRIBUTING/SECURITY prose.
- `package.json` `name`: `xbus` → `agentel` (npm package identity; new package, see Category D
  for the bin).
- CLI display strings, log prefixes shown to users (`[xbus]` → `[agentel]`) **only where they
  are cosmetic**, not where a test/tool greps them as a contract (audit those first).
- Repo name (GitHub) → AgenTel, **after regression acceptance**, preserving redirects/tags/
  releases/clone compat (GitHub auto-redirects renamed repos).
- ADR/docs going forward say AgenTel; historical ADRs keep their text (they are a record).

## Category B — PRESERVE EXACTLY (breaking to change)

- **Wire compatibility tuple** `xbus-p1-stp1-s<N>` and **`XBUS-STP`** secure-transport
  protocol name — on-wire identifiers negotiated in the handshake. Changing them breaks the
  handshake between an installed component and the broker. KEEP.
- **On-disk layout:** the data dir (`.xbus` / resolved data root), `xbus.sqlite` filename,
  root-secret file, `_xbusOwner` hook tag / `XBUS_OWNER_TAG`. Renaming stranded existing
  installs' data. KEEP (a migration that moved the data dir is out of scope and risky).
- **DB schema internals:** table/column names, `schema_migrations`, ledger event-type strings
  already written (`SESSION_RENAMED`, etc.). KEEP.
- **MCP tool names `xbus_*`** (`xbus_send`, `xbus_ack`, …) and the MCP server id `xbus`: these
  are the hook/MCP contract and the model-facing tool surface. Renaming them breaks the
  installed hook wiring and any session mid-flight. **KEEP `xbus_*` as the wire tool names in
  beta.8**; the brand rename does not require renaming the tool verbs. (Revisit as an additive
  alias in a later release if desired — out of scope here.)

## Category C — ENV VARS `XBUS_*`

Two sub-kinds:
1. **Error-code constants** (`XBUS_AUTH_FAILED`, `XBUS_SESSION_NAME_TAKEN`, …) — these are
   error-code STRINGS, part of the protocol error surface. KEEP (wire/contract).
2. **Configuration env vars** (`XBUS_DATA_DIR`, `XBUS_SESSION_NAME`, `XBUS_PLUGIN_DIR`,
   `XBUS_ALLOW_UNSUPPORTED_NODE`, …) — read from the environment. To honor "agentel as
   primary, xbus as deprecated alias for ≥2 releases": **accept `AGENTEL_*` as the primary
   name AND continue to read `XBUS_*` as a fallback** for each config var, preferring
   `AGENTEL_*` when both are set. Additive; no existing install breaks. (Implement as a small
   `readEnv(['AGENTEL_X','XBUS_X'])` helper.)

## Category D — CLI binaries / launcher

- `package.json` `bin`: add **`agentel`** → `./dist/cli/main.js` (primary) and **keep `xbus`**
  → same target (deprecated alias, ≥2 releases). Add **`agenclaude`**(or `agentel-claude`) as
  the primary launcher and **keep `xclaude`** as the deprecated alias.
- Deprecated aliases print a one-line stderr deprecation note on use, then behave identically.
- Since install is PATH-free (invoked via `node dist/cli/main.js`), the bin rename is mostly
  cosmetic for this preview, but the alias contract is honored.

## Category E — provenance / release assets

- `provenance.json`, release zip name, `package-release-zip.ts` / `package-win.ts` output
  names → AgenTel-branded, while the artifact SHA remains reproducible.
- `verify:release` content-scan denylist file `.xbus-scan-denylist.json` — internal tool
  config; may keep name (KEEP to avoid churn) or rename (cosmetic). Decide at implementation.

## Sequencing

1. Land the durable-identity fix (ADR 0027) + regression hardening FIRST.
2. Do the rename as a distinct, reviewable change (Category A + C-config-aliases + D).
3. Rename the GitHub repo LAST, only after regression acceptance.

## Verification

- Full test suite green after each category (many tests grep `[xbus]`/`xbus_*` — audit +
  update only the cosmetic ones; a test asserting a WIRE value must stay asserting it).
- `doctor` green; `verify:release` x2; artifact SHA reproducible; upgrade from beta.7 preserves
  schema-9→10 data.
- Deprecated `xbus`/`xclaude` aliases still function.
