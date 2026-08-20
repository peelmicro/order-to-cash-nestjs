// Domain ↔ Drizzle schema parity. Lives in `infrastructure/` on purpose
// (design.md §3): a `domain/` test may not import `infrastructure/` (the
// ESLint domain-purity rule forbids it), but this direction — infrastructure
// importing the domain's closed type as the source of truth — is exactly
// the layering `orders.schema.ts`'s own header comment describes.
import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '../../../domain/order-status';
import { ORDER_STATUS_VALUES } from './orders.schema';

describe('orders.schema — ORDER_STATUS_VALUES tracks the domain ORDER_STATUSES', () => {
  it('the schema-side status value set equals the domain-owned ORDER_STATUSES set, in the same order', () => {
    expect(ORDER_STATUS_VALUES).toEqual(ORDER_STATUSES);
  });
});
