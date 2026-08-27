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
    include: ['app/**/*.spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
