# Benchmarks

XBus is a **local, same-machine** bus; the performance objective is
"imperceptible to an interactive Claude Code session", not network throughput.
All numbers are measured over the **encrypted** transport (XBUS-STP).

## Objectives

| # | Objective (local, secure transport) | Target |
|---|--------------------------------------|--------|
| O1 | Handshake (connect + full mutual auth) | p95 < 150 ms |
| O2 | Send round-trip (encrypted) | p95 < 50 ms |
| O3 | Inbox round-trip (encrypted) | p95 < 50 ms |
| O4 | Sustained send throughput (single client) | > 200 msg/sec |

## Measured (dev machine)

| # | Measured | Margin |
|---|----------|--------|
| O1 | p95 **3.5 ms** | ~42× under |
| O2 | p95 **3.4 ms** | ~15× under |
| O3 | p95 **5.7 ms** | ~9× under |
| O4 | **427 msg/sec** | ~2× over |

All four objectives met with margin — encryption is not a bottleneck.

## Run it yourself

```
npm run build && npm run bench          # human-readable
npm run bench -- --json                 # machine-readable
```

These are single-dev-machine indicative numbers, not a cross-hardware benchmark
suite — they will vary with hardware, OS, and Node version. The regression guard
that keeps the encrypted transport within its objectives lives in
[`tests/integration/perf-objectives.test.ts`](../tests/integration/perf-objectives.test.ts),
and the benchmark itself is
[`src/tools/secure-transport-bench.ts`](../src/tools/secure-transport-bench.ts).
