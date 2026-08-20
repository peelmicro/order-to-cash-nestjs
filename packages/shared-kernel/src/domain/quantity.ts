import { DomainError } from './domain-error.js';

export class InvalidQuantityError extends DomainError {
  readonly code = 'INVALID_QUANTITY';

  constructor(value: unknown) {
    super(`${String(value)} is not a valid Quantity: it must be a strictly positive integer`);
  }
}

/**
 * A strictly positive integer count of units — domain-model.md §2.2. Zero,
 * negative and fractional quantities are rejected at construction; the
 * catalogue is sold in whole units only.
 */
export class Quantity {
  private constructor(private readonly count: number) {}

  static of(value: number): Quantity {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
      throw new InvalidQuantityError(value);
    }
    return new Quantity(value);
  }

  get value(): number {
    return this.count;
  }

  add(other: Quantity): Quantity {
    return Quantity.of(this.count + other.count);
  }

  equals(other: Quantity): boolean {
    return this.count === other.count;
  }

  compareTo(other: Quantity): number {
    return this.count - other.count;
  }

  toString(): string {
    return String(this.count);
  }
}
