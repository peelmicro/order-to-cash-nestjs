import { randomUUID } from 'node:crypto';

import { DomainError } from './domain-error.js';

// UUID v4 shape: version nibble is "4", variant nibble is 8/9/a/b.
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidUniqueIdError extends DomainError {
  readonly code = 'INVALID_UNIQUE_ID';

  constructor(value: unknown) {
    super(`"${String(value)}" is not a valid UUID v4`);
  }
}

/**
 * An opaque, globally unique identifier generated **inside the domain**,
 * never by the store — domain-model.md §2.5. Used for aggregate identity
 * and for `eventId`. Two `UniqueId`s are equal iff their values are equal.
 */
export class UniqueId {
  private constructor(private readonly uuid: string) {}

  /** Generates a fresh UUID v4 via Node's built-in `crypto.randomUUID()`. */
  static generate(): UniqueId {
    return new UniqueId(randomUUID());
  }

  /** Reconstructs a `UniqueId` from an existing string, validating its shape. */
  static from(value: string): UniqueId {
    if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
      throw new InvalidUniqueIdError(value);
    }
    return new UniqueId(value.toLowerCase());
  }

  get value(): string {
    return this.uuid;
  }

  equals(other?: UniqueId | null): boolean {
    if (other == null) {
      return false;
    }
    return this.uuid === other.uuid;
  }

  toString(): string {
    return this.uuid;
  }
}
