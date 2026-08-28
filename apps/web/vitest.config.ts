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
      // Numbers wired now per CLAUDE.md; not enforced-failing until phase 21
      // (sonarqube_quality_gates) — `vitest run` (the default `test` script)
      // does not compute coverage at all, only `test:coverage` does, and
      // thresholds only fail *that* invocation.
      thresholds: {
        lines: 60,
        statements: 60,
        branches: 60,
        functions: 60,
      },
    },
  },
});
