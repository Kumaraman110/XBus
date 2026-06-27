# ADR 0011 — Build-identity model (separate exact identity from compatibility)

**Status:** Accepted · **Date:** 2026-06-26 · runtime-provenance correction.
Supersedes the single-`buildId` wording of ADR 0004 §"Consequences"; the wire
format, bytes, and vectors of XBUS-STP v1 (ADR 0010 / `docs/secure-transport-spec.md`)
are **UNCHANGED**.

## Context — the provenance ambiguity

Earlier builds had a single field named `buildId` that did **two** jobs that
must never be conflated:

1. It was the value bound into the XBUS-STP handshake transcript (the wire field
   the STP v1 spec names `buildId`), used for version/identity binding.
2. It was named and documented as if it were the **exact artifact identity** of a
   particular build.

But that single value was only a **compatibility tuple** —
`xbus-<version>-p<proto>-s<schema>` with **no commit** — so two different source
builds that shared the same version/protocol/schema produced an **identical**
`buildId`. Two such builds were therefore operationally **indistinguishable**: a
running broker, `xbus version`, `xbus doctor`, the build/runtime manifests, and the
handshake all reported the same string for two materially different artifacts. This
is a provenance defect (you cannot tell which exact build is running), not a
security defect (the binding it actually performs is correct).

This model separates the two concepts and gives each a precise, non-overlapping name.

## Decision — five distinct identity concepts

The normative model lives in `src/shared/build-identity.ts` and is summarised here.

| Name | Form (verified in code) | Stability | Where it lives / is used |
|---|---|---|---|
| **productVersion** | `0.1.0-test.1` (the human release id; `XBUS_VERSION` / `package.json` `version`, asserted equal) | per release | `version`, `doctor`, `provenance.json` |
| **exactBuildId** (`buildId`) | `xbus-<productVersion>-<shortCommit>` — `exactBuildId(version, commit)`, `commit.slice(0,12)` (or `source` when unbuilt) | per exact source build; **deterministic** (no clock / user / path / host / random) | `provenance.json`, `version`, `doctor`; **diagnostics only — never bound into the handshake** |
| **sourceCommit** | full git commit SHA used to produce the artifact (or `source`) | per exact source build | `provenance.json`, `version`, `doctor` |
| **compatibilityId** | `xbus-p<proto>-stp<stp>-s<schema>` = `xbus-p1-stp1-s5` — `compatibilityId(schema)`, **version-INDEPENDENT** | per protocol/STP/schema tuple (stable across versions) | bound into the STP transcript; the value the STP v1 wire field named `buildId` carries (`WIRE_COMPATIBILITY_ID`) |
| **artifactManifestSha256** | sha256 of the artifact's `SHA256SUMS` file — the single value that fixes the whole distributable | per exact distributable | recorded in the install manifest at install time; reported by `doctor` as `installedArtifactManifestSha256` |

Key derived properties, confirmed against the code:

- **compatibilityId is version-independent by construction** — it omits the product
  version entirely (`compatibilityId()` in `build-identity.ts` references only
  `PROTOCOL_VERSION`, `SECURE_TRANSPORT_VERSION`, and the schema). So different builds
  **interoperate iff this matches**, which is exactly the property the handshake
  needs.
- **exactBuildId is deterministic** — derived only from `productVersion` + commit; it
  carries no timestamp, username, path, hostname, or randomness, so the same source
  builds to the same id. It is **never** put on the wire.
- **provenance.json** (emitted by `src/tools/package-win.ts`) is the deterministic,
  checksum-covered, contract-validated carrier of exact identity. Its shape is
  `{ productVersion, buildId, sourceCommit, compatibilityId, applicationProtocolVersion,
  secureTransportProtocolVersion, schemaVersion }`.
- **Read path is fail-closed** — `readProvenance()` returns `null` when no manifest is
  present (a source/dev run, which then degrades to a clearly labelled `source`
  identity — never a false exact id), but **throws** on a present-but-malformed or
  internally contradictory manifest (e.g. a `buildId` that does not embed the
  `productVersion`, or a `compatibilityId` that does not match the declared
  proto/stp/schema). A tampered provenance must never silently degrade.

## Security note — why this is NOT an STP version bump

This is the load-bearing part of the decision and the reviewer call-out:

- **The STP v1 wire field historically named `buildId` carries the COMPATIBILITY
  value (`wireCompatibilityId`), not exact artifact identity.** In code,
  `WIRE_COMPATIBILITY_ID = compatibilityId(SCHEMA_VERSION)` and the legacy export
  `BUILD_ID` is retained **as an alias** so every wire-construction site is unchanged
  (`src/protocol/handshake.ts`).
- **The wire format, the bytes, and the test vectors are UNCHANGED.** The STP v1
  `client_hello` still carries one `buildId` byte-string field in the same position;
  the transcript, key schedule, AAD, and `tests/fixtures/stp-vectors.json` are
  byte-for-byte identical. Key derivation uses the **client's submitted** value, so
  cross-build handshakes still succeed and the fixture value is unchanged. **No
  protocol change and no crypto change occurred.**
- **Exact identity is carried in authenticated, POST-handshake registration**, never
  in the handshake. The broker's `hello` ack reports the broker's exact build (from
  its registration provenance) over the already-established encrypted channel; `doctor`
  reads it back as `brokerExactBuild` and computes `mixedBuilds`. Exact identity is a
  diagnostic fact exchanged over an authenticated channel, not an input to
  authentication.
- **Therefore this change is NOT an STP version bump.** A version bump (`stpVersion 1 → 2`)
  is reserved for a change to the wire bytes, key schedule, or proof construction —
  none of which happened. This change only renames a concept and adds a deterministic
  out-of-band provenance manifest plus richer diagnostics. Bumping STP would have
  *broken* interoperability (the transcript value the field carries is deliberately
  version-independent precisely so different builds interoperate) for a change that
  touches no wire byte — which would be incorrect.
- **This change exists because operational provenance required a runtime correction, not
  because of a security defect.** The earlier binding was correct; what was wrong was
  that one field was *named/documented* as exact identity when it was only a
  compatibility tuple, leaving two builds indistinguishable in the field.

## Consequences

- **Code (already implemented; documented here, not changed by this ADR):**
  `src/shared/build-identity.ts` (the normative model: `compatibilityId`,
  `exactBuildId`, `readProvenance`, `resolveIdentity`, `provenancePathFromDist`);
  `src/protocol/handshake.ts` (`WIRE_COMPATIBILITY_ID` + deprecated `BUILD_ID`
  alias); `src/tools/package-win.ts` (emits the checksum-covered, contract-validated
  `provenance.json`); `src/cli/install.ts` (records `artifactManifestSha256` in the
  install manifest); `src/cli/main.ts` (`version` + `doctor --json` report the full
  model; `doctor` reports `installedArtifactManifestSha256`, `brokerExactBuild`,
  `mixedBuilds`).
- **Reporting:** `xbus version` and `xbus doctor --json` now report
  `productVersion`, the **exact** `buildId`, `sourceCommit`, `compatibilityId`, and
  the three version numbers, so different builds are unambiguously distinguishable.
  Legacy JSON keys (`version`, and the old `buildId` semantics) are retained as the
  compatibility values for back-compat consumers, but `buildId` is now the **exact**
  id.
- **Mixed-build detection:** because the broker reports its exact build post-handshake,
  `doctor` can flag a client/broker exact-build mismatch (`mixedBuilds: true`) even
  when they are fully compatible — a diagnostic the old single value could not express.
- **Docs reconciled:** `docs/secure-transport-spec.md` (note that the wire `buildId`
  field is the stable `wireCompatibilityId`), `docs/security-review-packet.md`
  (clarifications), `docs/compatibility.md` (build-id section), `docs/architecture.md`,
  `docs/installation.md` / `docs/troubleshooting.md` (doctor output),
  `docs/privacy.md`, and a Phase 3 terminology stub.

## Cross-references

- ADR 0004 (version handshake) — the compatibility-verdict mechanism; its single-
  `buildId` consequence line is superseded by this ADR's separation.
- ADR 0010 (Windows pipe security) — the XBUS-STP design; the wire field this ADR
  renames is unchanged there.
- `docs/secure-transport-spec.md` §4/§5/§6 — where the wire `buildId` field appears.
