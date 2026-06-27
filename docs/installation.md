# Installation

> **Developer Preview.** A real install modifies user-scope configuration. This
> page documents the full, reversible procedure and how to test it in an isolated
> profile **without** touching your real environment.

## Requirements

- **Node.js `>=22.5`** (XBus uses the `node:sqlite` built-in — no native addons,
  so no C/C++ toolchain, no `npm install` of compiled modules at runtime).
- Windows 10/11 (primary target). macOS/Linux are implemented but not yet
  runtime-validated.

## What an install changes

1. Places the XBus CLI (`xbus`) and launcher (`xclaude`) on your PATH.
2. Registers the XBus MCP server + checkpoint hook for Claude Code (user scope).
3. Creates the per-user data directory with restricted ACLs and a per-installation
   root secret. An **installed** instance uses `<install-root>/data`
   (default `~/.claude/xbus-install/data`); running from source (no install) uses
   `~/.claude/xbus`. Either is overridable with `XBUS_DATA_DIR`. All components
   (broker, `doctor`, the MCP server, the checkpoint hook, and `xclaude`) resolve
   the **same** canonical root, so they never disagree.

All three are **reversible** (see Uninstall). Nothing is written outside your user
scope; no machine-wide or registry changes.

## Isolated-profile test (no real changes)

Before touching your real profile, you can exercise the entire lifecycle against a
throwaway data directory:

```powershell
# point XBus at a temp profile — your real ~/.claude/xbus is untouched
$env:XBUS_DATA_DIR = "$env:TEMP\xbus-trial"
xbus start
xbus doctor
xbus stop
Remove-Item -Recurse -Force $env:TEMP\xbus-trial   # full uninstall of the trial
```

The clean-profile lifecycle (fresh install, upgrade, incompatible upgrade,
rollback, offline-after-install, uninstall) is automated and proven by the
artifact-first install suite in
[`tests/integration/artifact-first-install.test.ts`](../tests/integration/artifact-first-install.test.ts),
which builds the packaged artifact and exercises install / launch / hooks / MCP /
uninstall entirely from the artifact at a spaces-containing path.

## Build from source

```
git clone <repo>
cd XBus
npm install
npm run build
npm test            # optional: full suite
```

A self-contained, checksummed, SBOM'd package can be assembled with
`npm run package:win` (see [packaging.md](packaging.md)).

## Upgrade

Install the new build; on first start the broker applies any pending schema
migrations. An incompatible migration (checksum drift) or a database **newer**
than the build fails closed with an actionable message rather than risking
corruption.

After upgrading, `xbus doctor` reports the **exact** build identity (ADR 0011):
`buildId` (`xbus-<version>-<commit>`), `sourceCommit`, the installed-artifact
`installedArtifactManifestSha256`, and `mixedBuilds` — so you can confirm the broker
is running the build you just installed (restart the broker if `mixedBuilds` is
`true`). Two builds that share a protocol/schema tuple but differ in source are now
distinguishable, which they were not in earlier builds.

## Uninstall

1. `xbus stop`
2. Remove `xbus`/`xclaude` from PATH and the MCP/hook registration.
3. Delete the data directory (`~/.claude/xbus` or your `XBUS_DATA_DIR`).

After step 3 no XBus state remains; a later reinstall starts clean.

## Honest scope

This preview's automated work does **not** perform a real user-scope install,
PATH change, or shell-profile edit on the maintainer's machine — those steps are
gated behind explicit approval. The procedure above is the intended, tested-in-
isolation flow.
