// The `StockItem` aggregate root — domain-model.md §4.1, design.md §3.1. A
// pure function of its inputs: no clock, no port, everything comes in
// through `StockContext` or method arguments. Invariant F1 lives HERE, not
// in the schema (phase-6 decision, `stock.schema.ts`'s header) — `reserve`
// throws rather than let `reservedUnits` exceed `units`, and `reconstitute`
// refuses a snapshot that already violates it.
import { AggregateRoot, type DomainEventEnvelope, type OrderNumber, type Quantity, type UniqueId } from '@otc/shared-kernel';
import { Reservation, type ReservationView } from './reservation.js';
import type { StockItemSnapshot } from './stock-item-snapshot.js';
import { FactAggregateMismatchError, InsufficientStockError, InvalidStockItemSnapshotError, ReservationTerminalError } from './stock-errors.js';

/** Time and causation in, nothing pulled — mirrors `apps/orders/.../order.ts`'s `TransitionContext`. */
export interface StockContext {
  readonly occurredAt: Date;
  readonly causationId: UniqueId;
}

interface StockItemProps {
  readonly companyCode: string;
  readonly productCode: string;
  readonly units: number;
  readonly reservedUnits: number;
  readonly lowStockThreshold: number;
  readonly reservations: readonly Reservation[];
}

export class StockItem extends AggregateRoot<StockItem> {
  private constructor(
    id: UniqueId,
    private props: StockItemProps,
  ) {
    super(id);
  }

  /**
   * Rebuilds a stock item from its stored `units`/`reservedUnits` and the
   * reservations loaded with it. Refuses (`InvalidStockItemSnapshotError`)
   * a snapshot that already violates F1 — a negative counter, or
   * `reservedUnits > units`.
   */
  static reconstitute(snapshot: StockItemSnapshot): StockItem {
    if (snapshot.units < 0 || snapshot.reservedUnits < 0) {
      throw new InvalidStockItemSnapshotError(
        `units (${snapshot.units}) and reservedUnits (${snapshot.reservedUnits}) must both be non-negative`,
        snapshot.id,
      );
    }
    if (snapshot.reservedUnits > snapshot.units) {
      throw new InvalidStockItemSnapshotError(
        `reservedUnits (${snapshot.reservedUnits}) exceeds units (${snapshot.units}) — violates F1`,
        snapshot.id,
      );
    }

    return new StockItem(snapshot.id, {
      companyCode: snapshot.companyCode,
      productCode: snapshot.productCode,
      units: snapshot.units,
      reservedUnits: snapshot.reservedUnits,
      lowStockThreshold: snapshot.lowStockThreshold,
      reservations: snapshot.reservations.map((r) => Reservation.reconstitute(r)),
    });
  }

  get companyCode(): string {
    return this.props.companyCode;
  }

  get productCode(): string {
    return this.props.productCode;
  }

  get units(): number {
    return this.props.units;
  }

  get reservedUnits(): number {
    return this.props.reservedUnits;
  }

  get lowStockThreshold(): number {
    return this.props.lowStockThreshold;
  }

  /** `units - reservedUnits`, derived, never stored (asyncapi `StockView.availableUnits`). */
  get availableUnits(): number {
    return this.props.units - this.props.reservedUnits;
  }

  /** Frozen views (F2 discipline mirrors `OrderLineView`) of the reservations LOADED with this item — scoped to the order being handled (design.md §3.1, §7). */
  get reservations(): readonly ReservationView[] {
    return Object.freeze(this.props.reservations.map((r) => r.toView()));
  }

  /** Pure availability question — no mutation, no event (R31). */
  canReserve(units: Quantity): boolean {
    return this.availableUnits >= units.value;
  }

  /**
   * Creates ONE reservation in status `reserved` and adds `units` to
   * `reservedUnits`. Throws `InsufficientStockError` if it would break F1
   * (R30). Emits nothing — the ORDER-scoped fact is the domain service's
   * (`order-stock-reservation.ts`).
   */
  reserve(input: {
    readonly reservationId: UniqueId;
    readonly orderReference: OrderNumber;
    readonly retailerCode: string;
    readonly units: Quantity;
  }): Reservation {
    if (this.props.reservedUnits + input.units.value > this.props.units) {
      throw new InsufficientStockError(this.props.productCode, input.units.value, this.availableUnits);
    }

    const reservation = Reservation.create({
      id: input.reservationId,
      orderReference: input.orderReference,
      companyCode: this.props.companyCode,
      retailerCode: input.retailerCode,
      productCode: this.props.productCode,
      units: input.units,
    });

    this.props = {
      ...this.props,
      reservedUnits: this.props.reservedUnits + input.units.value,
      reservations: [...this.props.reservations, reservation],
    };

    return reservation;
  }

  /**
   * Moves this item's `reserved` reservations of `orderReference` to
   * `released`, subtracts their units from `reservedUnits`. Returns the
   * released reservations — an EMPTY array when none was `reserved` (F5,
   * idempotent). Throws `ReservationTerminalError` if any of the order's
   * reservations on this item is `consumed` (F4, FS10) — nothing is
   * mutated in that case. Emits nothing.
   */
  release(orderReference: OrderNumber): readonly Reservation[] {
    const matches = this.props.reservations.filter((r) => r.orderReference.equals(orderReference));
    const consumed = matches.find((r) => r.status === 'consumed');
    if (consumed) {
      throw new ReservationTerminalError(consumed.id, 'consumed', 'release');
    }

    const toRelease = matches.filter((r) => r.status === 'reserved');
    if (toRelease.length === 0) {
      return [];
    }

    for (const reservation of toRelease) {
      reservation.release();
    }
    const releasedUnits = toRelease.reduce((sum, r) => sum + r.units.value, 0);
    this.props = { ...this.props, reservedUnits: this.props.reservedUnits - releasedUnits };

    return toRelease;
  }

  /**
   * Moves this item's `reserved` reservations of `orderReference` to
   * `consumed`, subtracts their units from BOTH `units` and
   * `reservedUnits` (domain-model.md §4.2 row 4). Returns them; empty when
   * none was reserved. Throws `ReservationTerminalError` on a `released`
   * one. Emits nothing — `order.despatched.v1` is feature 18's
   * `DespatchAdvice` fact (FS11).
   */
  consume(orderReference: OrderNumber): readonly Reservation[] {
    const matches = this.props.reservations.filter((r) => r.orderReference.equals(orderReference));
    const released = matches.find((r) => r.status === 'released');
    if (released) {
      throw new ReservationTerminalError(released.id, 'released', 'consume');
    }

    const toConsume = matches.filter((r) => r.status === 'reserved');
    if (toConsume.length === 0) {
      return [];
    }

    for (const reservation of toConsume) {
      reservation.consume();
    }
    const consumedUnits = toConsume.reduce((sum, r) => sum + r.units.value, 0);
    this.props = {
      ...this.props,
      units: this.props.units - consumedUnits,
      reservedUnits: this.props.reservedUnits - consumedUnits,
    };

    return toConsume;
  }

  /** `units += quantity`. Appends NO domain event (R61). The only operation that can never move the item closer to breaking F1. */
  replenish(quantity: Quantity): void {
    this.props = { ...this.props, units: this.props.units + quantity.value };
  }

  /**
   * Appends an order-scoped fact built by `order-stock-reservation.ts`.
   * Refuses (`FactAggregateMismatchError`) unless `event.aggregateId`
   * equals this item's own id — the one guard that keeps this method from
   * being a generic "emit anything" hole.
   */
  recordOrderFact(event: DomainEventEnvelope): void {
    if (!event.aggregateId.equals(this.id)) {
      throw new FactAggregateMismatchError(this.id, event.aggregateId);
    }
    this.addDomainEvent(event);
  }

  toSnapshot(): StockItemSnapshot {
    return {
      id: this.id,
      companyCode: this.props.companyCode,
      productCode: this.props.productCode,
      units: this.props.units,
      reservedUnits: this.props.reservedUnits,
      lowStockThreshold: this.props.lowStockThreshold,
      reservations: this.props.reservations.map((r) => r.toSnapshot()),
    };
  }
}
