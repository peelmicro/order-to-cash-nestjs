import { describe, expect, it } from 'vitest';

import {
  CreditLineReference,
  DespatchReference,
  InvalidBusinessReferenceError,
  InvoiceReference,
  OrderNumber,
} from './business-reference.js';

describe('business references — domain-model.md §2.3', () => {
  it('accepts the well-formed shape <PREFIX>-###### for each sibling reference', () => {
    expect(OrderNumber.of('ORD-000001').value).toBe('ORD-000001');
    expect(DespatchReference.of('DES-000042').value).toBe('DES-000042');
    expect(InvoiceReference.of('INV-123456').value).toBe('INV-123456');
    expect(CreditLineReference.of('CR-000007').value).toBe('CR-000007');
  });

  it('formats a positive integer sequence into the zero-padded shape', () => {
    expect(OrderNumber.fromSequence(1).value).toBe('ORD-000001');
    expect(OrderNumber.fromSequence(42).value).toBe('ORD-000042');
    expect(InvoiceReference.fromSequence(999_999).value).toBe('INV-999999');
    expect(DespatchReference.fromSequence(1).value).toBe('DES-000001');
    expect(CreditLineReference.fromSequence(7).value).toBe('CR-000007');
  });

  it('refuses the wrong prefix, missing dash, wrong digit count and non-digit sequence', () => {
    expect(() => OrderNumber.of('DES-000001')).toThrow(InvalidBusinessReferenceError);
    expect(() => OrderNumber.of('ORD000001')).toThrow(InvalidBusinessReferenceError);
    expect(() => OrderNumber.of('ORD-1')).toThrow(InvalidBusinessReferenceError);
    expect(() => OrderNumber.of('ORD-0000001')).toThrow(InvalidBusinessReferenceError);
    expect(() => OrderNumber.of('ORD-00000a')).toThrow(InvalidBusinessReferenceError);
    expect(() => OrderNumber.of('')).toThrow(InvalidBusinessReferenceError);
  });

  it('refuses to format a zero, negative, fractional or over-wide sequence', () => {
    expect(() => OrderNumber.fromSequence(0)).toThrow(InvalidBusinessReferenceError);
    expect(() => OrderNumber.fromSequence(-1)).toThrow(InvalidBusinessReferenceError);
    expect(() => OrderNumber.fromSequence(1.5)).toThrow(InvalidBusinessReferenceError);
    expect(() => OrderNumber.fromSequence(1_000_000)).toThrow(InvalidBusinessReferenceError);
  });

  it('is equal by value within the same reference type', () => {
    expect(OrderNumber.of('ORD-000001').equals(OrderNumber.of('ORD-000001'))).toBe(true);
    expect(OrderNumber.of('ORD-000001').equals(OrderNumber.of('ORD-000002'))).toBe(false);
    expect(OrderNumber.of('ORD-000001').equals(null)).toBe(false);
    expect(OrderNumber.of('ORD-000001').equals(undefined)).toBe(false);
  });

  it('is never equal across different reference types even with the same digits', () => {
    // TypeScript already refuses this at compile time (distinct nominal
    // types); this proves the runtime guard holds too, via an untyped cast
    // that simulates a boundary where type information has been erased
    // (e.g. deserialising a value read back from a message envelope).
    const orderNumber: unknown = OrderNumber.of('ORD-000001');
    const despatchReference = DespatchReference.of('DES-000001');

    expect(despatchReference.equals(orderNumber as DespatchReference)).toBe(false);
  });

  it('toString() returns the reference value', () => {
    expect(OrderNumber.of('ORD-000001').toString()).toBe('ORD-000001');
  });
});
