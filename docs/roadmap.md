# Roadmap

XBus is a Public Developer Preview. This is what's done, what's next, and what
we're explicitly asking for help with.

## Done (preview)

- Durable broker (`node:sqlite`/WAL), exact recipient resolution, offline queue,
  crash + reconnect + broker-restart recovery.
- Layered identity (logical session → epoch → component) with connection-bound,
  non-bearer authority and a one-time receipt ledger.
- **XBUS-STP** secure transport on every broker/client path (mutual auth,
  per-frame AES-256-GCM, replay/reorder rejection); resource-pressure hardened.
- **Model-visible duplicate prevention** (§1) — body shown once, explicit audited
  redelivery only.
- **Explicit readiness model** (§2) — connection / receive-mode / readiness as
  separate dimensions; no injection into a not-ready receiver.
- **Reliability reaper** (§4) — ack-timeout, acceptance-TTL, lease reclamation,
  fairness cap.
- Benchmarks over the encrypted transport (§5); isolated Windows packaging (§7);
  clean-profile lifecycle (§8); public docs (§9).

## Next

- **macOS / Linux runtime validation.** Implemented, needs real-platform proof.
- **Cross-user Windows validation.** The same-user boundary is proven; cross-user
  is unverified (needs a second-account environment).
- **Live `live`-push delivery** where a provider supports idle wake (beyond
  Bedrock checkpoint mode).
- **Independent security review** of XBUS-STP and the threat model.
- **Real installer + code signing.** The package is verifiable (checksums, SBOM);
  a signed installer is a release-time step not yet done.
- **Observability surface** — structured, body-free operational metrics.

## We are requesting review of

1. The XBUS-STP protocol spec, key schedule, and AAD construction.
2. The same-machine/same-user threat model and the no-forward-secrecy justification.
3. The Windows IPC decision (crypto boundary vs OS-ACL / .NET proxy — ADR 0010).
4. The delivery semantics framing (at-most-once injection, not exactly-once
   execution) — is it stated honestly and usefully?

## Non-goals (for now)

- A cross-machine / networked bus (XBus is deliberately same-machine).
- A sandbox against malware running as your own privileged user.
- Exactly-once *execution* guarantees (see
  [delivery-semantics.md](delivery-semantics.md)).
