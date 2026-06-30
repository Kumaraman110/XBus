# Installation

> **Developer Preview.** A real install copies the XBus plugin to a user-scope
> install root and registers the MCP server + checkpoint hook for Claude Code. It
> **does NOT modify PATH, the registry, or any shell profile.** This page documents
> the actual, reversible procedure and how to test it in isolation.

## Requirements

- **Node.js `>=22.5` and `<25`.** XBus uses the `node:sqlite` built-in (no native
  addons, no C/C++ toolchain). **Node 25+ is not yet supported** — it has not passed
  the clean-machine acceptance suite; the CLI prints an actionable error on an
  unsupported Node. Use **Node 22 LTS** or **Node 24**.
- Windows 10/11 (primary target). macOS/Linux are implemented but not yet
  runtime-validated.

## There is no `xbus` command until you bootstrap one

XBus install is **PATH-free by design.** A fresh checkout has no global `xbus`
command, and installing does **not** create one. You invoke XBus one of two ways:

1. **From a source checkout** — call the built entrypoint with `node`:
   `node .\dist\cli\main.js <command>`.
2. **From an installed copy** — call the installed script by absolute path (see
   "Invoking an installed XBus" below).

Do **not** type a bare `xbus` / `xclaude` before you have created an accessible
command; nothing puts them on PATH.

## Build + install from a source checkout (Windows)

This is the supported developer-preview bootstrap. **Do not run `npm test` as an
installation step** — the test suite is for developing XBus, not installing it.

```powershell
git clone https://github.com/Kumaraman110/XBus
cd XBus
npm install
npm run build

# Preview the install (writes nothing):
node .\dist\cli\main.js install --dry-run

# Install at user scope (copies the plugin, registers MCP + hook, creates the
# ACL-restricted data dir + per-install secret). Does NOT modify PATH.
node .\dist\cli\main.js install

# Verify health:
node .\dist\cli\main.js doctor

# Launch Claude Code with the XBus plugin enabled (requires Claude Code installed):
node .\dist\launcher\xclaude.js
```

`xclaude` spawns your own `claude` with `--plugin-dir <installed plugin>`. If
`claude` is not on your PATH, set `CLAUDE_CODE_EXECPATH` to its full path.

## Release-asset install (Windows ZIP)

When using a published release asset instead of a source checkout:

```powershell
Expand-Archive .\xbus-<version>-windows.zip
cd .\xbus-<version>-windows
node .\dist\cli\main.js install
node .\dist\cli\main.js doctor
```

## Invoking an installed XBus

The installer records a manifest at `~/.claude/xbus-install/install-manifest.json`
and copies the plugin under `~/.claude/xbus-install/plugin`. After install you can
invoke the installed binaries by absolute path:

```powershell
node "$HOME\.claude\xbus-install\plugin\dist\cli\main.js" doctor
node "$HOME\.claude\xbus-install\plugin\dist\launcher\xclaude.js"
```

> **Optional PATH integration is NOT part of this preview.** A future, separate,
> explicitly-approved step may add a user-scope `bin` directory to PATH with full,
> reversible tracking. Until that ships and is tested, XBus does not touch PATH and
> these docs do not assume a bare `xbus` command.

## What an install changes

1. Copies the XBus plugin to `~/.claude/xbus-install/plugin` (user scope).
2. Registers the XBus MCP server + checkpoint hook for Claude Code (user scope).
3. Creates the per-user data directory with restricted ACLs and a per-installation
   root secret. An **installed** instance uses `<install-root>/data`
   (default `~/.claude/xbus-install/data`); running from source uses `~/.claude/xbus`.
   Either is overridable with `XBUS_DATA_DIR`.

It does **not** modify PATH, the registry, or any shell profile. All changes are
**reversible** (see Uninstall); nothing is written outside your user scope.

## Literal clean-shell transcript

A first run on a clean Windows profile (Node 24), abbreviated:

```text
PS C:\> node --version
v24.4.0
PS C:\> git clone https://github.com/Kumaraman110/XBus ; cd XBus
PS C:\XBus> npm install ; npm run build
PS C:\XBus> node .\dist\cli\main.js install --dry-run
{"ok":true,"dryRun":true,"plan":{"action":"install","filesToWrite":463,...}}
PS C:\XBus> node .\dist\cli\main.js install
{"ok":true,"health":{"ok":true},...}
PS C:\XBus> node .\dist\cli\main.js doctor
xbus doctor
  this_build       ok   xbus-0.1.0-beta.3-<commit> ...
  broker           ok   ...
PS C:\XBus> node .\dist\launcher\xclaude.js --version
xclaude: launching Claude Code with XBus plugin: C:\Users\<you>\.claude\xbus-install\plugin
```

The full clean-machine lifecycle (install → doctor → broker → two-session
send/ack/reply → uninstall) is automated by
[`scripts/clean-machine-accept.mjs`](../scripts/clean-machine-accept.mjs) and the
artifact-first suite in
[`tests/integration/artifact-first-install.test.ts`](../tests/integration/artifact-first-install.test.ts).

## Isolated-profile trial (no real changes)

To exercise the broker against a throwaway data directory without a real install:

```powershell
$env:XBUS_DATA_DIR = "$env:TEMP\xbus-trial"
node .\dist\cli\main.js start
node .\dist\cli\main.js doctor
node .\dist\cli\main.js stop
Remove-Item -Recurse -Force $env:TEMP\xbus-trial
```

## Upgrade

Install the new build (same `install` command); on first start the broker applies
any pending schema migrations. An incompatible migration (checksum drift) or a
database **newer** than the build fails closed with an actionable message rather
than risking corruption. `node .\dist\cli\main.js doctor` reports the exact build
identity (`buildId`, `sourceCommit`, `installedArtifactManifestSha256`, `mixedBuilds`).

## Uninstall

```powershell
node .\dist\cli\main.js stop
node .\dist\cli\main.js uninstall          # removes only manifest-owned files + registration
Remove-Item -Recurse -Force "$HOME\.claude\xbus-install\data"   # or your XBUS_DATA_DIR
```

`uninstall` removes only the files the install manifest recorded; unrelated files in
the install root are left untouched. There is **no PATH entry to remove** (install
never created one). After the data dir is deleted, no XBus state remains.

## Honest scope

This preview does **not** modify PATH or a shell profile, and the maintainer's
automated work does not perform a machine-wide change. The bootstrap above
(`node .\dist\cli\main.js …`) is the actual supported flow and is what the
clean-machine acceptance script runs verbatim.
