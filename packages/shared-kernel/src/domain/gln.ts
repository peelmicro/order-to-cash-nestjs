import { DomainError } from './domain-error.js';

const GLN_SHAPE_PATTERN = /^\d{13}$/;
const GLN_BODY_PATTERN = /^\d{12}$/;

export class InvalidGlnError extends DomainError {
  readonly code = 'INVALID_GLN';

  constructor(value: unknown, reason: string) {
    super(`"${String(value)}" is not a valid GLN: ${reason}`);
  }
}

/**
 * A GS1 Global Location Number — the EDI party identifier
 * (domain-model.md §2.4). Exactly 13 decimal digits whose final digit is a
 * mod-10 (GS1) check digit over the preceding twelve. Every retailer
 * (buyer) and supplier carries one.
 */
export class GLN {
  private constructor(private readonly digits: string) {}

  static of(value: string): GLN {
    if (typeof value !== 'string' || !GLN_SHAPE_PATTERN.test(value)) {
      throw new InvalidGlnError(value, 'must be exactly 13 decimal digits');
    }
    const body = value.slice(0, 12);
    const suppliedCheckDigit = Number(value[12]);
    const expectedCheckDigit = GLN.computeCheckDigit(body);
    if (suppliedCheckDigit !== expectedCheckDigit) {
      throw new InvalidGlnError(
        value,
        `check digit ${suppliedCheckDigit} does not match the GS1 mod-10 check digit ${expectedCheckDigit}`,
      );
    }
    return new GLN(value);
  }

  /**
   * GS1 mod-10 check digit over a 12-digit body: multiply the digits
   * alternately by 3 and 1 starting from the rightmost digit (position 12 ×
   * 3, position 11 × 1, …), sum the products, and the check digit is
   * `(10 - (sum mod 10)) mod 10`.
   */
  static computeCheckDigit(body: string): number {
    if (typeof body !== 'string' || !GLN_BODY_PATTERN.test(body)) {
      throw new InvalidGlnError(body, 'a GLN body must be exactly 12 decimal digits');
    }
    let sum = 0;
    for (let distanceFromRight = 0; distanceFromRight < body.length; distanceFromRight++) {
      const digit = Number(body[body.length - 1 - distanceFromRight]);
      const weight = distanceFromRight % 2 === 0 ? 3 : 1;
      sum += digit * weight;
    }
    return (10 - (sum % 10)) % 10;
  }

  get value(): string {
    return this.digits;
  }

  equals(other: GLN): boolean {
    return this.digits === other.digits;
  }

  toString(): string {
    return this.digits;
  }
}
