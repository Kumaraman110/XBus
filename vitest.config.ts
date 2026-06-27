import { defineConfig } from 'vitest/config';

export default defineConfig({
  // node:sqlite is a Node built-in; keep it external so Vite doesn't try to
  // resolve/transform it as a source module.
  ssr: { external: ['node:sqlite'] },
  test: {
    server: { deps: { external: [/node:sqlite/] } },
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Live-Claude tests are tagged and excluded from the default run; they are
    // never reported as passed when skipped (see tests/README).
    exclude: ['node_modules/**', 'dist/**', 'spike/**', 'tests/e2e/live/**'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // Integration/IPC/e2e tests touch real sockets, SQLite, and spawn child
    // processes. Use the forks pool (real child processes) so process.execPath
    // and child spawning behave correctly; single-fork to avoid pipe/db
    // contention while staying deterministic.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
  },
});
