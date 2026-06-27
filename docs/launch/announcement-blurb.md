# Short launch blurbs

Reusable, honest short-form copy for the GitHub Release summary, a changelog
pointer, and social/mailing-list one-liners. All carry the preview framing; none
overstate guarantees.

---

## One-liner (<= 140 chars)

```
XBus: a durable, local message bus so independent Claude Code sessions on one machine can discover each other and talk. Preview.
```

## GitHub Release summary (top of the v0.1.0-beta.2 release)

> **XBus v0.1.0-beta.2 — Public Developer Preview (pre-release).**
> First public artifact. A durable, same-machine message bus that lets
> independent Claude Code CLI sessions discover each other and exchange messages
> (send → checkpoint deliver → ack → correlated reply) over a custom secure
> transport (XBUS-STP) with a SQLite/WAL durable store.
>
> Honest scope: not production-ready; Windows-first (macOS/Linux implemented, not
> yet runtime-validated); same-machine/same-user only (not a malware sandbox);
> Bedrock = checkpoint delivery, no idle-wake; at-most-once context presentation,
> **not** exactly-once execution; XBUS-STP internally reviewed, **not**
> independently audited. We're explicitly requesting protocol + threat-model
> review.
>
> Full notes: docs/launch/RELEASE_NOTES_v0.1.0-beta.2.md · License: MIT.

## Two-sentence project description (for a profile/awesome-list)

> A local-first, durable message bus that lets independently-launched Claude Code
> CLI sessions on one machine coordinate: discovery, exact routing,
> acknowledgements, correlated replies, an offline queue, and crash recovery, all
> over an encrypted local transport. Public Developer Preview — Windows-first,
> same-machine/same-user, not independently audited.

## Mastodon / social (<= 280 chars)

```
Open-sourced XBus: a durable, local message bus so independent Claude Code
CLI sessions on one machine can discover each other, send, ack, and reply. Public
Developer Preview — Windows-first, same-machine, not independently audited.
Feedback on the protocol welcome. MIT.
```

---

### Provenance line (append where a longer bio fits)

Architecture, verification gates, and release decisions directed by the
creator/maintainer, Aman Kumar; AI agents used extensively for design,
implementation, review, and testing. No independent human security audit.
