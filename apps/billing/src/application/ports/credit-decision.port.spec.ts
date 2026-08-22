// BC14's type half — a `@ts-expect-error` probe checked by `pnpm typecheck`
// (`tsc --noEmit`, which this file's suppressed error is part of): an
// adapter's `CreditDecision` structurally cannot return `over_limit`. This
// is not something vitest's transpile-only runner can enforce — `tsc` is
// the tool that fails the build if the assignment below ever stops being
// an error.
import { describe, expect, it } from 'vitest';
import type { AdapterRejectionReason, CreditDecision } from './credit-decision.port.js';

describe('credit-decision.port — BC14 type half', () => {
  it('types the port so that over_limit is not a reason an adapter can return', () => {
    // @ts-expect-error — over_limit is the aggregate's own word; an adapter is structurally incapable of claiming it (BC14).
    const illegalReason: AdapterRejectionReason = 'over_limit';

    const legal: CreditDecision = { kind: 'refuse', reason: 'simulated_cents_rule' };

    expect(illegalReason).toBe('over_limit');
    expect(legal.kind).toBe('refuse');
  });
});
