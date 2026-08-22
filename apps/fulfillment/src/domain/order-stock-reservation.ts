// The order-scoped operation — a PURE domain service, not an aggregate
// method (design.md §3.3). An order's lines name different products, and a
// `StockItem` is one `(companyCode, productCode)`; **F3** ("either every
// line of the order is reserved, or none is") is therefore a rule ACROSS
// aggregates, and R32/R33 ask for exactly one fact per order — not one per
// item. `StockItem.recordOrderFact` accepts only an envelope whose
// `aggregateId` is its own, so this service cannot be misused as a generic
// emitter.
import type { OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { ReservationRef, Shortage, StockReleasedPayload } from '@otc/contracts';
import { stockRejectedEvent, stockReleasedEvent, stockReservedEvent } from './stock-events.js';
import type { StockContext, StockItem } from './stock-item.js';

export interface ReserveOrderLine {
  readonly productCode: string;
  readonly units: Quantity;
}

export interface ReserveOrderInput {
  readonly orderReference: OrderNumber;
  readonly companyCode: string;
  readonly retailerCode: string;
  readonly lines: readonly ReserveOrderLine[];
  /** The order id, from `x-correlation-id` (FS3) — becomes the fact's `correlationId`. */
  readonly correlationId: UniqueId;
}

export type ReserveOrderOutcome =
  | { readonly kind: 'reserved'; readonly reservations: readonly ReservationRef[]; readonly carrier: StockItem }
  | {
      readonly kind: 'rejected';
      readonly shortages: readonly Shortage[];
      readonly reason: 'insufficient_stock' | 'unknown_product';
      /** `null` when NO line resolves to a known item — there is no carrier aggregate for a fact; the caller replies `NOT_FOUND` instead (design.md §3.3). */
      readonly carrier: StockItem | null;
    };

/**
 * ALL-OR-NOTHING (F3): evaluates every line against `items` (keyed by
 * `productCode`) first; only if every line is satisfiable does it call
 * `reserve` on each item. Unknown `productCode` => that line is short with
 * `available: 0` and the reason is `unknown_product` (FS8). A repeated
 * product across two lines sums for the availability check, but still
 * yields one reservation per LINE. Appends exactly one fact to the carrier
 * (FS13) — `stock.reserved.v1` or `stock.rejected.v1` — via
 * `carrier.recordOrderFact`. Pure: no I/O, no clock, no ids generated
 * except the reservation ids the caller supplies through `newId`.
 */
export function reserveOrderStock(
  items: readonly StockItem[],
  input: ReserveOrderInput,
  ctx: StockContext,
  newId: () => UniqueId,
): ReserveOrderOutcome {
  const byProduct = new Map(items.map((item) => [item.productCode, item] as const));

  const requestedTotalByProduct = new Map<string, number>();
  for (const line of input.lines) {
    requestedTotalByProduct.set(line.productCode, (requestedTotalByProduct.get(line.productCode) ?? 0) + line.units.value);
  }

  const shortages: Shortage[] = [];
  let anyUnknown = false;
  let firstKnownItem: StockItem | undefined;

  for (const line of input.lines) {
    const item = byProduct.get(line.productCode);
    if (!item) {
      anyUnknown = true;
      shortages.push({ productCode: line.productCode, requested: line.units.value, available: 0 });
      continue;
    }
    if (!firstKnownItem) {
      firstKnownItem = item;
    }
    const totalRequested = requestedTotalByProduct.get(line.productCode)!;
    if (totalRequested > item.availableUnits) {
      shortages.push({ productCode: line.productCode, requested: line.units.value, available: item.availableUnits });
    }
  }

  if (shortages.length > 0) {
    const reason: 'insufficient_stock' | 'unknown_product' = anyUnknown ? 'unknown_product' : 'insufficient_stock';
    const carrier = firstKnownItem ?? null;
    const nonEmptyShortages = shortages as [Shortage, ...Shortage[]];
    if (carrier) {
      const event = stockRejectedEvent(
        carrier,
        {
          orderReference: input.orderReference,
          companyCode: input.companyCode,
          retailerCode: input.retailerCode,
          shortages: nonEmptyShortages,
          reason,
        },
        input.correlationId,
        ctx,
      );
      carrier.recordOrderFact(event);
    }
    return { kind: 'rejected', shortages, reason, carrier };
  }

  // Every line is satisfiable — reserve them all, in line order.
  const carrier = firstKnownItem!;
  const reservations: ReservationRef[] = [];
  for (const line of input.lines) {
    const item = byProduct.get(line.productCode)!;
    const reservation = item.reserve({
      reservationId: newId(),
      orderReference: input.orderReference,
      retailerCode: input.retailerCode,
      units: line.units,
    });
    reservations.push({ reservationId: reservation.id.value, productCode: reservation.productCode, units: reservation.units.value });
  }

  const nonEmptyReservations = reservations as [ReservationRef, ...ReservationRef[]];
  const event = stockReservedEvent(
    carrier,
    {
      orderReference: input.orderReference,
      companyCode: input.companyCode,
      retailerCode: input.retailerCode,
      reservations: nonEmptyReservations,
    },
    input.correlationId,
    ctx,
  );
  carrier.recordOrderFact(event);

  return { kind: 'reserved', reservations, carrier };
}

export type ReleaseOrderOutcome =
  | { readonly kind: 'released'; readonly released: readonly ReservationRef[]; readonly carrier: StockItem }
  // Nothing was `reserved` on any item — no fact, no counter change (F5, R34, FS9).
  | { readonly kind: 'already_released' };

/**
 * Calls `release(orderReference)` on every item; if the union of released
 * reservations is non-empty, appends ONE `stock.released.v1` (reason from
 * the request) to the carrier = the item of the FIRST released reservation
 * (FS13). Throws `ReservationTerminalError` through from any item holding a
 * `consumed` reservation of this order (FS10) — nothing is mutated on the
 * other items either, because the handler's transaction rolls back.
 */
export function releaseOrderStock(
  items: readonly StockItem[],
  input: {
    readonly orderReference: OrderNumber;
    readonly companyCode: string;
    readonly reason: StockReleasedPayload['reason'];
    readonly correlationId: UniqueId;
  },
  ctx: StockContext,
): ReleaseOrderOutcome {
  let carrier: StockItem | undefined;
  let carrierRetailerCode: string | undefined;
  const released: ReservationRef[] = [];

  for (const item of items) {
    const releasedOnThisItem = item.release(input.orderReference);
    for (const reservation of releasedOnThisItem) {
      released.push({ reservationId: reservation.id.value, productCode: reservation.productCode, units: reservation.units.value });
      if (!carrier) {
        carrier = item;
        carrierRetailerCode = reservation.retailerCode;
      }
    }
  }

  if (released.length === 0) {
    return { kind: 'already_released' };
  }

  const nonEmptyReleased = released as [ReservationRef, ...ReservationRef[]];
  const event = stockReleasedEvent(
    carrier!,
    {
      orderReference: input.orderReference,
      companyCode: input.companyCode,
      retailerCode: carrierRetailerCode,
      released: nonEmptyReleased,
      reason: input.reason,
    },
    input.correlationId,
    ctx,
  );
  carrier!.recordOrderFact(event);

  return { kind: 'released', released, carrier: carrier! };
}
