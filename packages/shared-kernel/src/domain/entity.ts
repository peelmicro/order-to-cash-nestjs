import type { UniqueId } from './unique-id.js';

/**
 * Identity-based equality for domain objects that have a life cycle
 * distinct from their attributes.
 *
 * `T` is a self-referencing phantom type parameter — a concrete subclass
 * declares `class Order extends Entity<Order>` — so that two structurally
 * similar entities of different aggregates (e.g. an `Order` and a
 * `StockItem` that happen to expose the same shape) are never assignable
 * to one another, even though TypeScript is structurally typed.
 */
export abstract class Entity<T> {
  private readonly _id: UniqueId;

  protected constructor(id: UniqueId) {
    this._id = id;
  }

  get id(): UniqueId {
    return this._id;
  }

  equals(other?: Entity<T> | null): boolean {
    if (other == null) {
      return false;
    }
    if (this === other) {
      return true;
    }
    if (!(other instanceof Entity)) {
      return false;
    }
    return this._id.equals(other._id);
  }
}
