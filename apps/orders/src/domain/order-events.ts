// The four fact builders Orders itself emits — design.md §6:
// `order.placed.v1`, `order.confirmed.v1`, `order.completed.v1`,
// `order.cancelled.v1`. Built with `createDomainEvent` from
// `@otc/shared-kernel` and payload types from `@otc/contracts`
// (`import type` only, erased at compile time — no runtime dependency on
// the generated package). `correlationId = aggregateId = order.id` always
// (R12); `causationId`/`occurredAt` come from the `TransitionContext`, never
// from a clock read here.
import { createDomainEvent, type DomainEventEnvelope } from '@otc/shared-kernel';
import type {
  CompensationStep,
  OrderCancelledPayload,
  OrderCompletedPayload,
  OrderConfirmedPayload,
  OrderLine as OrderLinePayload,
  OrderPlacedPayload,
} from '@otc/contracts';
import type { CancellationReason } from './order-cancellation-reason.js';
import type { Order, TransitionContext } from './order.js';

/**
 * `createDomainEvent`'s generic parameter (and `DomainEventEnvelope`'s own)
 * is constrained to `Record<string, unknown>`. A generated `@otc/contracts`
 * payload interface has no index signature, so — as
 * `apps/seed/src/data/sagas.data.ts` documents at its `OutboxFixture.payload`
 * field — TypeScript refuses the generic instantiation even though the
 * interface is structurally compatible with the constraint. Intersecting
 * with `Record<string, unknown>` gives the type an index signature without
 * changing its real shape (every field of `TPayload` is still required and
 * still typed exactly as `@otc/contracts` declares it); the intersection is
 * assignable to `TPayload` in both directions that matter here, so no
 * information is lost and no unsafe cast crosses a value boundary.
 */
type Indexed<TPayload> = TPayload & Record<string, unknown>;

export function orderPlacedEvent(
  order: Order,
  ctx: TransitionContext,
): DomainEventEnvelope<Indexed<OrderPlacedPayload>> {
  const payload: OrderPlacedPayload = {
    orderReference: order.orderReference.value,
    retailerCode: order.retailerCode,
    companyCode: order.companyCode,
    buyerGln: order.buyerGln.value,
    supplierGln: order.supplierGln.value,
    currency: order.currency,
    orderDate: order.orderDate.toISOString(),
    lines: toNonEmptyLinesPayload(order),
    initialAmount: order.initialAmount.amount,
    initialDiscount: order.initialDiscount.amount,
    totalAmount: order.totalAmount.amount,
    ...(order.notes !== undefined ? { notes: order.notes } : {}),
  };
  return createDomainEvent<Indexed<OrderPlacedPayload>>({
    eventType: 'order.placed.v1',
    aggregateId: order.id,
    correlationId: order.id,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<OrderPlacedPayload>,
  });
}

export function orderConfirmedEvent(
  order: Order,
  ctx: TransitionContext,
): DomainEventEnvelope<Indexed<OrderConfirmedPayload>> {
  const payload: OrderConfirmedPayload = {
    orderReference: order.orderReference.value,
    retailerCode: order.retailerCode,
    companyCode: order.companyCode,
    currency: order.currency,
    totalAmount: order.totalAmount.amount,
    confirmedAt: ctx.occurredAt.toISOString(),
  };
  return createDomainEvent<Indexed<OrderConfirmedPayload>>({
    eventType: 'order.confirmed.v1',
    aggregateId: order.id,
    correlationId: order.id,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<OrderConfirmedPayload>,
  });
}

export function orderCompletedEvent(
  order: Order,
  ctx: TransitionContext,
): DomainEventEnvelope<Indexed<OrderCompletedPayload>> {
  const payload: OrderCompletedPayload = {
    orderReference: order.orderReference.value,
    retailerCode: order.retailerCode,
    companyCode: order.companyCode,
    currency: order.currency,
    totalAmount: order.totalAmount.amount,
    completedAt: ctx.occurredAt.toISOString(),
  };
  return createDomainEvent<Indexed<OrderCompletedPayload>>({
    eventType: 'order.completed.v1',
    aggregateId: order.id,
    correlationId: order.id,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<OrderCompletedPayload>,
  });
}

export function orderCancelledEvent(
  order: Order,
  reason: CancellationReason,
  compensationSteps: readonly CompensationStep[],
  ctx: TransitionContext,
): DomainEventEnvelope<Indexed<OrderCancelledPayload>> {
  const payload: OrderCancelledPayload = {
    orderReference: order.orderReference.value,
    retailerCode: order.retailerCode,
    companyCode: order.companyCode,
    cancellationReason: reason,
    cancelledAt: ctx.occurredAt.toISOString(),
    compensationSteps: [...compensationSteps],
  };
  return createDomainEvent<Indexed<OrderCancelledPayload>>({
    eventType: 'order.cancelled.v1',
    aggregateId: order.id,
    correlationId: order.id,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<OrderCancelledPayload>,
  });
}

function toNonEmptyLinesPayload(order: Order): [OrderLinePayload, ...OrderLinePayload[]] {
  const lines = order.lines.map<OrderLinePayload>((line) => ({
    productCode: line.productCode,
    description: line.description,
    quantity: line.quantity.value,
    unitPrice: line.unitPrice.amount,
    lineDiscount: line.lineDiscount.amount,
  }));
  // O1 / R5 already guarantee at least one line exists on any Order that
  // reaches this builder; this is a narrowing assertion, not a re-check —
  // `OrderPlacedPayload.lines` is a non-empty tuple type and casting
  // blindly would hide a future regression instead of surfacing it here.
  if (lines.length === 0) {
    throw new Error('order-events: orderPlacedEvent built from an order with no lines');
  }
  return lines as [OrderLinePayload, ...OrderLinePayload[]];
}
