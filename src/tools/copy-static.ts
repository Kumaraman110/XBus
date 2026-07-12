/**
 * Copy non-TS static assets into dist/ after `tsc` (which only emits compiled JS).
 * Currently: the dashboard's vanilla UI (`src/broker/dashboard/static` →
 * `dist/broker/dashboard/static`). Run from `postbuild`. Idempotent; overwrites.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function copyDir(src: string, dst: string): number {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else { fs.copyFileSync(s, d); n += 1; }
  }
  return n;
}

function main(): void {
  // dist/tools/copy-static.js → repo root is two levels up.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const pairs: Array<[string, string]> = [
    [path.join(repo, 'src', 'broker', 'dashboard', 'static'), path.join(repo, 'dist', 'broker', 'dashboard', 'static')],
  ];
  let total = 0;
  for (const [src, dst] of pairs) {
    if (!fs.existsSync(src)) continue;
    total += copyDir(src, dst);
  }
  process.stdout.write(`copied ${total} static asset(s) into dist/\n`);
}

main();
