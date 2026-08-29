import { defineVitestConfig } from '@nuxt/test-utils/config';

// Component tests for this Nuxt 4 app. `environment: 'nuxt'` boots a real
// (mocked-server) Nuxt runtime inside Vitest so page/component SFCs that
// rely on Nuxt auto-imports (`definePageMeta`, `$fetch`, `useState`, ...)
// work exactly as they do in the real app, without hand-rolling stubs for
// each one — the standard setup `@nuxt/test-utils` itself documents for
// Nuxt 3/4 component tests.
export default defineVitestConfig({
  test: {
    environment: 'nuxt',
    // `server/**` specs (the streaming-proxy forwarding tests) are
    // deliberately framework-free — no Nitro auto-imports, real local HTTP
    // servers instead of Nuxt's own — and override this file's default
    // environment back to plain `node` per-file via a `// @vitest-environment
    // node` docblock, since they need neither happy-dom nor Nitro's mocked
    // runtime, only a real `fetch`.
    include: ['app/**/*.spec.ts', 'server/**/*.spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Enforced since phase 21 (sonarqube_quality_gates): root `pnpm
      // quality` now chains `test:coverage` (root package.json), which runs
      // `vitest run --coverage` here, so this 60% floor is a live gate on
      // that invocation, not a dormant number. `vitest run` (the default
      // `test` script) still does not compute coverage at all — only
      // `test:coverage` does — so thresholds only fail *that* invocation,
      // same as every other workspace.
      thresholds: {
        lines: 60,
        statements: 60,
        branches: 60,
        functions: 60,
      },
    },
  },
});
