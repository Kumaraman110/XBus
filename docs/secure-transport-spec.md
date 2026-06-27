# XBus Secure Transport Protocol — normative specification

**Protocol id:** `XBUS-STP`  ·  **Version:** `1`  ·  Status: normative (the implementation MUST match this).

The named pipe / UDS is an **untrusted byte transport**. This protocol provides
mutual installation-membership authentication, confidentiality, integrity, replay/
reorder rejection, and downgrade/identity-substitution resistance, using only
pinned-runtime primitives (AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG).

## 0. Layering (membership ≠ authorization)
- **L1 membership** (this protocol): proves knowledge of the installation root secret.
- **L2 component registration**: establishes component instance + role (XBus app proto).
- **L3 session authorization**: binds component to session + epoch.
- **L4 operation authorization**: the component capability matrix.
L1 success authorizes NOTHING beyond "same-installation member". Roles/sessions are
enforced by L2–L4 over the encrypted channel.

## 1. Canonical encoding
All handshake fields use **canonical length-prefixed binary** (NOT JSON):
- integers: unsigned big-endian, fixed width as specified;
- byte strings: `uint16 length` + bytes;
- UTF-8 strings: encoded as byte strings of their UTF-8 bytes.
The **transcript** is the exact concatenation of the canonical encodings of the
handshake messages in order (§4). Hashes are computed over these bytes — never over
JSON stringification.

## 2. Root secret + key version
- `rootSecret`: 32 bytes CSPRNG. Stored only in the ACL-restricted data dir.
- `keyVersion`: uint32, incremented on rotation. Non-secret; identifies which root
  secret is in force. Sent in the clear in `client_hello`/`server_hello`.

## 3. Cipher suite
- `SUITE_AES256_GCM = 0x0001`. AES-256-GCM, 96-bit nonce, 128-bit tag.
- A client offers a set of suite ids; the broker selects one. The selected suite is
  transcript-bound (§6), so a downgrade alters the transcript and fails the proofs.

## 4. Handshake messages (canonical binary)

```
client_hello = magic("XBUS-STP") | u8 stpVersion | u32 keyVersion
             | u16[] offeredSuites | bytes(32) clientNonce
             | bytes connId(16)                 // client-chosen connection id
             | bytes buildId | bytes appProtoRange
             | bytes claimedRole | bytes claimedSessionId? | u32 claimedEpoch?
             | bytes capabilities

server_hello = u8 stpVersion | u32 keyVersion | u16 selectedSuite
             | bytes(32) serverNonce | bytes brokerInstanceId
             | bytes serverProof(32)

client_finish = bytes clientProof(32)
server_ack    = u8 ok | (on success) begins encrypted frames
```

A field present in `client_hello` but altered later in the encrypted stream is
rejected, because all of `keyVersion, selectedSuite, clientNonce, serverNonce,
connId, brokerInstanceId, buildId, appProtoRange, claimedRole, claimedSessionId,
claimedEpoch, capabilities` are bound into the transcript and the key schedule (§5,§6).

> **Identity note (non-normative; ADR 0011).** The wire field named `buildId` above
> carries the STABLE **`wireCompatibilityId`** — the compatibility tuple
> `xbus-p<proto>-stp<stp>-s<schema>` (e.g. `xbus-p1-stp1-s5`), which is deliberately
> **version-independent**. It is **NOT** the exact artifact identity of a build. Its
> byte layout, position, and role in the transcript/key schedule are **unchanged** by
> ADR 0011 — the rename is documentation-only; the bytes and the test vectors (§13)
> are identical. Exact artifact identity (`productVersion` / exact `buildId` /
> `sourceCommit`) is **not** carried on the wire here; it rides in **authenticated,
> post-handshake registration** over the established encrypted channel. Binding the
> compatibility tuple (rather than the exact id) is intentional: it lets builds that
> share a protocol/STP/schema tuple interoperate while a substitution of the tuple
> still fails the proofs (§6).

## 5. Key schedule (HKDF-SHA256, explicit labels, one key per purpose)
```
server_hello_core = u8 stpVersion | u32 keyVersion | u16 selectedSuite
                      | bytes(32) serverNonce | bytes brokerInstanceId   // server_hello WITHOUT serverProof
transcript        = client_hello_bytes | server_hello_core   // through server_hello, proof EXCLUDED
th                = SHA256(transcript)
prk               = HKDF-SHA256(ikm = rootSecret, salt = clientNonce | serverNonce,
                                info = "XBUS-STP/v1/extract", L = 32)   // full HKDF used as a salted, domain-separated PRF
context           = th | brokerInstanceId | connId | claimedRole
                       | claimedSessionId | u32 claimedEpoch | buildId
                       | u16 selectedSuite | u8 stpVersion
K(label)          = HKDF-SHA256(ikm = prk, salt = "", info = "XBUS-STP/v1/" | label | context, L)
```
> **Normative note (PRK derivation).** The `prk` is produced by a *full* HKDF-SHA256
> call (RFC 5869 Extract-then-Expand) over `rootSecret`, salted with
> `clientNonce | serverNonce` and domain-separated by `info = "XBUS-STP/v1/extract"` —
> i.e. HKDF is used here as a salted PRF to mix the long-lived root secret with the
> two connection nonces, NOT as a bare HKDF-Extract step. Each `K(label)` is likewise
> a full HKDF-SHA256 call keyed by `prk` (empty salt) with a per-purpose `info`.
> This is the construction the implementation (`secure-channel.ts` `deriveAll`/`expand`)
> and the test vectors (`tests/fixtures/stp-vectors.json`) encode; an independent
> re-derivation reproduces `derivedKeys` byte-for-byte. The security goal is unchanged:
> every session key is bound to `rootSecret`, both nonces, the full transcript hash,
> and the negotiated identity/version context.
>
> **Normative note (transcript).** `th` is taken over `server_hello_core` — the
> `server_hello` message **excluding** the trailing `serverProof(32)` — because the
> proof is computed over `th` and therefore cannot be part of the hashed input.

Derived keys (independent, distinct labels — NEVER reused across purposes):
```
k_c2s_enc   = K("c2s-enc", 32)     // client→broker AES-256 key
k_s2c_enc   = K("s2c-enc", 32)     // broker→client AES-256 key
k_c2s_iv    = K("c2s-iv", 12)      // client→broker fixed nonce base
k_s2c_iv    = K("s2c-iv", 12)      // broker→client fixed nonce base
mk_client   = K("client-proof", 32)
mk_server   = K("server-proof", 32)
```
Proofs:
```
serverProof = HMAC(mk_server, "server-finished" | th)
clientProof = HMAC(mk_client, "client-finished" | th)   // th includes server_hello
```
Distinct `"server-finished"`/`"client-finished"` labels + distinct keys make a
**reflection** of one proof as the other fail (§ adversarial 1/2).

## 6. Transcript / downgrade / identity binding
Because `selectedSuite`, `stpVersion`, `keyVersion`, role/session/epoch, buildId, and
capabilities are all in `context` (and the proofs are over `th`), any of:
suite downgrade, version change, capability/role/session/epoch substitution, or
build-id change → a different `context` → different keys → proof verification fails.
Fail closed.

> **Identity note (non-normative; ADR 0011).** Here `buildId` is the stable
> `wireCompatibilityId` (the §4 compatibility tuple), so a substitution of the
> *compatibility* tuple alters `context` and fails the proofs. Exact artifact identity
> is deliberately **not** part of `context` — it is a diagnostic fact exchanged in
> authenticated post-handshake registration, never an input to authentication. This
> note adds no normative requirement.

## 7. Encrypted frame format
```
frame = u32 seq | bytes(12) iv | bytes(16) tag | ciphertext
iv    = ivBase XOR (u32 0...0 | u64 seq)        // per-direction ivBase + counter
aad   = "XBUS-STP/v1" | connId | u8 direction | u32 seq | u32 ciphertextLen
```
- `direction`: 1 = c2s, 2 = s2c (bound in AAD so a c2s frame replayed s2c fails).
- `seq`: starts at 0 per direction, strictly increments. Reorder/duplicate/skip → reject.
- Plaintext is NEVER processed before GCM tag verification.
- `MAX_PLAINTEXT = 1 MiB`; declared/total over limit → reject before allocation.
- **seq overflow** (approaching 2^32): the connection is closed before reuse; the
  client must reconnect (fresh nonces → fresh keys).

## 8. Sequence / replay rules
- duplicate seq → `REPLAY` (close).
- seq < expected → `REPLAY_OR_REORDER` (close).
- seq > expected (skip) → **reject + close** (XBus uses an ordered stream; no gaps).

## 9. Errors (uniform, no oracle)
All membership/auth failures (wrong secret, bad proof, reflected proof, downgrade,
identity mismatch) surface as a SINGLE `AUTH_FAILED` with no distinguishing detail,
to avoid an identity/existence oracle. Pre-auth, the broker reveals NO session/alias
existence. Endpoint/occupancy errors are typed (`XBUS_ENDPOINT_OCCUPIED`,
`XBUS_BROKER_AUTH_FAILED`, `XBUS_STALE_ENDPOINT`).

## 10. Rekey / rotation / restart / close
- **reconnect / broker restart**: fresh nonces ⇒ fresh keys (no key survives a connection).
- **secret rotation**: new `keyVersion`; broker stops accepting old-key handshakes per
  policy; existing channels closed; clients reconnect with new version; no indefinite
  dual-key window.
- **close**: either side may close; seq state is per-connection and discarded.

## 11. Downgrade policy
Only `stpVersion=1` / `SUITE_AES256_GCM` exist in v1. A peer offering only unknown
versions/suites → typed `PROTOCOL_MISMATCH` (no silent downgrade). When future suites
exist, the selected suite is transcript-bound so a MITM cannot force a weaker one.

## 12. Forward secrecy
**Design B does NOT provide forward secrecy** (keys derive from the long-lived root
secret + nonces; no ephemeral DH). Documented consequence:
> A later compromise of the installation root secret may allow decryption of
> previously recorded XBus traffic if an attacker captured the encrypted frames and
> handshake material.
Against the actual threat model (same-machine, same-user trust domain; an attacker who
can read the root secret already has the user's full context and can read the data dir
and Claude config directly), recording-then-later-compromise adds little: the root-
secret compromise itself is already game-over for a same-user attacker. Therefore FS is
**not added** in v1 (no X25519). Revisit if a cross-machine transport is ever introduced.

## 13. Test vectors
`tests/fixtures/stp-vectors.json` holds deterministic non-production vectors (root test
key, nonces, transcript bytes + hash, HKDF inputs, derived keys, iv bases, AAD,
plaintext, ciphertext, tag, expected-reject cases). The test key is NEVER used in
production. Vectors must be stable across supported packaged runtimes.

These vectors are the **normative regression vectors** for the §5 key schedule: they
encode the construction described in §5 (PRK = salted domain-separated HKDF-PRF of the
root secret; `th` over `server_hello_core`). An independent re-derivation using only
RFC-standard primitives reproduces `transcriptHash` and every entry of `derivedKeys`
byte-for-byte; the spec-prose-literal "bare HKDF-Extract" reading does NOT, which is why
§5 was reconciled to the implementation. `stp-vectors-fuzz.test.ts` asserts the
running code matches these vectors on every packaged runtime.
