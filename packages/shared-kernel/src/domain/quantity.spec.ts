import { describe, expect, it } from 'vitest';

import { InvalidQuantityError, Quantity } from './quantity.js';

describe('Quantity — R3: a quantity must be a strictly positive integer', () => {
  it('accepts a strictly positive integer', () => {
    const quantity = Quantity.of(5);

    expect(quantity.value).toBe(5);
  });

  it('refuses zero, negative and fractional quantities and creates no value object', () => {
    expect(() => Quantity.of(0)).toThrow(InvalidQuantityError);
    expect(() => Quantity.of(-1)).toThrow(InvalidQuantityError);
    expect(() => Quantity.of(-100)).toThrow(InvalidQuantityError);
    expect(() => Quantity.of(1.5)).toThrow(InvalidQuantityError);
    expect(() => Quantity.of(0.1)).toThrow(InvalidQuantityError);
    expect(() => Quantity.of(Number.NaN)).toThrow(InvalidQuantityError);
    expect(() => Quantity.of(Number.POSITIVE_INFINITY)).toThrow(InvalidQuantityError);
  });

  it('adds two quantities to a new quantity', () => {
    const a = Quantity.of(3);
    const b = Quantity.of(4);

    expect(a.add(b).value).toBe(7);
  });

  it('compares by value and is equal only to a quantity of the same value', () => {
    expect(Quantity.of(3).equals(Quantity.of(3))).toBe(true);
    expect(Quantity.of(3).equals(Quantity.of(4))).toBe(false);
    expect(Quantity.of(3).compareTo(Quantity.of(4))).toBeLessThan(0);
    expect(Quantity.of(4).compareTo(Quantity.of(3))).toBeGreaterThan(0);
    expect(Quantity.of(4).compareTo(Quantity.of(4))).toBe(0);
  });

  it('toString() returns the count', () => {
    expect(Quantity.of(7).toString()).toBe('7');
  });
});
