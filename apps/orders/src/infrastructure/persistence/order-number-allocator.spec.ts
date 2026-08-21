// Pure unit — the sequence-parsing half of `DrizzleOrderNumberAllocator`
// (the allocation itself needs a real transaction/row-lock and is proven by
// `order-number-allocator.integration.spec.ts`, Testcontainers).
import { describe, expect, it } from 'vitest';
import { parseOrderNumberSequence } from './order-number-allocator';

describe('parseOrderNumberSequence', () => {
  it('parses the numeric suffix of an ORD-###### reference', () => {
    expect(parseOrderNumberSequence('ORD-000001')).toBe(1);
    expect(parseOrderNumberSequence('ORD-000006')).toBe(6);
    expect(parseOrderNumberSequence('ORD-123456')).toBe(123456);
  });

  it('throws on a reference with no valid numeric suffix', () => {
    expect(() => parseOrderNumberSequence('ORD-')).toThrow();
    expect(() => parseOrderNumberSequence('ORD-abcdef')).toThrow();
    expect(() => parseOrderNumberSequence('ORD-000000')).toThrow();
  });
});
