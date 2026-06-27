# Contributing to XBus

Thanks for your interest! XBus is a Public Developer Preview and we especially
want help with the gaps called out below.

## Where help is most wanted

- **macOS / Linux runtime validation.** The Unix socket + mode-based hardening
  paths are implemented but not yet runtime-validated. Running the suite on those
  platforms and reporting results is high-value.
- **Cross-user Windows validation.** The same-user ACL boundary is proven; the
  cross-user boundary has not been tested (no second-account environment).
- **External review of XBUS-STP.** The secure transport is internally reviewed,
  not independently audited. Protocol/threat-model review is welcome — see
  [docs/secure-transport-spec.md](docs/secure-transport-spec.md).
- **Provider coverage.** Live Channel delivery beyond Bedrock checkpoint mode.

## Development setup

```
npm install
npm run build        # tsc -> dist/
npm test             # full vitest suite
npm run typecheck    # tsc --noEmit
```

Requirements: Node `>=22.5` (uses the `node:sqlite` built-in; **no** native
addons, so no C/C++ toolchain is needed).

### Static analysis (v0.1.0)

ESLint **is an enforced gate**. `npm run verify:release` runs `eslint .` with the
pinned flat-config (`eslint.config.js`) and fails the release unless there are
**zero findings**. The config is deliberately correctness-only — type-aware checks
`tsc` cannot see (no floating/misused promises) — with no stylistic/formatting
rules, so the diff stays reviewable line-for-line. Alongside it, the enforced
static checks are TypeScript strict (`npm run typecheck`) and the
repository-specific security/content guards (secure-IPC construction,
privileged-frame inventory, private-content / absolute-path scans, artifact
secret/canary scans). Type-aware linting is scoped to the compiled TypeScript
project (`src/`); standalone sample trees (`docs/`, `examples/`) and the test
harness are intentionally outside it.

## Ground rules

- **Tests are first-class.** New behaviour needs tests; reliability/security
  changes need adversarial or race tests. The suite uses a deterministic
  `FakeClock` + seeded RNG so timing tests don't flake.
- **Honesty over optimism.** Don't claim a guarantee the code doesn't enforce.
  We label limitations explicitly (e.g. "at-most-once context injection, NOT
  exactly-once execution"). PRs that overstate guarantees will be asked to soften.
- **No private content.** A CI content scan (`tests/integration/content-scan.test.ts`)
  rejects local paths, machine identity, or secret-shaped material in the public
  surface. Run the suite before pushing.
- **Architecture decisions live in `docs/adr/`.** A change that alters a recorded
  decision should add or supersede an ADR.
- **Conventional-ish commits.** Short imperative subject; explain the *why* in the
  body for non-trivial changes.

## Pull requests

1. Branch from `main`.
2. Keep PRs focused; one concern per PR.
3. Ensure `npm run build`, `npm test`, `npm run lint` pass.
4. Describe what you changed and how you verified it.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to uphold it.
