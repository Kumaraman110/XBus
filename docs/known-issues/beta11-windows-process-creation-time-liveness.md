# Known issue — Windows process-creation-time liveness probe (beta.11 RC qualification item)

**Status:** OPEN — release-candidate qualification item. **Not a beta.11 regression.**
**Affects:** the final `verify:release` local run only (integration shard). **Discovered:** beta.11 RC
qualification, 2026-07-22.

## Symptom
`tests/integration/broker-shutdown.test.ts` › *"1. valid running broker → IPC graceful shutdown works"*
fails on this developer Windows machine:

```
AssertionError: expected 'refuse' to be 'ipc'
Expected: "ipc"
Received: "refuse"
  at tests/integration/broker-shutdown.test.ts:46:29   (expect(decision.action).toBe('ipc'))
```

## Root cause (environmental, not code)
`classifyShutdown()` (`src/broker/state-file.ts`) calls `classifyLiveness()`
(`src/broker/liveness-proof.ts`), whose primary arm reads the **OS process-creation-time** of the
broker PID. On Windows that read is `powershell Get-Process -Id <pid> … StartTime`. When that read is
slow/unavailable/times out on a loaded machine, `classifyLiveness` returns **`INCONCLUSIVE`**, and
`classifyShutdown` correctly **fails closed → `refuse`** (never signal a PID it cannot prove is our
broker — ADR 0007 "no unrelated process is ever killed"). The test expects `ipc` (proven-live →
graceful IPC shutdown), so it fails on the environment, not on a logic defect.

## Proof it is pre-existing (NOT introduced by beta.11)
| | SHA | Result (isolation, node22) |
|---|---|---|
| beta.10 base | `1a00fffe22a7966a257214c64a9db45f97f3d52f` | **FAIL** — `'refuse' != 'ipc'`, 1/12 |
| beta.11 candidate | `ee22cb17d5dfd1bb91fe8dd7f3626a9af6692b81` | **FAIL** — `'refuse' != 'ipc'`, 1/12 (identical) |

Relevant files are **byte-identical** between base and candidate (`git diff` empty; blob hashes equal):
- `tests/integration/broker-shutdown.test.ts` — `8d401dc9…`
- `src/broker/liveness-proof.ts` — `76cc2592…`
- `src/broker/state-file.ts` (classifyShutdown) — `fdff563c…`

Classified **`LOCAL_ONLY`** in `tests/integration-scope.ts:89` ("Recycled-PID / process-creation-time
liveness classification (definitional exclusion)") → **excluded from hosted CI by design**; the
hosted-safe integration run was **367 passed / 0 failed**, and beta.10 shipped green because its
CI/clean-machine environment reads process-creation-time reliably.

## Disposition (hard rules)
1. **Does NOT block pushing a review ref** for beta.11 — it is pre-existing and outside beta.11's changes.
2. **BLOCKS `RELEASE_READY`** until a clean-machine binding run of the full `verify:release` (where the
   process-creation-time probe resolves) passes 15/15. Reliability's binding run is the gate.
3. **Fail-closed liveness behavior MUST NOT be weakened** to make this machine green — `refuse` on an
   inconclusive liveness read is the correct, safety-critical behavior (never signal an unprovable PID).
   Do not lower the assertion, add a bypass, or relax `classifyLiveness`.
4. **Any future fix requires its own RED-first tests + review** — e.g. hardening the Windows
   creation-time read (retry/longer bound/alternate source) or the test harness's environment
   assumptions, proven with a failing-first test, reviewed independently. Not in beta.11 scope.

## Cross-refs
- ADR 0007 (shutdown classification — no unrelated process ever killed)
- `reference_agentel_beta10_fullsuite_flakes` (this "refuse" condition was previously noted; RC
  qualification now proves it fails even in isolation on this box → environmental, not contention).
