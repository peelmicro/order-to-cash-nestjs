import { describe, expect, it } from 'vitest';

import { CurrencyMismatchError, InvalidCurrencyCodeError, InvalidMoneyAmountError, Money } from './money.js';
import { Quantity } from './quantity.js';

describe('Money — R1: integer minor units plus an ISO 4217 currency code', () => {
  it('represents 1 242,50 EUR as 124250 minor units and offers no decimal representation', () => {
    const money = Money.of(124_250, 'EUR');

    expect(money.amount).toBe(124_250);
    expect(Number.isInteger(money.amount)).toBe(true);
    expect(money.currency).toBe('EUR');
    // The public surface never exposes a major-unit/decimal accessor.
    expect((money as unknown as Record<string, unknown>).toDecimal).toBeUndefined();
    expect((money as unknown as Record<string, unknown>).toFloat).toBeUndefined();
  });

  it('zero() constructs a zero amount in the given currency', () => {
    expect(Money.zero('EUR').equals(Money.of(0, 'EUR'))).toBe(true);
    expect(Money.zero('EUR').isZero()).toBe(true);
  });

  it('normalises a lowercase currency code to uppercase ISO 4217 alpha-3', () => {
    const money = Money.of(100, 'eur');

    expect(money.currency).toBe('EUR');
  });

  it('rejects a non-integer, non-finite or unsafe-integer amount and creates no value object', () => {
    expect(() => Money.of(10.5, 'EUR')).toThrow(InvalidMoneyAmountError);
    expect(() => Money.of(Number.NaN, 'EUR')).toThrow(InvalidMoneyAmountError);
    expect(() => Money.of(Number.POSITIVE_INFINITY, 'EUR')).toThrow(InvalidMoneyAmountError);
    expect(() => Money.of(Number.MAX_SAFE_INTEGER + 1, 'EUR')).toThrow(InvalidMoneyAmountError);
    // The classic float-arithmetic leak (0.1 + 0.2 !== 0.3) can never reach
    // Money because the constructor rejects any non-integer amount outright.
    expect(() => Money.of(0.1 + 0.2, 'EUR')).toThrow(InvalidMoneyAmountError);
  });

  it('rejects a currency code that is not a 3-letter ISO 4217 shape', () => {
    expect(() => Money.of(100, 'EU')).toThrow(InvalidCurrencyCodeError);
    expect(() => Money.of(100, 'EURO')).toThrow(InvalidCurrencyCodeError);
    expect(() => Money.of(100, '123')).toThrow(InvalidCurrencyCodeError);
    expect(() => Money.of(100, '')).toThrow(InvalidCurrencyCodeError);
  });
});

describe('Money — R2: cross-currency arithmetic is a domain error, never an implicit conversion', () => {
  it('raises a domain error when EUR and GBP amounts are added, subtracted or compared', () => {
    const eur = Money.of(1_000, 'EUR');
    const gbp = Money.of(1_000, 'GBP');

    expect(() => eur.add(gbp)).toThrow(CurrencyMismatchError);
    expect(() => eur.subtract(gbp)).toThrow(CurrencyMismatchError);
    expect(() => eur.compareTo(gbp)).toThrow(CurrencyMismatchError);
    expect(() => eur.isGreaterThan(gbp)).toThrow(CurrencyMismatchError);
    expect(() => eur.isLessThan(gbp)).toThrow(CurrencyMismatchError);
  });

  it('performs no implicit currency conversion — the operands are simply refused', () => {
    const eur = Money.of(1_000, 'EUR');
    const gbp = Money.of(1_000, 'GBP');

    let caught: unknown;
    try {
      eur.add(gbp);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CurrencyMismatchError);
    // Neither operand was mutated or coerced — Money is immutable.
    expect(eur.amount).toBe(1_000);
    expect(eur.currency).toBe('EUR');
    expect(gbp.amount).toBe(1_000);
    expect(gbp.currency).toBe('GBP');
  });
});

describe('Money — closed arithmetic (M3)', () => {
  it('add and subtract return Money of the same currency', () => {
    const a = Money.of(500, 'EUR');
    const b = Money.of(200, 'EUR');

    expect(a.add(b).equals(Money.of(700, 'EUR'))).toBe(true);
    expect(a.subtract(b).equals(Money.of(300, 'EUR'))).toBe(true);
  });

  it('multiplies by a Quantity and returns Money of the same currency', () => {
    const unitPrice = Money.of(199, 'EUR');
    const quantity = Quantity.of(3);

    expect(unitPrice.multiply(quantity).equals(Money.of(597, 'EUR'))).toBe(true);
  });

  it('has no division operation on its public surface', () => {
    expect((Money.of(100, 'EUR') as unknown as Record<string, unknown>).divide).toBeUndefined();
  });
});

describe('Money — sign (M4)', () => {
  it('represents a negative amount (discounts, reversals)', () => {
    const negative = Money.of(-500, 'EUR');

    expect(negative.isNegative()).toBe(true);
    expect(negative.amount).toBe(-500);
  });

  it('subtracting a larger amount from a smaller one yields a negative Money', () => {
    const small = Money.of(100, 'EUR');
    const large = Money.of(300, 'EUR');

    expect(small.subtract(large).isNegative()).toBe(true);
  });

  it('classifies zero and positive amounts, and negate() flips the sign', () => {
    expect(Money.of(0, 'EUR').isZero()).toBe(true);
    expect(Money.of(0, 'EUR').isPositive()).toBe(false);
    expect(Money.of(100, 'EUR').isPositive()).toBe(true);
    expect(Money.of(100, 'EUR').negate().equals(Money.of(-100, 'EUR'))).toBe(true);
    expect(Money.of(-100, 'EUR').negate().equals(Money.of(100, 'EUR'))).toBe(true);
  });

  it('rejects a non-string currency', () => {
    expect(() => Money.of(100, 123 as unknown as string)).toThrow(InvalidCurrencyCodeError);
  });

  it('toString() reports the minor units and the currency code', () => {
    expect(Money.of(124_250, 'EUR').toString()).toBe('124250 EUR');
  });
});

describe('Money — equality and comparison', () => {
  it('is equal by value: same amount and same currency', () => {
    expect(Money.of(100, 'EUR').equals(Money.of(100, 'EUR'))).toBe(true);
    expect(Money.of(100, 'EUR').equals(Money.of(101, 'EUR'))).toBe(false);
    expect(Money.of(100, 'EUR').equals(Money.of(100, 'GBP'))).toBe(false);
  });

  it('orders same-currency amounts via compareTo/isGreaterThan/isLessThanOrEqual', () => {
    const low = Money.of(100, 'EUR');
    const high = Money.of(200, 'EUR');

    expect(low.compareTo(high)).toBeLessThan(0);
    expect(high.isGreaterThan(low)).toBe(true);
    expect(low.isGreaterThanOrEqual(low)).toBe(true);
    expect(low.isLessThanOrEqual(high)).toBe(true);
  });
});

describe('Money — mod100(), the `.99` simulator accessor', () => {
  it('returns the minor-unit remainder modulo 100 for a positive amount', () => {
    expect(Money.of(124_299, 'EUR').mod100()).toBe(99);
    expect(Money.of(124_250, 'EUR').mod100()).toBe(50);
    expect(Money.of(100, 'EUR').mod100()).toBe(0);
    expect(Money.of(1, 'EUR').mod100()).toBe(1);
  });

  it('stays in [0, 99] for a negative amount instead of returning a negative remainder', () => {
    // JavaScript's native `%` would return -1 here; mod100() must not leak that.
    const result = Money.of(-1, 'EUR').mod100();

    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(99);
    expect(result).toBe(99);
  });
});
