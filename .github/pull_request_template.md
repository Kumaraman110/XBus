<!--
Thanks for contributing to XBus (Public Developer Preview).
Keep PRs focused — one concern per PR. Branch from `main`.
Do not include real paths, usernames, secrets, or message bodies anywhere
in the diff; a CI content scan rejects them.
-->

## What & why

<!-- What does this change, and what problem does it solve? Link the issue it
     addresses (e.g. "Closes #123"). Explain the *why* for anything non-trivial. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature / enhancement
- [ ] Platform validation (macOS / Linux / cross-user Windows)
- [ ] Documentation
- [ ] Refactor / internal (no behavior change)
- [ ] Security-relevant (see the honesty rules below)

## How I verified it

<!-- Be specific. New behavior needs tests; reliability/security changes need
     adversarial or race tests. Note the platform + provider you tested on. -->

- Platform tested: <!-- Windows 11 / macOS / Linux / cross-user Windows -->
- Provider tested: <!-- Bedrock checkpoint / Anthropic API / n/a -->

## Checklist

- [ ] `npm run build` passes (`tsc` → `dist/`).
- [ ] `npm test` passes (full vitest suite; the suite uses a deterministic `FakeClock` + seeded RNG).
- [ ] `npm run typecheck` passes.
- [ ] I added/updated tests for the behavior I changed.
- [ ] **Honesty over optimism** — I did not claim a guarantee the code does not enforce. Limitations stay labeled (e.g. "at-most-once context injection, NOT exactly-once execution"; "Bedrock = checkpoint delivery, no idle-wake").
- [ ] **No private content** — no local paths, machine identity, usernames, or secret-shaped material in the public surface.
- [ ] If this alters a recorded decision, I added or superseded an ADR in `docs/adr/`.
- [ ] If this changes the protocol, schema, or MCP tool surface (all pre-1.0), I noted it in the PR and updated the `CHANGELOG.md` `[Unreleased]` section.

## Security note

<!-- If this is a vulnerability fix, DO NOT describe the exploit publicly here.
     Coordinate first via SECURITY.md. XBUS-STP wire vectors must not change
     silently — call out any change to crypto, key schedule, AAD, or the
     compatibility tuple. -->
