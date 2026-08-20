import { DomainError } from './domain-error.js';
import type { Quantity } from './quantity.js';

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export class InvalidMoneyAmountError extends DomainError {
  readonly code = 'INVALID_MONEY_AMOUNT';

  constructor(amount: unknown) {
    super(
      `${String(amount)} is not a valid Money amount: it must be a finite, safe integer count of minor units`,
    );
  }
}

export class InvalidCurrencyCodeError extends DomainError {
  readonly code = 'INVALID_CURRENCY_CODE';

  constructor(currency: unknown) {
    super(`"${String(currency)}" is not a valid ISO 4217 alpha-3 currency code`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(left: string, right: string) {
    super(`cannot operate on Money of different currencies: ${left} vs ${right}`);
  }
}

/**
 * An amount of money as an integer count of minor units (cents) plus an
 * ISO 4217 alpha-3 currency code — domain-model.md §2.1, invariants M1-M4.
 * Never a float, never a decimal or fixed-point major-unit representation,
 * at rest, on the wire or in arithmetic. Immutable; validates on
 * construction.
 *
 * Currency-code validation enforces the ISO 4217 *shape* only (three
 * uppercase letters). Membership in the seeded currency catalogue is
 * reference data owned by the Orders context, not by this dependency-free
 * kernel.
 */
export class Money {
  private constructor(
    private readonly minorUnits: number,
    private readonly currencyCode: string,
  ) {}

  static of(amountMinorUnits: number, currency: string): Money {
    if (
      typeof amountMinorUnits !== 'number' ||
      !Number.isFinite(amountMinorUnits) ||
      !Number.isInteger(amountMinorUnits) ||
      !Number.isSafeInteger(amountMinorUnits)
    ) {
      throw new InvalidMoneyAmountError(amountMinorUnits);
    }
    return new Money(amountMinorUnits, Money.validateCurrency(currency));
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  /** The integer count of minor units (cents). Never a float. */
  get amount(): number {
    return this.minorUnits;
  }

  get currency(): string {
    return this.currencyCode;
  }

  /** M3 — closed arithmetic: same currency in, same currency out. */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minorUnits + other.minorUnits, this.currencyCode);
  }

  /** M2/M3 — no cross-currency arithmetic; closed arithmetic. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minorUnits - other.minorUnits, this.currencyCode);
  }

  /** M3 — multiplying by a `Quantity` returns `Money` of the same currency. */
  multiply(quantity: Quantity): Money {
    return Money.of(this.minorUnits * quantity.value, this.currencyCode);
  }

  negate(): Money {
    return Money.of(-this.minorUnits, this.currencyCode);
  }

  /** M4 — negative Money is representable (discounts, reversals). */
  isNegative(): boolean {
    return this.minorUnits < 0;
  }

  isZero(): boolean {
    return this.minorUnits === 0;
  }

  isPositive(): boolean {
    return this.minorUnits > 0;
  }

  equals(other: Money): boolean {
    return this.minorUnits === other.minorUnits && this.currencyCode === other.currencyCode;
  }

  /** M2 — comparison across currencies is a domain error, same as arithmetic. */
  compareTo(other: Money): number {
    this.assertSameCurrency(other);
    return this.minorUnits - other.minorUnits;
  }

  isGreaterThan(other: Money): boolean {
    return this.compareTo(other) > 0;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    return this.compareTo(other) >= 0;
  }

  isLessThan(other: Money): boolean {
    return this.compareTo(other) < 0;
  }

  isLessThanOrEqual(other: Money): boolean {
    return this.compareTo(other) <= 0;
  }

  /**
   * The minor-unit remainder modulo 100 — what the `.99` credit-simulator
   * affordance (`requirements.md` R42) reads to decide
   * `totalAmount mod 100 == 99`. Always in `[0, 99]`, even for a negative
   * amount (JavaScript's `%` would otherwise return a negative remainder).
   */
  mod100(): number {
    return ((this.minorUnits % 100) + 100) % 100;
  }

  toString(): string {
    return `${this.minorUnits} ${this.currencyCode}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currencyCode !== other.currencyCode) {
      throw new CurrencyMismatchError(this.currencyCode, other.currencyCode);
    }
  }

  private static validateCurrency(currency: string): string {
    if (typeof currency !== 'string') {
      throw new InvalidCurrencyCodeError(currency);
    }
    const normalized = currency.toUpperCase();
    if (!CURRENCY_CODE_PATTERN.test(normalized)) {
      throw new InvalidCurrencyCodeError(currency);
    }
    return normalized;
  }
}
