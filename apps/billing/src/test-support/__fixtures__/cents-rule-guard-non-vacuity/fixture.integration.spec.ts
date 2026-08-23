// A synthetic fixture, deliberately un-opted-in, used ONLY by
// cents-rule-fixture-guard.spec.ts's "non-vacuity" case to prove the
// text-scan half of the guard genuinely fires — the guard is pointed at
// THIS directory directly, never at the real src tree, for that one case.
// Excluded from the real scan (`__fixtures__` is a skipped directory name
// in cents-rule-fixture-guard.ts's own walk) so it never pollutes the
// "every billing integration spec" assertion. Carries one trivial,
// container-free test so `pnpm test:integration`'s file-glob picking this
// file up (it matches `*.integration.spec.ts`) never reports "no test
// suite found in this file".
import { describe, expect, it } from 'vitest';

describe('cents-rule-guard-non-vacuity fixture', () => {
  it('is a harmless placeholder test, not a real integration test', () => {
    expect(true).toBe(true);
  });
});

const request = { orderReference: 'ORD-000001', amount: { amount: 24_999, currency: 'EUR' } };
void request;
