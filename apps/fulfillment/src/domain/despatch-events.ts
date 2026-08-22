// The one fact builder `order-despatch.ts`'s `createDespatchForOrder` uses,
// via `DespatchAdvice.create` — mirrors `stock-events.ts` exactly:
// `createDomainEvent` from `@otc/shared-kernel`, the payload type from
// `@otc/contracts` (`import type` only), the same `Indexed<TPayload>`
// intersection trick, `correlationId` = the order id, `aggregateId` = the
// DespatchAdvice's OWN id (it is the aggregate that produced this fact —
// domain-model.md §7.1 — unlike `stock.reserved.v1`/`stock.released.v1`,
// which pick a StockItem as their carrier because no despatch exists yet at
// that point in the saga).
import { createDomainEvent, type DomainEventEnvelope, type UniqueId } from '@otc/shared-kernel';
import type { DespatchLine, OrderDespatchedPayload } from '@otc/contracts';
import type { DespatchAdvice } from './despatch-advice.js';
import type { StockContext } from './stock-item.js';

type Indexed<TPayload> = TPayload & Record<string, unknown>;

export function orderDespatchedEvent(
  despatch: DespatchAdvice,
  correlationId: UniqueId,
  ctx: StockContext,
): DomainEventEnvelope<Indexed<OrderDespatchedPayload>> {
  const lines = despatch.lines.map<DespatchLine>((line) => ({
    productCode: line.productCode,
    units: line.units.value,
  })) as [DespatchLine, ...DespatchLine[]];

  const payload: OrderDespatchedPayload = {
    orderReference: despatch.orderReference.value,
    despatchReference: despatch.despatchReference.value,
    despatchDate: despatch.despatchDate.toISOString(),
    companyCode: despatch.companyCode,
    retailerCode: despatch.retailerCode,
    lines,
  };

  return createDomainEvent<Indexed<OrderDespatchedPayload>>({
    eventType: 'order.despatched.v1',
    aggregateId: despatch.id,
    correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<OrderDespatchedPayload>,
  });
}
