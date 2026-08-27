// Makes `@testing-library/jest-dom`'s matcher types (`toBeDisabled`,
// `toHaveTextContent`, ...) visible to `nuxi typecheck`'s program — the
// runtime registration itself happens in `vitest.setup.ts`, loaded once via
// `vitest.config.ts`'s `test.setupFiles`. This file just needs to be part
// of the same TS program as the `.spec.ts` files that use those matchers.
import '@testing-library/jest-dom/vitest';
