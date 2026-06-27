# ADR 0010 — Windows named-pipe security (cryptographic boundary + DoS bound)

**Status:** Accepted · **Date:** 2026-06-25 · Release blocker per reliability contract §1–4.

## Threat model
- **Asset:** the broker IPC endpoint (Windows named pipe / Unix domain socket).
- **Boundary:** same OS user is the trust domain; other local users and remote
  clients are OUT. On Windows, Node's `net` pipe uses the **default** security
  descriptor, which may grant access beyond the intended user — so the pipe must
  be treated as **untrusted** until authenticity is established.
- **Adversaries:** another local OS user; an unprivileged process that knows or
  guesses the pipe name; a passive/active on-pipe attacker (replay/tamper).
- **NOT in scope:** a malicious process running as the SAME fully-privileged user
  (it can read the data dir, the secret, and Claude config regardless — same-user
  software cannot sandbox that; see security boundary doc).

## Options evaluated (both prototyped + verified)
**Design A — secure native pipe (.NET `NamedPipeServerStreamAcl`).** Verified: a
pipe with exactly `S-1-5-18` (SYSTEM) + current-user SID, no Everyone/Authenticated
Users — OS-enforced. **Cost:** Node cannot create a secured pipe, so A requires a
separate **.NET process** (pipe-proxy → Node broker) or a broker rewrite. That adds
a .NET runtime dependency to every install, a second process, frame-forwarding, and
version coordination — directly violating the offline/no-extra-runtime packaging
contract and "don't duplicate the broker."

**Design B — cryptographic boundary (pure Node, pinned runtime).** Pipe = untrusted
transport. Per-install 256-bit root secret in the ACL-restricted data dir; mutual
nonce challenge-response; HKDF-SHA256 per-connection keys; AES-256-GCM per frame;
independent send/recv sequence numbers with replay+reorder rejection; uniform
auth-failure (no oracle); rotation invalidates old keys. Only Node built-ins
(`hkdfSync`, `createCipheriv` aes-256-gcm, `timingSafeEqual`) — no custom crypto.

## Decision: **Design B + connection DoS bound.**
**One reason:** B is the only option satisfying BOTH byte-level authenticity/
integrity AND the no-extra-runtime packaging contract — A's OS ACL cannot be created
from Node and forces a .NET process, which the spec's own selection rule routes to B
("native integration materially complicates/duplicates the broker"). B is *also*
stronger on authenticity: A authenticates only who may CONNECT; B authenticates
every byte and rejects replay/tamper/reorder, which a plain pipe does not.

### Residual risk (named + bounded, honest)
B does NOT restrict who may *open* a pipe connection, so an unauthenticated client
can connect and force handshake work (DoS). **Bounded by:** `maxConnections` cap,
per-connection idle/handshake timeout (silent connections dropped), a global
buffered-byte budget, and a **connect-rate token bucket** (`connectRatePerSec`,
default 50/s). An attacker cannot exhaust memory or starve real clients; the
residual is bounded compute on rejected handshakes, documented and accepted.

### Hybrid note
A *full* hybrid (restrictive pipe ACL + app-auth) is "strongest" per the spec but
re-incurs Design A's .NET dependency to set the ACL (pipes aren't filesystem-ACL
targets reachable from Node). So the **practical** choice that preserves packaging
is B; Design A is recorded as the future OS-enforced upgrade IF a .NET runtime
dependency ever becomes acceptable. On **Unix**, the UDS already sits in a 0700 dir
(OS-enforced) AND gets the Design-B crypto — effectively the hybrid for free.

## Cross-user OS test status
Scenarios requiring a second real Windows account are **BLOCKED** in this
environment (no admin to create a user). The cryptographic boundary that makes
pipe-name knowledge insufficient WITHOUT the installation secret is PROVEN by 11
adversarial tests (tests/security/secure-channel.test.ts). Per the contract, the
Windows build is therefore **development-grade for cross-user OS authorization**
until cross-user execution is verified on a multi-account host.

## Honesty amendment — Design B is a CUSTOM PROTOCOL (not just standard primitives)
AES-256-GCM, HKDF-SHA256, and HMAC-SHA256 are standard, well-reviewed **primitives**.
But the XBus **handshake, transcript construction, key schedule, frame format, replay
rules, and rotation behavior** form an **XBus-specific protocol**. Therefore:
- "No custom cipher / no custom MAC" is **accurate**.
- "No custom crypto protocol" is **NOT accurate** — we composed one.
- A composed protocol is **not automatically secure** because its primitives are
  standard. It requires: an explicit normative specification (docs/secure-transport-spec.md),
  deterministic **test vectors**, and **adversarial review** (reflection/downgrade/
  identity-substitution/nonce-reuse/transcript-binding). These are mandatory before the
  live transport is wired and before any release claim.

## Consequences
- `src/ipc/secure-channel.ts` (handshake + AEAD), `src/ipc/root-secret.ts` (storage
  + rotation), connect-rate bound in `src/ipc/server.ts`.
- The v1 primitive prototype is being **rebuilt to the normative spec** (transcript
  binding, full key schedule, AAD headers, downgrade resistance) before live wiring.
- Wiring the secure channel into EVERY live IPC path (no plaintext privileged fallback)
  is the integration step that resolves the blocker.
