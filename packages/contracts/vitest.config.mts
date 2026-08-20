import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    // Several `scripts/*.spec.ts` files spawn the real CLI
    // (`tsx scripts/generate.mts` / `scripts/check.mts`) against the actual
    // `src/generated/*.ts` files on disk, by design — that is what proves
    // the exact command `pnpm contracts:generate` / `pnpm contracts:check`
    // runs, not just the function it calls. Running test files in parallel
    // (Vitest's default) would let those processes race each other on the
    // same files; sequential file execution is the correct trade-off for a
    // handful of fast spec files, not a workaround for a flaky test.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Generated code is not hand-written glue and is deliberately excluded
      // from the coverage gate (CLAUDE.md § Testing conventions — "do not
      // chase coverage numbers on generated code"). The gate applies to the
      // generator scripts and the hand-written barrel only.
      include: ['scripts/**/*.mts', 'src/index.ts'],
      exclude: ['src/generated/**', '**/__fixtures__/**', '**/*.spec.ts'],
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});
