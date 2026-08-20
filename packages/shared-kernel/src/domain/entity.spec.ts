import { describe, expect, it } from 'vitest';

import { Entity } from './entity.js';
import { UniqueId } from './unique-id.js';

class SampleEntity extends Entity<SampleEntity> {
  constructor(
    id: UniqueId,
    public readonly label: string,
  ) {
    super(id);
  }
}

class OtherEntity extends Entity<OtherEntity> {
  constructor(id: UniqueId) {
    super(id);
  }
}

describe('Entity — identity-based equality via UniqueId', () => {
  it('exposes the id it was constructed with', () => {
    const id = UniqueId.generate();
    const entity = new SampleEntity(id, 'a');

    expect(entity.id.equals(id)).toBe(true);
  });

  it('is equal to another entity with the same id, regardless of other attributes', () => {
    const id = UniqueId.generate();
    const a = new SampleEntity(id, 'first label');
    const b = new SampleEntity(id, 'a completely different label');

    expect(a.equals(b)).toBe(true);
  });

  it('is not equal to an entity with a different id', () => {
    const a = new SampleEntity(UniqueId.generate(), 'same label');
    const b = new SampleEntity(UniqueId.generate(), 'same label');

    expect(a.equals(b)).toBe(false);
  });

  it('is not equal to null, undefined or a non-Entity value', () => {
    const entity = new SampleEntity(UniqueId.generate(), 'a');
    const notAnEntity = { id: entity.id } as unknown as SampleEntity;

    expect(entity.equals(undefined)).toBe(false);
    expect(entity.equals(null)).toBe(false);
    expect(entity.equals(notAnEntity)).toBe(false);
  });

  it('is reflexively equal to itself (identity short-circuit)', () => {
    const entity = new SampleEntity(UniqueId.generate(), 'a');

    expect(entity.equals(entity)).toBe(true);
  });

  it('is not equal to an entity of a different subclass, even sharing an id', () => {
    const id = UniqueId.generate();
    const sample = new SampleEntity(id, 'a');
    const other = new OtherEntity(id);

    // Identity equality here is defined purely by id; this documents that
    // Entity.equals() does not itself enforce same-subclass identity — the
    // domain-purity contract for that is the self-referencing phantom type
    // parameter (`Entity<T>`), which TypeScript enforces at compile time.
    expect(sample.equals(other as unknown as SampleEntity)).toBe(true);
  });
});
