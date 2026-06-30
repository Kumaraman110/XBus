import { defineConfig } from 'vitest/config';

export default defineConfig({
  // node:sqlite is a Node built-in; keep it external so Vite doesn't try to
  // resolve/transform it as a source module.
  ssr: { external: ['node:sqlite'] },
  test: {
    server: { deps: { external: [/node:sqlite/] } },
    globals: true,
    environment: 'node',
    // §6/§8: force the fake-claude requirement, clear inherited Claude env, and
    // allow the dev suite to run on an unsupported Node (the clean-machine gate runs
    // on a supported Node without the bypass).
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Live-Claude tests are tagged and excluded from the default run; they are
    // never reported as passed when skipped (see tests/README).
    exclude: ['node_modules/**', 'dist/**', 'spike/**', 'tests/e2e/live/**'],
    // A real Windows install copies the full plugin (hundreds of files) + per-file
    // checksum verification + icacls hardening. On a fast host that is ~15-20s, but on
    // a slow/contended runner or a deep temp path it has been observed at 60-90s. The
    // timeout must clear the SLOW case or install-heavy tests flake — verified on a
    // portable Node 22/24 runner where 45s flaked but 120s passes 382/382. Set well
    // above the worst observed install so a genuine install is never a false timeout.
    testTimeout: 120000,
    hookTimeout: 120000,
    // Integration/IPC/e2e tests touch real sockets, SQLite, and spawn child
    // processes. Use the forks pool (real child processes) so process.execPath
    // and child spawning behave correctly; single-fork to avoid pipe/db
    // contention while staying deterministic. (Vitest 4 removed poolOptions;
    // forks single-fork is now expressed as max/minForks=1 + fileParallelism:false.)
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
