// The `Reservation` child entity of `StockItem` (domain-model.md §4.1,
// design.md §3.2) — one per order line, the concrete resource compensation
// releases. Reachable only through its owning `StockItem` (a
// `ReservationView`, defined here too, is what `StockItem.reservations`
// exposes — the same frozen-view discipline `apps/orders/.../order.ts`'s
// `OrderLineView` uses), so nobody can move a reservation without the
// owning item's counter moving with it.
import { Entity, type OrderNumber, type Quantity, type UniqueId } from '@otc/shared-kernel';
import { ReservationTerminalError } from './stock-errors.js';

export const RESERVATION_STATUSES = ['reserved', 'released', 'consumed'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export interface ReservationSnapshot {
  readonly id: UniqueId;
  readonly orderReference: OrderNumber;
  readonly companyCode: string;
  readonly retailerCode: string;
  readonly productCode: string;
  readonly units: Quantity;
  readonly status: ReservationStatus;
}

/** A frozen, non-reachable-for-mutation view of one reservation — what `StockItem.reservations` exposes. */
export interface ReservationView {
  readonly id: UniqueId;
  readonly orderReference: OrderNumber;
  readonly companyCode: string;
  readonly retailerCode: string;
  readonly productCode: string;
  readonly units: Quantity;
  readonly status: ReservationStatus;
}

interface ReservationProps {
  readonly orderReference: OrderNumber;
  readonly companyCode: string;
  readonly retailerCode: string;
  readonly productCode: string;
  readonly units: Quantity;
  status: ReservationStatus;
}

export class Reservation extends Entity<Reservation> {
  private constructor(
    id: UniqueId,
    private props: ReservationProps,
  ) {
    super(id);
  }

  /** The only way a *new* reservation comes into being — status `reserved` (domain-model.md §4.2). */
  static create(input: {
    readonly id: UniqueId;
    readonly orderReference: OrderNumber;
    readonly companyCode: string;
    readonly retailerCode: string;
    readonly productCode: string;
    readonly units: Quantity;
  }): Reservation {
    return new Reservation(input.id, {
      orderReference: input.orderReference,
      companyCode: input.companyCode,
      retailerCode: input.retailerCode,
      productCode: input.productCode,
      units: input.units,
      status: 'reserved',
    });
  }

  static reconstitute(snapshot: ReservationSnapshot): Reservation {
    return new Reservation(snapshot.id, {
      orderReference: snapshot.orderReference,
      companyCode: snapshot.companyCode,
      retailerCode: snapshot.retailerCode,
      productCode: snapshot.productCode,
      units: snapshot.units,
      status: snapshot.status,
    });
  }

  get orderReference(): OrderNumber {
    return this.props.orderReference;
  }

  get companyCode(): string {
    return this.props.companyCode;
  }

  get retailerCode(): string {
    return this.props.retailerCode;
  }

  get productCode(): string {
    return this.props.productCode;
  }

  get units(): Quantity {
    return this.props.units;
  }

  get status(): ReservationStatus {
    return this.props.status;
  }

  /** `reserved -> released`; anything else throws `ReservationTerminalError` and changes nothing (F4, `R35`). */
  release(): void {
    if (this.props.status !== 'reserved') {
      throw new ReservationTerminalError(this.id, this.props.status, 'release');
    }
    this.props.status = 'released';
  }

  /** `reserved -> consumed`; anything else throws `ReservationTerminalError` and changes nothing (F4, `R35`). */
  consume(): void {
    if (this.props.status !== 'reserved') {
      throw new ReservationTerminalError(this.id, this.props.status, 'consume');
    }
    this.props.status = 'consumed';
  }

  toView(): ReservationView {
    return Object.freeze({
      id: this.id,
      orderReference: this.props.orderReference,
      companyCode: this.props.companyCode,
      retailerCode: this.props.retailerCode,
      productCode: this.props.productCode,
      units: this.props.units,
      status: this.props.status,
    });
  }

  toSnapshot(): ReservationSnapshot {
    return {
      id: this.id,
      orderReference: this.props.orderReference,
      companyCode: this.props.companyCode,
      retailerCode: this.props.retailerCode,
      productCode: this.props.productCode,
      units: this.props.units,
      status: this.props.status,
    };
  }
}
