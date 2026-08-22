// The three order-scoped fact builders `order-stock-reservation.ts` uses —
// design.md §3.3. Mirrors `apps/orders/src/domain/order-events.ts` exactly:
// `createDomainEvent` from `@otc/shared-kernel`, payload types from
// `@otc/contracts` (`import type` only), the same `Indexed<TPayload>`
// intersection trick that file documents, `correlationId` = the order id
// (from `x-correlation-id`, FS3), `aggregateId` = the carrier stock item's
// id, `causationId`/`occurredAt` from `StockContext`. `retailerCode` is
// included in all three payloads — optional in the schema, always known
// here.
import { createDomainEvent, type DomainEventEnvelope, type OrderNumber, type UniqueId } from '@otc/shared-kernel';
import type { ReservationRef, Shortage, StockRejectedPayload, StockReleasedPayload, StockReservedPayload } from '@otc/contracts';
import type { StockContext, StockItem } from './stock-item.js';

/**
 * `createDomainEvent`'s generic parameter is constrained to
 * `Record<string, unknown>`; a generated `@otc/contracts` payload interface
 * has no index signature, so intersecting with `Record<string, unknown>`
 * gives the type an index signature without changing its real shape — the
 * same precedent `apps/orders/src/domain/order-events.ts` documents.
 */
type Indexed<TPayload> = TPayload & Record<string, unknown>;

export function stockReservedEvent(
  carrier: StockItem,
  input: {
    readonly orderReference: OrderNumber;
    readonly companyCode: string;
    readonly retailerCode: string;
    readonly reservations: [ReservationRef, ...ReservationRef[]];
  },
  correlationId: UniqueId,
  ctx: StockContext,
): DomainEventEnvelope<Indexed<StockReservedPayload>> {
  const payload: StockReservedPayload = {
    orderReference: input.orderReference.value,
    companyCode: input.companyCode,
    retailerCode: input.retailerCode,
    reservations: input.reservations,
  };
  return createDomainEvent<Indexed<StockReservedPayload>>({
    eventType: 'stock.reserved.v1',
    aggregateId: carrier.id,
    correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<StockReservedPayload>,
  });
}

export function stockRejectedEvent(
  carrier: StockItem,
  input: {
    readonly orderReference: OrderNumber;
    readonly companyCode: string;
    readonly retailerCode?: string;
    readonly shortages: [Shortage, ...Shortage[]];
    readonly reason: 'insufficient_stock' | 'unknown_product';
  },
  correlationId: UniqueId,
  ctx: StockContext,
): DomainEventEnvelope<Indexed<StockRejectedPayload>> {
  const payload: StockRejectedPayload = {
    orderReference: input.orderReference.value,
    companyCode: input.companyCode,
    ...(input.retailerCode !== undefined ? { retailerCode: input.retailerCode } : {}),
    shortages: input.shortages,
    reason: input.reason,
  };
  return createDomainEvent<Indexed<StockRejectedPayload>>({
    eventType: 'stock.rejected.v1',
    aggregateId: carrier.id,
    correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<StockRejectedPayload>,
  });
}

export function stockReleasedEvent(
  carrier: StockItem,
  input: {
    readonly orderReference: OrderNumber;
    readonly companyCode: string;
    readonly retailerCode?: string;
    readonly released: [ReservationRef, ...ReservationRef[]];
    readonly reason: StockReleasedPayload['reason'];
  },
  correlationId: UniqueId,
  ctx: StockContext,
): DomainEventEnvelope<Indexed<StockReleasedPayload>> {
  const payload: StockReleasedPayload = {
    orderReference: input.orderReference.value,
    companyCode: input.companyCode,
    ...(input.retailerCode !== undefined ? { retailerCode: input.retailerCode } : {}),
    released: input.released,
    reason: input.reason,
  };
  return createDomainEvent<Indexed<StockReleasedPayload>>({
    eventType: 'stock.released.v1',
    aggregateId: carrier.id,
    correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<StockReleasedPayload>,
  });
}
