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
npm run package:win <stagingDir>   # builds dist/, then stages the artifact dir
```

The script writes ONLY under the staging directory you give it. It does **not**
touch the user profile, PATH, the registry, or any global location. (A real
end-user install — copying the staged tree somewhere on PATH — is a separate,
explicitly-authorized step and is NOT performed here.)

## Build the deterministic release ZIP

The published Windows asset is a **deterministic** ZIP built from the frozen
artifact directory — NOT PowerShell `Compress-Archive` (whose per-run timestamps
made the archive SHA non-reproducible and therefore unfit as a release identity):

```
npm run package:win <artifactDir>                         # 1) freeze the artifact
npm run package:release-zip <artifactDir> <out.zip>       # 2) deterministic ZIP
```

`package-release-zip.ts` reads only the frozen artifact and pins every variable a
generic zipper leaves to chance: entries sorted by UTF-8 path bytes, one fixed
1980-01-01 timestamp, forward-slash paths, no directory entries, **STORE** (no
compression — DEFLATE output varies by zlib build across Node versions), and
fixed file attributes. It rejects symlinks/reparse points and duplicate
normalized paths, then **self-verifies**: it re-parses the archive it just wrote
and checks every entry's CRC-32 + SHA-256 against `SHA256SUMS` in both directions.
Two clean clones on any supported Node (22 / 24) produce a **byte-identical**
archive and identical SHA-256. The builder's Node/OS is recorded out of band in a
`<out>.release-provenance.json` sidecar — never inside the reproducible artifact.

## What the package contains

| Item | Purpose |
|------|---------|
| `dist/` | Compiled JS (no TypeScript, no build step at runtime). |
| `node_modules/uuid`, `node_modules/zod` | Pinned **production** deps only — no dev/build tooling. |
| `package.json` | Prod deps + `engines.node` runtime pin; **no scripts, no devDependencies**. |
| `runtime.json` | The pinned Node runtime + an explicit `buildToolchainRequiredAtRuntime: false`. |
| `provenance.json` | The **deterministic** build identity (version + commit + compatibility tuple), read at runtime (ADR 0011). |
| `build-manifest.json` | Source provenance (name/version/commit/compat tuple). Deterministic — no builder Node/OS/timestamp (those would break reproducibility). |
| `install.ps1`, `LICENSE` | PATH-free release-asset installer + license notice. |
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
6. **Deterministic release ZIP** (`tests/integration/release-zip.test.ts`): the
   archive is byte-identical across repeated builds, STORE-only with a fixed
   timestamp + sorted entries, ships only the installable artifact (no internal
   staging marker), and round-trips every entry against `SHA256SUMS`.

## Runtime pin

`runtime.json` records `engines.node` (currently `>=22.13 <25`). The package is
meant to run on a pinned Node runtime shipped/declared alongside it; because no
dependency is native, the same staged tree runs on any compatible Node without a
rebuild.

## What is NOT done here (honest scope)

- No real install to a user location, no PATH change, no PowerShell-profile edit,
  no registry write — those remain explicitly unauthorized for this work.
- No code signing / installer (.msi/.exe) is produced; the deliverable is the
  verifiable staged tree + checksums + SBOM. Signing is a release-time step.
