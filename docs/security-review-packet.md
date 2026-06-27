# XBUS-STP Independent Security Review Packet

> **Purpose.** This is the reviewer hand-off packet for an independent review of
> the XBus secure transport (XBUS-STP v1) and its surrounding threat model. It
> assembles the artifacts that already exist in this repository and makes every
> cross-reference **concrete and verified against the tagged release commit**, not
> against a design sketch. Where the planning document (`docs/phase2-groundwork.md`
> §5) or another doc claims something the code does not literally support, this
> packet **flags the discrepancy** rather than repeating the claim — see
> [§11 Discrepancies & freshness verification](#11-discrepancies--freshness-verification).
>
> **Status of XBUS-STP:** internally reviewed and adversarially tested,
> **NOT independently audited.** This packet exists to request that audit.
>
> Assembled per `docs/phase2-groundwork.md` §5 (Independent security review prep).
> Docs-only: no source files were changed in producing it.

---

## Table of contents

1. [Scope statement (trust domain)](#1-scope-statement-trust-domain)
2. [The four review asks (verbatim)](#2-the-four-review-asks-verbatim)
3. [Artifact map](#3-artifact-map)
4. [Spec ↔ code cross-reference table](#4-spec--code-cross-reference-table)
5. [Key-schedule walk-through (traced against the code)](#5-key-schedule-walk-through-traced-against-the-code)
6. [AAD construction call-out](#6-aad-construction-call-out)
7. [No-forward-secrecy call-out (§12)](#7-no-forward-secrecy-call-out-12)
8. [Custom-protocol caveat (ADR 0010 honesty amendment)](#8-custom-protocol-caveat-adr-0010-honesty-amendment)
9. [Known residual: untrusted-pipe DoS bound (§3)](#9-known-residual-untrusted-pipe-dos-bound-3)
10. [Reproduction instructions](#10-reproduction-instructions)
11. [Discrepancies & freshness verification](#11-discrepancies--freshness-verification)
12. [Private disclosure channel](#12-private-disclosure-channel)
13. [Reviewer hand-off checklist](#13-reviewer-hand-off-checklist)

---

## 1. Scope statement (trust domain)

XBus is **same-machine, same-user** software. The trust boundary under review:

**In scope / defended:**
- Another *unrelated OS user* on the same host must not read the data dir, DB,
  state file, or root secret, and must not obtain a usable IPC channel even if
  they know the pipe / socket name.
- IPC frames must be authenticated, confidential, and integrity-protected; forged,
  replayed, reordered, or tampered frames must be rejected.
- A peer must not be able to inject privileged frames before completing the secure
  handshake (no plaintext privileged fallback).

**Out of scope (explicit non-goals):**
- **Malware running as your own fully-privileged OS user.** Same-user software
  cannot sandbox that; such an attacker can read the data dir, the root secret, and
  Claude config directly. (`docs/security.md` threat table last rows; `SECURITY.md`.)
- **Cross-machine / remote transport.** XBUS-STP is a local-IPC boundary only.
- **Cross-user Windows OS-layer authorization is `⚠️ unverified`,** not "defended":
  the cryptographic boundary is proven, but the second-real-account OS-deny test has
  not been run in this environment (ADR 0010 "Cross-user OS test status";
  `docs/security.md` row "Cross-user attack on Windows").

### Build-identity clarification (ADR 0011) — reviewers please note

- The XBUS-STP v1 **wire field named `buildId` carries the COMPATIBILITY value**
  (`wireCompatibilityId` = `xbus-p<proto>-stp<stp>-s<schema>`, version-independent),
  **not** the exact artifact identity. In code, `WIRE_COMPATIBILITY_ID` with the
  legacy `BUILD_ID` alias (`src/protocol/handshake.ts`).
- **Exact identity** (`productVersion` / exact `buildId = xbus-<version>-<commit>` /
  `sourceCommit`) is carried in **authenticated, post-handshake registration**, never
  in the handshake; the deterministic carrier is the checksum-covered, contract-
  validated `provenance.json` (`src/tools/package-win.ts`, `src/shared/build-identity.ts`).
- **STP test vectors (`tests/fixtures/stp-vectors.json`) and the §5 key schedule are
  UNCHANGED.** The change is a rename + an out-of-band provenance manifest +
  richer diagnostics. **No protocol change and no crypto change occurred**, so this is
  **not** an STP version bump (`stpVersion` is still `1`).
- **This change exists because operational provenance required a runtime correction**, not
  because of a security defect: the earlier binding was correct, but one field was
  *named/documented* as exact identity when it was only a compatibility tuple, leaving
  two builds indistinguishable in the field. Full rationale: ADR 0011.

---

## 2. The four review asks (verbatim)

From `docs/security.md` ("What we ask reviewers to look at") — quoted exactly:

> 1. The XBUS-STP spec + key schedule + AAD construction.
> 2. The same-user threat model and the no-forward-secrecy justification.
> 3. The Windows IPC decision (crypto boundary vs OS ACL / .NET proxy).
> 4. The authority model (connection-bound, non-bearer) and the receipt ledger.

`SECURITY.md` (repo root) states the same posture: *"We are actively requesting
external review of the protocol spec, threat model, and the Windows IPC design
decision."*

> **Verification note.** `docs/phase2-groundwork.md` §5 cites the roadmap phrase
> "We are requesting review of". The exact reviewer-facing list lives in
> `docs/security.md`, quoted above; that is the authoritative wording reproduced
> here.

---

## 3. Artifact map

Every artifact below was opened and confirmed present at the tagged release commit. State
column = its current condition.

| # | Review ask satisfied | Artifact (path) | State at HEAD |
|---|---|---|---|
| 1 | Normative spec | `docs/secure-transport-spec.md` | Present. §0–§13 (note: numbering differs from the groundwork's claim — see [§11](#11-discrepancies--freshness-verification)). |
| 2 | Implementation: handshake + AEAD | `src/ipc/secure-channel.ts` | Present. All functions cited in [§4](#4-spec--code-cross-reference-table) exist. |
| 2 | Implementation: secret storage + rotation | `src/ipc/root-secret.ts` | Present. `loadOrCreateRootSecret`, `rotateRootSecret`, `secretPath`. |
| 2 | Implementation: dispatch guard + DoS bound | `src/ipc/server.ts` | Present. No-plaintext-fallback in `dispatch()`; DoS knobs in `ServerOptions`. |
| 2 | Implementation: data-at-rest perms | `src/ipc/acl.ts` | Present. `hardenDir`/`hardenFile`/`icaclsRestrict`/`describeAcl`/`assertNotReparse`. |
| 3 | Decision record | `docs/adr/0010-windows-pipe-security.md` | Present. Design A vs B, residual-risk statement, honesty amendment. |
| 4 | Threat model | `docs/security.md` | Present. Defended/not-defended table. |
| 4 | Privileged-frame matrix | `docs/privileged-frame-inventory.md` | Present. Per-family auth tiers (L1–L4) + tests. |
| 5 | Deterministic test vectors | `tests/fixtures/stp-vectors.json` | Present. Root test key, nonces, transcript hash, derived keys, IV bases, sealed frame, plaintext. |
| 6 | Adversarial test suite | `tests/security/*.test.ts` (see [§10](#10-reproduction-instructions)) | All 7 named files present + 2 more (`component-authority`, `windows-acl`). |

---

## 4. Spec ↔ code cross-reference table

Every row was verified by opening `src/ipc/secure-channel.ts` and confirming the
named symbol exists at the cited line. **No function name here is invented.**

| Spec § | Spec requirement | `secure-channel.ts` symbol(s) | Line(s) |
|---|---|---|---|
| §1 Canonical encoding | length-prefixed binary, NOT JSON; transcript = concatenated canonical encodings | `encodeClientHello`, `encodeServerHelloCore`, `ByteWriter`/`ByteReader` (from `./codec.js`) | 48–60, 11 |
| §2 Root secret + keyVersion | 32-byte CSPRNG secret; keyVersion uint32 in the clear | `generateRootSecret`, `ROOT_SECRET_BYTES=32`; `keyVersion` field carried through hello | 46, 16, 38–44 |
| §3 Cipher suite | `SUITE_AES256_GCM = 0x0001`; broker selects, transcript-bound | `SUITE_AES256_GCM`; selection in `serverHandshake`; offered-check in `clientFinish`/`parseClientHello` | 15, 161–162, 124–125 |
| §4 Handshake messages | client_hello / server_hello / client_finish / server_ack canonical layout | `encodeClientHello`, `encodeServerHelloCore`, `parseClientHello`, `parseServerHello` | 48–69, 111–157 |
| §4 connId fixed width | connId is normatively 16 bytes; off-width rejected | `CONN_ID_BYTES=16`; reject in `parseClientHello` (`'bad connId length'`) | 18, 151 |
| §5 Key schedule | transcript hash `th`; PRK from nonces+rootSecret; per-label `K()` over `context` | `buildContext`, `expand`, `deriveAll`; `th = createHash('sha256')...` | 62–92, 128, 167 |
| §6 Transcript / downgrade / identity binding | suite, version, role/session/epoch, buildId, capabilities bound into `context` so substitution → different keys → proof fails | `buildContext` (folds connId, role, sessionId, epoch, buildId, suite, version) | 62–69 |

> **`buildId` in the rows above = the wire `wireCompatibilityId`** (compatibility
> tuple), per ADR 0011 / the [build-identity clarification](#build-identity-clarification-adr-0011--reviewers-please-note) in §1.
> It is **not** the exact artifact id; binding it (not the exact id) is intentional.
> The bound value, its byte layout, and the vectors are unchanged by this change.
| §6 Proofs (reflection-resistant) | distinct `"server-finished"`/`"client-finished"` labels + distinct keys | `proof(mk, label, th)`; `mk_server` vs `mk_client` | 94–96, 89–90 |
| §7 Encrypted frame format | `frame = seq | iv | tag | ciphertext`; iv = base XOR counter | `SecureSession.seal`, `SecureSession.iv` | 216–227, 204–210 |
| §7 AAD construction | `"XBUS-STP/v1" | connId | direction | seq | ctLen` | `SecureSession.aad` | 212–214 |
| §7 Plaintext never processed pre-tag; MAX_PLAINTEXT 1 MiB | size-check before allocation; GCM verify before use | `MAX_PLAINTEXT`; `seal`/`open` guards; `decipher.final()` throws on tamper | 23, 217, 236, 242 |
| §7 seq overflow → close | close before counter reuse | `seal`: `if (this.sendSeq >= 0xffffffff) throw 'SEQ_OVERFLOW'` | 218 |
| §8 Sequence / replay rules | duplicate / reorder / skip → reject + close | `open`: `if (seq !== this.recvSeq) throw 'REPLAY_OR_REORDER'` | 232 |
| §9 Uniform errors (no oracle) | single `AUTH_FAILED`, no distinguishing detail | `AuthFailed` class; thrown in `clientFinish`, `serverVerifyFinish` | 25, 132, 178 |
| §10 Rotation / restart | fresh nonces ⇒ fresh keys; rotation invalidates old keys | `root-secret.ts` `rotateRootSecret`; nonces per `startClientHandshake`/`serverHandshake` | (root-secret.ts 59–67), 104, 163 |
| §11 Downgrade policy | unknown version/suite → `PROTOCOL_MISMATCH`, no silent downgrade | `ProtocolMismatch`; `parseClientHello` (`'unsupported version'`), `clientFinish` | 26, 143, 124 |
| §12 Forward secrecy | none (no ephemeral DH); documented consequence | (absence is the design — keys derive from long-lived rootSecret; see [§7](#7-no-forward-secrecy-call-out-12)) | n/a (deliberate) |
| §13 Test vectors | deterministic non-production vectors | `tests/fixtures/stp-vectors.json`; consumed by `stp-vectors-fuzz.test.ts` | (fixture) |

---

## 5. Key-schedule walk-through (traced against the code)

This traces `rootSecret → prk → per-label K()` against the **actual** code in
`deriveAll` / `expand` / `buildContext` (`secure-channel.ts` lines 62–92). Note the
deviation from the spec's literal HKDF-Extract wording, flagged in
[§11](#11-discrepancies--freshness-verification).

**Step 1 — transcript hash (`th`).** Server side, `serverHandshake` (167) and client
side, `clientFinish` (128):
```
transcript = clientHelloBytes | serverHelloCore   // through server_hello
th         = SHA256(transcript)
```
`serverHelloCore` is the server_hello *without* the proof (`encodeServerHelloCore`,
58–60), which is correct: the proof is computed over `th`, so it cannot be inside the
hashed transcript.

**Step 2 — binding context.** `buildContext` (62–69):
```
context = th | brokerInstanceId | connId | claimedRole
            | claimedSessionId | u32 claimedEpoch | buildId
            | u16 selectedSuite | u8 STP_VERSION
```
Every identity/negotiation field a downgrade or substitution attack would target is
folded in here, so a changed field ⇒ a different `context` ⇒ different keys ⇒ proof
fails closed (§6).

**Step 3 — PRK.** `deriveAll` (80–81):
```js
const prk = Buffer.from(hkdfSync('sha256', rootSecret,
  Buffer.concat([clientNonce, serverNonce]),       // salt
  Buffer.from('XBUS-STP/v1/extract'),              // info
  32));
```
> **Code reality vs spec text.** The spec §5 describes `prk = HKDF-Extract(salt =
> clientNonce|serverNonce, ikm = rootSecret)`. The code instead computes `prk` with a
> *full* `hkdfSync` (extract **and** expand) keyed by `rootSecret`, salted by the
> nonces, with a fixed `info = "XBUS-STP/v1/extract"`. This is a **domain-separated
> KDF call used as a PRF to produce the PRK**, not a bare HKDF-Extract. The inline
> code comment (82–83) acknowledges this: *"hkdfSync already does extract+expand; we
> use it as a PRF with explicit per-purpose info."* It is cryptographically sound (a
> distinct, salted, domain-separated derivation), but it is **not** the literal
> HKDF-Extract the spec prose states. See [§11](#11-discrepancies--freshness-verification),
> DISCREPANCY #2 — a reviewer should confirm this is acceptable and the spec text
> should be reconciled to the code (or vice-versa).

**Step 4 — per-label expansion.** `expand` (71–74):
```js
const info = Buffer.concat([Buffer.from(`XBUS-STP/v1/${label}`, 'utf8'), context]);
return Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0) /* salt */, info, len));
```
Six independent keys are derived, each with a distinct label and the same `context`
(`deriveAll`, 84–91):
```
k_c2s_enc   = expand(prk, 'c2s-enc',      context, 32)
k_s2c_enc   = expand(prk, 's2c-enc',      context, 32)
k_c2s_iv    = expand(prk, 'c2s-iv',       context, 12)
k_s2c_iv    = expand(prk, 's2c-iv',       context, 12)
mk_client   = expand(prk, 'client-proof', context, 32)
mk_server   = expand(prk, 'server-proof', context, 32)
```
Distinct labels guarantee key separation across purposes; the distinct
`mk_client`/`mk_server` plus distinct proof labels (`"client-finished"` /
`"server-finished"`, `proof()` at 94–96) defeat proof reflection (§6).

**Step 5 — proofs.** `proof()` (94–96):
```
serverProof = HMAC-SHA256(mk_server, "server-finished" | th)
clientProof = HMAC-SHA256(mk_client, "client-finished" | th)
```
Verified with `timingSafeEqual` (132, 178) with a length pre-check.

> **Independent re-derivation.** A reviewer can reproduce the entire schedule from
> `tests/fixtures/stp-vectors.json`: `rootKey`, `clientNonce`, `serverNonce`,
> `connId`, the `identity` block, the recorded `transcriptHash`, and the expected
> `derivedKeys` (`k_c2s_enc`, `k_s2c_enc`, `k_c2s_iv`, `k_s2c_iv`). `stp-vectors-fuzz.test.ts`
> asserts the code reproduces `derivedKeys.k_c2s_enc` / `k_s2c_enc` byte-for-byte.

---

## 6. AAD construction call-out

The exact AAD, quoted from `SecureSession.aad` (`secure-channel.ts` 212–214):

```js
private aad(dir: number, seq: number, ctLen: number): Buffer {
  return new ByteWriter().str('XBUS-STP/v1').bytes(this.connId).u8(dir).u32(seq).u32(ctLen).done();
}
```

In spec terms (§7): `aad = "XBUS-STP/v1" | connId | u8 direction | u32 seq | u32 ciphertextLen`.

**Why each field is bound:**
- **`"XBUS-STP/v1"`** — protocol/version domain separation; an AEAD frame cannot be
  reinterpreted under a different protocol context.
- **`connId`** — binds the frame to *this* connection's key context (connId is also in
  `buildContext`), so a frame captured on one connection cannot be replayed onto another.
- **`direction` (1 = c2s, 2 = s2c)** — this is the load-bearing replay defense the
  review ask names: a **c2s frame replayed back as s2c fails**, because the sender uses
  `sendDir` and the receiver verifies under `recvDir` (`SecureSession` constructor,
  194–202; used in `seal`/`open` at 222 / 240). The send and receive directions also use
  **different keys** (`k_c2s_enc` vs `k_s2c_enc`), so direction confusion fails on both
  the key and the AAD.
- **`seq`** — monotonic per direction; combined with the `recvSeq` check (232) this
  rejects duplicate/reorder/skip. The IV also incorporates `seq` (`iv()`, 204–210) and is
  verified equal to the expected counter (`open`, 238) before GCM.
- **`ciphertextLen`** — binds the declared length so a truncation/extension is detected.

---

## 7. No-forward-secrecy call-out (§12)

**This is an explicit, documented design decision — a reviewer is invited to agree or
dispute it against the stated threat model.**

Spec §12 (quoted): *"Design B does NOT provide forward secrecy (keys derive from the
long-lived root secret + nonces; no ephemeral DH)."* Documented consequence:

> A later compromise of the installation root secret may allow decryption of
> previously recorded XBus traffic if an attacker captured the encrypted frames and
> handshake material.

**The justification offered (spec §12, `docs/security.md`):** against the actual threat
model (same-machine, same-user), an attacker who can read the root secret already has
the user's full context — they can read the data dir and Claude config directly. So
"record now, compromise the secret later" adds little: the root-secret compromise is
itself game-over for a same-user attacker. Therefore no X25519 / ephemeral DH in v1;
revisit only if a cross-machine transport is introduced.

**Verified in code:** `deriveAll` (80–91) derives all session keys from `rootSecret` +
the connection nonces only. There is no ephemeral key agreement anywhere in
`secure-channel.ts`. The claim is accurate to the implementation.

**Reviewer prompt:** Is the same-user "secret compromise = game over anyway" argument
sound, or is there a realistic capture-then-later-compromise window (e.g. backup of
encrypted frames + a *separately* leaked secret file from a stale backup) that makes FS
worth its cost? This is the central no-FS question to adjudicate.

---

## 8. Custom-protocol caveat (ADR 0010 honesty amendment)

`docs/adr/0010-windows-pipe-security.md` carries an **honesty amendment** that a
reviewer must take at face value. Quoted:

> AES-256-GCM, HKDF-SHA256, and HMAC-SHA256 are standard, well-reviewed **primitives**.
> But the XBus **handshake, transcript construction, key schedule, frame format, replay
> rules, and rotation behavior** form an **XBus-specific protocol**. Therefore:
> - "No custom cipher / no custom MAC" is **accurate**.
> - "No custom crypto protocol" is **NOT accurate** — we composed one.
> - A composed protocol is **not automatically secure** because its primitives are
>   standard.

The module header in `secure-channel.ts` (lines 6–8) repeats this in code: *"This is a
CUSTOM PROTOCOL composed from standard primitives (see ADR 0010 honesty amendment)."*

**The explicit ask: validate the composition, not just the primitives.** The attacks
the suite already covers (so the reviewer can attack *beyond* them):
- **reflection** — a server proof reused as a client proof (`secure-channel.test.ts`
  §6.1/6.2, line 53).
- **downgrade** — a tampered `selectedSuite` / `stpVersion` (§6.8, lines 73, 125).
- **identity substitution** — role/session/epoch substitution post-derivation (§6.10–6.12,
  line 80).
- **nonce-reuse / handshake replay** — a server_hello for one client nonce reused (§6.5–6.7,
  line 96).
- **transcript binding** — any bound field altered ⇒ proof fail (covered across the above).
- **frame replay / reorder / tamper** — duplicate/reordered frames and GCM-tag failures
  (§6.16/6.18, line 106; tamper, line 117).

---

## 9. Known residual: untrusted-pipe DoS bound (§3)

Design B does **not** restrict who may *open* a pipe/socket connection (only Design A's
OS ACL could, at the cost of a .NET runtime — see ADR 0010). So an unauthenticated client
can connect and force handshake work. This residual is **named, bounded, and accepted**,
not hidden.

**The real config knobs — verified in `src/ipc/server.ts` `ServerOptions` + the
constructor defaults (lines 19–69):**

| Knob | Option field | Default | Bounds |
|---|---|---|---|
| Max concurrent connections | `maxConnections` | `64` | `accept()` destroys + logs `CONN_LIMIT` once at cap (81–85). |
| Connect-rate token bucket (sliding 1s window) | `connectRatePerSec` | `50` | `accept()` destroys + logs `CONNECT_RATE_LIMIT` over budget (89–95). |
| Pre-handshake / slow-loris cap | `handshakeTimeoutMs` | `10_000` | force-closes a connection that never finishes the handshake (`handshake_timeout`, 107–113), cleared once `secure` is set (200). |
| Idle timeout | `idleTimeoutMs` | `60_000` | `socket.setTimeout` → `closeConn('idle_timeout')` (102–103). |
| Global buffered-byte budget | `globalBufferBudgetBytes` | `16 * 1024 * 1024` (16 MiB) | `BUFFER_BUDGET_EXCEEDED` across all connections (119–122). |

These are exactly the ADR 0010 "Residual risk" bounds (`maxConnections`, idle/handshake
timeout, buffer budget, connect-rate token bucket `connectRatePerSec` default 50/s). The
accepted statement: *"An attacker cannot exhaust memory or starve real clients; the
residual is bounded compute on rejected handshakes, documented and accepted."*

**No-plaintext-fallback guard (verified, `server.ts` `dispatch()` 138–170):** when a root
secret is configured, the first wire messages MUST be the handshake (`{h:'ch'}` then
`{h:'cf'}`); any non-handshake frame before the secure session is established →
`closeConn(id, 'pre_handshake_frame')` (152–154). There is no privileged plaintext path.
Pinned by `tests/security/no-plaintext-fallback.test.ts`.

> **Reviewer prompt:** Is bounded compute-on-rejected-handshakes an acceptable residual
> for this trust model, and are the default knob values (`64` / `50`-per-s / `10s` /
> `60s` / `16 MiB`) appropriately conservative for a same-user developer tool?

---

## 10. Reproduction instructions

**Run the security shard (all adversarial tests):**
```
npm run test:security          # vitest run tests/security
```
(or `npm test` for the full suite; `npm run verify:release` for the gated release run —
ESLint is an ENFORCED gate stage, zero findings required.)

**The adversarial test files handed over as the "already tested" baseline** (all present
at `HEAD`, in `tests/security/`):

| File | What it covers |
|---|---|
| `secure-channel.test.ts` | 15 tests total: **11 handshake+AEAD adversarial** (reflection, direction binding, downgrade, identity substitution, handshake replay, frame replay/reorder, tamper, version, connId width) + 4 root-secret-lifecycle (§9). |
| `no-plaintext-fallback.test.ts` | pre-handshake frame rejection; no plaintext privileged path. |
| `privileged-frames.test.ts` | representative frame per family through STP + the four rejection vectors. |
| `root-secret-exposure.test.ts` | secret never logged / leaked. |
| `secure-resource-pressure.test.ts` | the §3 DoS bounds under pressure. |
| `stp-structure-fuzz.test.ts` | malformed handshake structure fuzzing. |
| `stp-vectors-fuzz.test.ts` | re-derives the key schedule from `tests/fixtures/stp-vectors.json` and asserts byte-equality with `derivedKeys`. |
| `component-authority.test.ts` | (also present) L2–L4 authority scoping. |
| `windows-acl.test.ts` | (also present) `describeAcl` reports `broadAccess===false`. |

**How to read the vectors (`tests/fixtures/stp-vectors.json`):** all hex.
`rootKey`/`clientNonce`/`serverNonce`/`connId` are the inputs; `identity` is the
client_hello identity block; `clientHelloBytes`/`serverHelloBytes` are the exact canonical
encodings; `transcriptHash` is `SHA256(clientHelloBytes | serverHelloCore)`; `derivedKeys`
are the six expand outputs (encryption + IV-base keys shown); `clientProof` is the §5 HMAC;
`sealedFrame` is `seq | iv | tag | ciphertext` for `plaintext`. **The test key
(`4242…42`) is NEVER used in production** (fixture `note`).

---

## 11. Discrepancies & freshness verification

> This is the value-add section. Each artifact was opened at the tagged release commit and
> checked against what `docs/phase2-groundwork.md` §5 (and the docs it points to)
> *claims*. Confirmed-current items and flagged divergences are both listed.

### Confirmed current (exists + matches claim at HEAD)
- All five `src/ipc/*.ts` files referenced exist; every function named in the §4
  cross-reference table was verified by opening the file (`aad`, `buildContext`,
  `expand`, `deriveAll`, `proof`, `serverHandshake`, `clientFinish`,
  `serverVerifyFinish`, `parseClientHello`, `SecureSession.seal/open/iv`).
- The AAD string in `aad()` matches spec §7 exactly (see [§6](#6-aad-construction-call-out)).
- All 7 security test files named in groundwork §5.6 exist, plus 2 more
  (`component-authority.test.ts`, `windows-acl.test.ts`).
- `tests/fixtures/stp-vectors.json` exists with all fields the spec §13 lists.
- ADR 0010's honesty amendment and residual-risk statement are present and quoted faithfully.
- The DoS knob names/defaults in `server.ts` match ADR 0010's residual-risk text.

### DISCREPANCY #1 — Spec section numbering differs from the groundwork's claim
`docs/phase2-groundwork.md` §5 item 1 maps the spec as: *canonical encoding §1, root
secret §2, suite §3, handshake §4, **key schedule §5**, transcript binding §6, **AAD
construction §7**, replay rules §8, uniform errors §9, rotation §10, downgrade §11,
**forward-secrecy §12**, test vectors §13.*

The **actual** `docs/secure-transport-spec.md` numbering at HEAD:
- §0 Layering (membership ≠ authorization) — **the groundwork omits §0 entirely**.
- §1 Canonical encoding · §2 Root secret + key version · §3 Cipher suite · §4 Handshake
  messages · §5 Key schedule · §6 Transcript/downgrade/identity binding · **§7 Encrypted
  frame format (this is where AAD lives)** · §8 Sequence/replay rules · §9 Errors · §10
  Rekey/rotation/restart/close · §11 Downgrade policy · §12 Forward secrecy · §13 Test
  vectors.

**Net effect:** §5 (key schedule), §12 (forward secrecy), §13 (test vectors) line up.
But the groundwork labels AAD as "§7 AAD construction" — in the real spec, AAD is inside
**§7 "Encrypted frame format"** (there is no standalone "AAD construction" heading), and
**§8 is replay rules** (the groundwork agrees), with the encrypted-frame-format content
the groundwork doesn't separately call out. **This packet uses the real spec numbering.**
The §6 checklist call-out in the groundwork (`"XBUS-STP/v1" | connId | direction | seq |
ciphertextLen`) does match the real §7 AAD — only the section *label* was loose.

### DISCREPANCY #2 — Key-schedule wording — RESOLVED (spec reconciled to code)
**Original finding:** Spec §5 prose said `prk = HKDF-Extract(salt = clientNonce|serverNonce,
ikm = rootSecret)` and `K(label) = HKDF-Expand(prk, …)`. The code (`deriveAll`) does **not**
call a bare HKDF-Extract; it calls full `hkdfSync('sha256', rootSecret, salt,
info='XBUS-STP/v1/extract', 32)` to produce `prk`, then a full `hkdfSync` per label
(`expand`). It also hashes `server_hello_core` (proof excluded), not the full
`server_hello_bytes` the §5 prose named.

**Disposition: TERMINOLOGY/SPEC-PROSE was imprecise; the IMPLEMENTATION is correct
and is the source of truth; the TEST VECTORS encode the implementation.** This was proven,
not asserted: an independent re-derivation using only RFC-standard primitives (HMAC for a
bare HKDF-Extract, RFC 5869 Expand) reproduces `derivedKeys.k_c2s_enc` and `transcriptHash`
**byte-for-byte under the code's algorithm only** — the spec-literal bare-Extract reading
yields a *different* key, and the `th`-over-core reading (not full server_hello) is the one
that matches. The construction is cryptographically sound (a salted, domain-separated KDF;
every session key is bound to rootSecret + both nonces + the full transcript hash + the
negotiated identity/version context). **No runtime crypto change was made** — STP is
byte-identical to the previous build. The fix was to **reconcile the §5 prose to the implementation**
(normative notes added for the PRK-as-salted-HKDF-PRF and the `server_hello_core` transcript)
and to mark `tests/fixtures/stp-vectors.json` as the normative §5 regression vectors.
The reviewer is still invited to confirm the security argument for the HKDF-as-PRF PRK, but
the spec/impl/vectors now agree exactly. (See [§5 Step 3](#5-key-schedule-walk-through-traced-against-the-code).)

### DISCREPANCY #3 — Adversarial test count: ADR 0010 / groundwork say "11", file has 15
ADR 0010 ("Cross-user OS test status") and `docs/phase2-groundwork.md` §4 both state the
crypto boundary is *"PROVEN by 11 adversarial tests (tests/security/secure-channel.test.ts)."*
At HEAD, `secure-channel.test.ts` has **15** `it()` blocks: **11 in the `XBUS-STP handshake
+ AEAD` describe block** (these ARE the 11 adversarial tests — the claim is precise *for
that block*) **plus 4** in a second `root secret lifecycle (§9)` describe block (create /
rotation / no-broad-principals / no-silent-regen). So "11 adversarial" is accurate; just
note the file actually contains 15 tests total. Not a defect — a counting nuance a reviewer
might otherwise trip on.

### DISCREPANCY #4 — `SECURITY.md` already exists (groundwork §5 lists it as possibly to-create)
The groundwork §5 checklist's last item reads: *"A private disclosure channel (SECURITY.md)
for findings — not a public issue,"* and the task framing treats it as "note if it exists;
if not, list as a to-create item." **It exists at the repo root** (`SECURITY.md`, present at
HEAD) and is already wired: `docs/security.md` links to `../SECURITY.md`. No to-create item
needed. See [§12](#12-private-disclosure-channel).

### Could-not-fully-verify (honest limits)
- I did **not** execute the test suite (docs-only task, no `npm install`). The "15 tests"
  / "11 adversarial" counts are from static reading of `it()`/`describe()` blocks, not a
  test run. The byte-equality of `derivedKeys` is *asserted by* `stp-vectors-fuzz.test.ts`
  per its source, but I did not run it to confirm a green result at HEAD.
- The recorded `transcriptHash` / `derivedKeys` / `sealedFrame` hex values in the fixture
  were not independently recomputed by hand; a reviewer should re-derive them from the
  primitives as the intended independent check.

---

## 12. Private disclosure channel

`SECURITY.md` exists at the repository root and is the canonical reporting path. Its
instructions (quoted):

> **Please do not open a public issue for a security vulnerability.** Instead, open a
> GitHub Security Advisory (private disclosure) on this repository, or contact the
> maintainers through the private channel listed on the project page.

Stated handling: acknowledge within **5 business days**, remediation timeline after triage;
no formal SLA during the preview. Scope/out-of-scope are enumerated there and mirror
[§1](#1-scope-statement-trust-domain) of this packet. **No new disclosure file needs to be
created.**

---

## 13. Reviewer hand-off checklist

The checklist from `docs/phase2-groundwork.md` §5, with each item resolved to a concrete,
verified section of this packet:

- [x] **Scope statement** — same-machine/same-user trust domain; out of scope (malware-as-you;
      cross-machine; cross-user Windows = unverified). → [§1](#1-scope-statement-trust-domain)
- [x] **The four review asks verbatim** — quoted from `docs/security.md`. → [§2](#2-the-four-review-asks-verbatim)
- [x] **Spec ↔ code cross-reference table** — every row verified against `secure-channel.ts`.
      → [§4](#4-spec--code-cross-reference-table)
- [x] **Key-schedule walk-through** — `rootSecret → prk → per-label K()` traced against
      `deriveAll`/`expand`/`buildContext`, with the HKDF-Extract wording discrepancy flagged.
      → [§5](#5-key-schedule-walk-through-traced-against-the-code), [Discrepancy #2](#discrepancy-2--key-schedule-hkdf-extract-wording-vs-the-actual-hkdfsync-prf)
- [x] **AAD construction call-out** — real `aad()` code quoted; direction-binding rationale.
      → [§6](#6-aad-construction-call-out)
- [x] **No-forward-secrecy justification (§12)** — invite agree/dispute. → [§7](#7-no-forward-secrecy-call-out-12)
- [x] **Custom-protocol caveat (ADR 0010 honesty amendment)** — validate composition, not
      just primitives. → [§8](#8-custom-protocol-caveat-adr-0010-honesty-amendment)
- [x] **Known residual: untrusted-pipe DoS bound (§3)** — real `server.ts` knob names/defaults.
      → [§9](#9-known-residual-untrusted-pipe-dos-bound-3)
- [x] **Repro instructions** — `npm run test:security` + how to read the vectors. → [§10](#10-reproduction-instructions)
- [x] **Private disclosure channel (SECURITY.md)** — exists; not a to-create item. → [§12](#12-private-disclosure-channel)

---

*Packet assembled from artifacts at the tagged release commit. Docs-only — no source files modified.
Discrepancies #1–#4 in [§11](#11-discrepancies--freshness-verification) are the priority
output: a reviewer should treat the spec text vs. code reconciliation (#2) and the spec
section-labeling (#1) as items to settle before or during the engagement.*
