// eslint.config.js — Phase 2 §3 ESLint flat-config adoption.
//
// Posture (per docs/phase2-groundwork.md §3): lint for real bugs, do NOT
// re-litigate style, do NOT lose any strictness. TypeScript strict already owns
// strictness; ESLint adds only the correctness checks `tsc` cannot see
// (floating promises, misused promises). NO stylistic/formatting rules, NO
// Prettier — the diff must stay reviewable line-for-line (no mass reformat).
//
// Gate status: this config powers `npm run lint` only. It is NOT yet wired into
// `verify:release` (still reports NOT_CONFIGURED). Flipping that gate is a
// release-line decision the human owns — see docs/eslint-adoption.md.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Type-aware linting requires every linted file to be in the TS project.
  // tsconfig.json's `include` is `src/**/*.ts` only (tests/scripts/docs are
  // deliberately out of the compiled product). Linting files outside that
  // project with `recommendedTypeChecked` yields "file not found in project"
  // parser errors, not code findings. So we ignore the §3 sketch's
  // dist/node_modules/coverage/spike PLUS the non-source trees, scoping the
  // type-aware lint to exactly what the project compiles. Expanding the TS
  // project to cover tests/scripts is a larger, separate change and out of
  // scope for this correctness-only adoption.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'spike/**',
      'tests/**', // not in tsconfig `include`; CommonJS/test harness code
      'scripts/**', // .cjs operational scripts, outside the TS build
      'docs/**', // docs/evidence/**/*.ts samples are outside the TS project
      'examples/**', // standalone synthetic samples (e.g. contract-review); outside the TS project, like docs/**
      'eslint.config.js', // this config; not part of the TS project
      'vitest.config.ts', // tooling config; not in tsconfig `include`
      '.lint-tmp/**', // local lint-triage scratch; never committed
      'src/broker/dashboard/static/**', // beta.5 inert browser UI (vanilla JS/HTML/CSS) — a
      // dashboard CLIENT, not part of the compiled TS product (tsconfig include is *.ts), so
      // the type-aware parser can't project it. It ships as static assets, verified by its
      // own integration test (dashboard-ui.test.ts: no inline script, no forbidden APIs).
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked, // type-aware, mirrors tsconfig strictness
  {
    languageOptions: { parserOptions: { project: './tsconfig.json' } },
    rules: {
      // Catch what tsc does not: floating promises, misused await/promise.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // redaction.ts legitimately matches C0 controls (the CWE-117 sanitizer);
      // honor the author's existing eslint-disable intent globally.
      'no-control-regex': 'off',
      // Do NOT add stylistic/formatting rules — no mass reformat. Prettier is
      // out of scope; the diff must stay reviewable line-for-line.
    },
  },
);
