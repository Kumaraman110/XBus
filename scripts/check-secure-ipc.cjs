#!/usr/bin/env node
/*
 * §3 CI guard: no production source may directly create a raw socket server/
 * connection or use the plaintext transport outside the approved secure-transport
 * implementation files. Fails (exit 1) on a new violation.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');
// The ONLY files permitted to touch raw sockets / framing directly — the secure
// transport implementation itself + the reachability probe.
const ALLOW = new Set([
  path.join('ipc', 'server.ts'),       // SecureIpcServer impl
  path.join('ipc', 'client.ts'),       // SecureIpcClient impl
  path.join('ipc', 'singleton-probe.ts'),
  path.join('broker', 'singleton.ts'), // probeExisting: connect-then-destroy reachability check (no frames)
  path.join('ipc', 'framing.ts'),      // the frame codec itself
  path.join('ipc', 'transport.ts'),    // endpoint helpers + net type re-export
  path.join('ipc', 'secure-channel.ts'),
]);

const FORBIDDEN = [
  /\bnet\.createServer\b/,
  /\bnet\.createConnection\b/,
  /\bnew net\.Socket\b/,
];

const violations = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!e.name.endsWith('.ts')) continue;
    const rel = path.relative(SRC, full);
    if (ALLOW.has(rel)) continue;
    const text = fs.readFileSync(full, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const re of FORBIDDEN) {
        if (re.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
}
walk(SRC);

if (violations.length) {
  console.error('FORBIDDEN raw-socket / plaintext-transport usage in production source:');
  for (const v of violations) console.error('  ' + v);
  console.error('\nAll IPC must go through SecureIpcServer/SecureIpcClient. If this is a');
  console.error('legitimate secure-transport implementation file, add it to ALLOW.');
  process.exit(1);
}
console.log('check-secure-ipc: OK — no forbidden raw-socket usage outside the secure transport module.');
process.exit(0);
