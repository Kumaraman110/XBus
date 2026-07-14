# ADR 0022 — Beta.7: XBus-owned bundled Node runtime (remove Node friction)

**Status:** Accepted for Phase-3 build · **Date:** 2026-07-14 · beta.7 · builds on
ADR 0002 (node:sqlite persistence), ADR 0011 (build identity / provenance), ADR 0019
(migration + fail-closed compatibility).

## Context

Through beta.6 every XBus entry point resolved Node from the ambient system: the user-scope
MCP server + hooks were registered with `command = process.execPath` (whatever Node ran the
installer), the CLI is run as `node dist/cli/main.js`, and the artifact shipped **no** runtime
binary — only a pinned `engines` RANGE (`>=22.13 <25`). This is real friction: a user must
install a supported Node, keep it on PATH, and not upgrade past the validated ceiling. The
just-observed failure (a user ran a stale beta.5 extract's CLI against a beta.6 broker) is a
symptom of the same class — the runtime and its resolution are the user's problem, not XBus's.

The Node floor is load-bearing: `DatabaseSync({ readOnly: true })` (the read-only dashboard
worker, ADR 0020) needs Node 22.12/22.13; Node 25 is not yet validated. So the runtime must be
within `[22.13, 25)`.

## Decision

1. **Ship an XBus-owned Node runtime inside the Windows artifact at `runtime/node.exe`.** The
   builder supplies a *vetted* `node.exe` via the `XBUS_BUNDLED_NODE` env var; the packager
   asserts the **pinned** version (`BUNDLED_NODE_VERSION = 22.23.1`, in `src/shared/bundled-runtime.ts`)
   satisfies the floor and — when a SHA is pinned (`BUNDLED_NODE_SHA256`) — that the supplied
   bytes match, then copies it into `runtime/node.exe`. The binary is **not committed to git**
   (it would bloat the repo); it is fetched/vetted out-of-band and its upstream SHA-256 is
   recorded here for supply-chain integrity: `f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed`
   (node-v22.23.1 win-x64).

2. **`node.exe` is an interpreter, not a build tool or a to-be-compiled native addon.** The
   toolchain-free contract (`assertNoBuildToolchain`) rejects `.node` addons + `binding.gyp` +
   dev tooling; `node.exe` (a `.exe`) passes as-is and `runtime.json.buildToolchainRequiredAtRuntime`
   stays `false`. The distinction is explicit: XBus ships the RUNTIME it runs on, never a
   compiler or a to-be-built module. The rule is NOT loosened for anything except this one
   vetted interpreter binary.

3. **Every installed entry point uses the bundled runtime; installed XBus ignores system
   Node/PATH.** `install` copies `runtime/` into the installed plugin dir (added to `PAYLOAD`,
   tracked in the manifest for clean uninstall) and writes the user-scope MCP server + hook
   `command` as the **bundled** `<pluginDir>/runtime/node.exe` (precedence: explicit
   `opts.nodePath` → bundled runtime if present → `process.execPath` for a dev/source install).
   Because Claude launches the MCP server + hooks with the bundled node, `process.execPath` in
   those processes IS the bundled runtime, and the broker/reaper auto-spawn
   (`spawnDetachedBroker`, which uses `process.execPath`) inherits it **transitively with no
   code change**. `repair` re-points at the bundled runtime too.

4. **Atomic upgrade + data preservation reuse the existing machinery — no new mechanism.**
   Because `runtime/node.exe` lives INSIDE the plugin dir, the existing install path (stage to a
   temp dir → atomic rename onto `pluginDir`, backing up the prior dir) upgrades the runtime
   atomically, and the DB-snapshot-on-schema-increase + restore-first-on-failure path preserves
   data if the health check (which starts a broker under the NEW runtime) fails. A runtime-only
   bump (no schema change) skips the DB snapshot (nothing to protect) but still rides the atomic
   plugin swap; a health-check failure rolls the whole plugin dir (incl. the runtime) back.

5. **doctor + provenance report the runtime.** `provenance.json` + `runtime.json` carry a
   deterministic `bundledNodeVersion` (the pinned constant, NEVER the builder's
   `process.version` — that would break artifact reproducibility). `doctor` adds a `node_runtime`
   check: the bundled binary exists, its probed `--version` is in-range, and the user-scope
   config `command` points AT it (so a leaked fallback to system Node is caught).

6. **The floor guard stays.** `assertSupportedNode` still runs at CLI/launcher entry, so a
   mis-wired fallback to a stale system Node still fails closed with an actionable message.

## Scope / honesty

- **Windows-only** for beta.7 (`node.exe`). POSIX bundling (different binary, `+x` bit, the
  symlink-rejecting zipper) is out of scope; a POSIX/source install keeps using the ambient,
  floor-checked Node (the `node_runtime` doctor check reports this honestly as "no bundled
  runtime — dev/source or non-Windows install", `ok: true`).
- The shipped `.mcp.json` / `hooks/hooks.json` **templates** keep the bare `node` token for the
  advanced `--plugin-dir`-only path (cross-platform, dev/source). The "ignore system Node"
  guarantee is enforced on the **real install path** — user-scope registration writes the
  bundled runtime `command` — which is exactly what the acceptance test exercises. A future ADR
  may pin the templates once POSIX bundling exists.
- Reproducibility: the fixed binary + STORE zip keep the release archive byte-identical across
  builds (verified: two builds → identical SHA `24cf3c8c…`; the ~2.4MB artifact grows to ~89MB,
  which is the runtime, by design).
- Supply chain / AV: an unsigned bundled `node.exe` extracted from a zip may be flagged by
  SmartScreen/AV on some hosts; the pinned upstream SHA + the whole-tree SHA256SUMS fix the
  bytes end-to-end. Code-signing is a future hardening, not a beta.7 blocker.

## Consequences

- Positive: zero Node friction for a Windows user; installed XBus is self-contained and
  version-locked to a vetted runtime; upgrade/rollback are free (existing machinery); the
  guarantee is doctor-verifiable.
- Negative / accepted: +87MB artifact; each upgrade duplicates the runtime into a plugin backup
  until uninstall cleans it; Windows-only for now; the binary is builder-supplied (not in git).
- Irreversible bits: the `runtime/node.exe` layout + the `bundledNodeVersion` provenance field
  ship in the frozen artifact contract; chosen for atomic-swap reuse + determinism + a
  doctor-checkable guarantee.
