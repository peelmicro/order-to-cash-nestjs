import { DomainError } from './domain-error.js';

const SEQUENCE_WIDTH = 6;

export class InvalidBusinessReferenceError extends DomainError {
  readonly code = 'INVALID_BUSINESS_REFERENCE';

  constructor(prefix: string, value: unknown) {
    super(
      `"${String(value)}" is not a valid ${prefix}-${'#'.repeat(SEQUENCE_WIDTH)} business reference`,
    );
  }
}

/**
 * A human-readable, unique, immutable business reference of the form
 * `<PREFIX>-######` (domain-model.md §2.3) — `ORD-000001`, `DES-000001`,
 * `INV-000001`, `CR-000001`. Assigned once and never reassigned.
 *
 * Not exported directly. Each sibling reference below fixes its own prefix
 * so that, for example, `OrderNumber` and `InvoiceReference` remain
 * distinct, non-interchangeable types even though they share a shape and
 * would otherwise be structurally identical to TypeScript.
 */
abstract class BusinessReference {
  protected constructor(private readonly reference: string) {}

  get value(): string {
    return this.reference;
  }

  equals(other?: BusinessReference | null): boolean {
    if (other == null) {
      return false;
    }
    return this.constructor === other.constructor && this.reference === other.reference;
  }

  toString(): string {
    return this.reference;
  }

  protected static parse(prefix: string, value: string): string {
    const pattern = new RegExp(`^${prefix}-\\d{${SEQUENCE_WIDTH}}$`);
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new InvalidBusinessReferenceError(prefix, value);
    }
    return value;
  }

  protected static format(prefix: string, sequence: number): string {
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence <= 0) {
      throw new InvalidBusinessReferenceError(prefix, sequence);
    }
    const padded = String(sequence).padStart(SEQUENCE_WIDTH, '0');
    if (padded.length !== SEQUENCE_WIDTH) {
      // The sequence no longer fits the fixed width — refuse rather than
      // silently truncate or grow the reference shape.
      throw new InvalidBusinessReferenceError(prefix, sequence);
    }
    return `${prefix}-${padded}`;
  }
}

export class OrderNumber extends BusinessReference {
  private static readonly PREFIX = 'ORD';

  private constructor(value: string) {
    super(value);
  }

  static of(value: string): OrderNumber {
    return new OrderNumber(BusinessReference.parse(OrderNumber.PREFIX, value));
  }

  static fromSequence(sequence: number): OrderNumber {
    return new OrderNumber(BusinessReference.format(OrderNumber.PREFIX, sequence));
  }
}

export class DespatchReference extends BusinessReference {
  private static readonly PREFIX = 'DES';

  private constructor(value: string) {
    super(value);
  }

  static of(value: string): DespatchReference {
    return new DespatchReference(BusinessReference.parse(DespatchReference.PREFIX, value));
  }

  static fromSequence(sequence: number): DespatchReference {
    return new DespatchReference(
      BusinessReference.format(DespatchReference.PREFIX, sequence),
    );
  }
}

export class InvoiceReference extends BusinessReference {
  private static readonly PREFIX = 'INV';

  private constructor(value: string) {
    super(value);
  }

  static of(value: string): InvoiceReference {
    return new InvoiceReference(BusinessReference.parse(InvoiceReference.PREFIX, value));
  }

  static fromSequence(sequence: number): InvoiceReference {
    return new InvoiceReference(BusinessReference.format(InvoiceReference.PREFIX, sequence));
  }
}

export class CreditLineReference extends BusinessReference {
  private static readonly PREFIX = 'CR';

  private constructor(value: string) {
    super(value);
  }

  static of(value: string): CreditLineReference {
    return new CreditLineReference(BusinessReference.parse(CreditLineReference.PREFIX, value));
  }

  static fromSequence(sequence: number): CreditLineReference {
    return new CreditLineReference(
      BusinessReference.format(CreditLineReference.PREFIX, sequence),
    );
  }
}
