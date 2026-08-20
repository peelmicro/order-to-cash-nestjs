import { describe, expect, it } from 'vitest';

import { InvalidUniqueIdError, UniqueId } from './unique-id.js';

describe('UniqueId', () => {
  it('generates a fresh, distinct UUID v4 via crypto.randomUUID()', () => {
    const a = UniqueId.generate();
    const b = UniqueId.generate();

    expect(a.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(a.equals(b)).toBe(false);
  });

  it('reconstructs from an existing valid UUID v4 string', () => {
    const original = UniqueId.generate();
    const reconstructed = UniqueId.from(original.value);

    expect(reconstructed.equals(original)).toBe(true);
    expect(reconstructed.value).toBe(original.value);
  });

  it('normalises case so two UUIDs differing only in case are equal', () => {
    const lower = UniqueId.from('3fa85f64-5717-4562-b3fc-2c963f66afa6');
    const upper = UniqueId.from('3FA85F64-5717-4562-B3FC-2C963F66AFA6');

    expect(lower.equals(upper)).toBe(true);
  });

  it('rejects a string that is not a valid UUID v4 and creates no value object', () => {
    expect(() => UniqueId.from('not-a-uuid')).toThrow(InvalidUniqueIdError);
    // wrong version nibble (must be "4")
    expect(() => UniqueId.from('3fa85f64-5717-1562-b3fc-2c963f66afa6')).toThrow(
      InvalidUniqueIdError,
    );
    // wrong variant nibble (must be 8/9/a/b)
    expect(() => UniqueId.from('3fa85f64-5717-4562-0000-2c963f66afa6')).toThrow(
      InvalidUniqueIdError,
    );
    expect(() => UniqueId.from('')).toThrow(InvalidUniqueIdError);
  });

  it('two UniqueIds are equal iff their values are equal, and never equal to null/undefined', () => {
    const id = UniqueId.generate();

    expect(id.equals(UniqueId.from(id.value))).toBe(true);
    expect(id.equals(UniqueId.generate())).toBe(false);
    expect(id.equals(undefined)).toBe(false);
    expect(id.equals(null)).toBe(false);
  });

  it('toString() returns the underlying UUID', () => {
    const id = UniqueId.generate();

    expect(id.toString()).toBe(id.value);
  });
});
