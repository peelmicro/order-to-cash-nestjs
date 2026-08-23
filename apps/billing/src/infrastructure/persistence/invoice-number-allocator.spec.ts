// Pure unit — `BI12`'s formatting half. `DrizzleInvoiceNumberAllocator.next`
// delegates ALL formatting to `InvoiceReference.fromSequence`
// (`@otc/shared-kernel`) — there is no local parse/format helper of its own
// to unit-test in isolation (mirrors `apps/orders/.../order-number-allocator.spec.ts`'s
// role, adjusted: that allocator owns its own `parseOrderNumberSequence`,
// this one does not, so this spec pins the SAME formatting contract at the
// call site the allocator actually uses). The concurrency-safe allocation
// itself needs a real transaction/row-lock and is proven by
// `invoice-number-allocator.integration.spec.ts` (Testcontainers).
import { InvoiceReference } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';

describe('DrizzleInvoiceNumberAllocator — BI12 formatting half', () => {
  it('formats the sequence as INV- and six padded digits', () => {
    expect(InvoiceReference.fromSequence(1).value).toBe('INV-000001');
    expect(InvoiceReference.fromSequence(6).value).toBe('INV-000006');
    expect(InvoiceReference.fromSequence(123456).value).toBe('INV-123456');
  });

  it('refuses a non-positive or non-integer sequence — the allocator can never mint a malformed reference', () => {
    expect(() => InvoiceReference.fromSequence(0)).toThrow();
    expect(() => InvoiceReference.fromSequence(-1)).toThrow();
    expect(() => InvoiceReference.fromSequence(1.5)).toThrow();
  });
});
