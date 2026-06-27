# Packaging (Windows, isolated)

XBus packages as a **self-contained, isolated** distribution: a built JavaScript
tree plus its pinned pure-JS dependencies, requiring **no build toolchain**
(npm install, Bun, node-gyp, or a C/C++ compiler) after install. This is possible
because:

- Persistence uses **`node:sqlite`**, a Node built-in (ADR 0002) — there is no
  native SQLite addon to compile.
- The only runtime dependencies are **`uuid`** and **`zod`**, both pure-JS.

## Build the package

```
npm run package:win            # builds dist/, then stages -> build/win-package
# or to a chosen dir:
npx vite-node scripts/package-win.ts <stagingDir>
```

The script writes ONLY under the staging directory you give it. It does **not**
touch the user profile, PATH, the registry, or any global location. (A real
end-user install — copying the staged tree somewhere on PATH — is a separate,
explicitly-authorized step and is NOT performed here.)

## What the package contains

| Item | Purpose |
|------|---------|
| `dist/` | Compiled JS (no TypeScript, no build step at runtime). |
| `node_modules/uuid`, `node_modules/zod` | Pinned **production** deps only — no dev/build tooling. |
| `package.json` | Prod deps + `engines.node` runtime pin; **no scripts, no devDependencies**. |
| `runtime.json` | The pinned Node runtime + an explicit `buildToolchainRequiredAtRuntime: false`. |
| `SHA256SUMS` | SHA-256 of every shipped file (integrity verification). |
| `sbom.json` | CycloneDX SBOM of the shipped dependency set (name + version + purl + license). |

## Verification (all asserted in `tests/integration/packaging.test.ts`)

1. **Toolchain-free** (`assertNoBuildToolchain`): no `.node` native addons, no
   `binding.gyp`, and no forbidden runtime deps (better-sqlite3, node-gyp,
   typescript, vitest, esbuild, bun) anywhere in the staged tree.
2. **Checksums**: every shipped file is in `SHA256SUMS`; a sample is recomputed
   and compared byte-for-byte.
3. **SBOM**: every shipped dependency appears with a concrete version + purl.
4. **Content-clean**: the content scanner (`scripts/content-scan.ts`) finds no
   private/local paths, developer identity, or secret-shaped material in the
   package.
5. **Lean manifest**: the staged `package.json` carries prod deps + engines but
   no scripts and no devDependencies.

## Runtime pin

`runtime.json` records `engines.node` (currently `>=22.5`). The package is meant
to run on a pinned Node runtime shipped/declared alongside it; because no
dependency is native, the same staged tree runs on any compatible Node without a
rebuild.

## What is NOT done here (honest scope)

- No real install to a user location, no PATH change, no PowerShell-profile edit,
  no registry write — those remain explicitly unauthorized for this work.
- No code signing / installer (.msi/.exe) is produced; the deliverable is the
  verifiable staged tree + checksums + SBOM. Signing is a release-time step.
