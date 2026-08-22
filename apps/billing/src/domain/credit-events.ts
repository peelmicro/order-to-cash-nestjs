// The three fact builders `BuyerCredit` uses — design.md §3.4. Mirrors
// `apps/fulfillment/src/domain/stock-events.ts` exactly: `createDomainEvent`
// from `@otc/shared-kernel`, payload types from `@otc/contracts`
// (`import type` only), the same `Indexed<TPayload>` intersection trick,
// `correlationId` = the order id, `aggregateId` = the credit line's own id
// (domain-model.md §7.2 facts 5/6/7 name `BuyerCredit` as the producing
// aggregate), `causationId`/`occurredAt` from `CreditContext`. `creditCode`
// is included in all three payloads.
//
// **`credit.rejected.v1` has exactly ONE builder and exactly ONE call
// site** — `BuyerCredit.refuseHold`. There is no separate branch for an
// adapter refusal anywhere in the domain, the application layer, the
// outbox record or the RPC reply — a genuine `over_limit` fact and a
// simulated one are produced by the same lines of code and differ in the
// one string that was passed in (`BC14`, `R44`).
import { createDomainEvent, type DomainEventEnvelope, type OrderNumber, type UniqueId } from '@otc/shared-kernel';
import type { CreditApprovedPayload, CreditRejectedPayload, CreditReleasedPayload } from '@otc/contracts';
import type { BuyerCredit, CreditContext } from './buyer-credit.js';

/**
 * `createDomainEvent`'s generic parameter is constrained to
 * `Record<string, unknown>`; a generated `@otc/contracts` payload interface
 * has no index signature, so intersecting with `Record<string, unknown>`
 * gives the type an index signature without changing its real shape — the
 * same precedent `apps/orders/src/domain/order-events.ts` documents.
 */
type Indexed<TPayload> = TPayload & Record<string, unknown>;

/** `over_limit` is the aggregate's own word; the adapter's vocabulary is `Exclude<CreditRejectionReason, 'over_limit'>` (application/ports/credit-decision.port.ts). */
export type CreditRejectionReason = CreditRejectedPayload['reason'];
export type CreditReleaseReason = CreditReleasedPayload['reason'];

export function creditApprovedEvent(
  carrier: BuyerCredit,
  input: {
    readonly orderReference: OrderNumber;
    readonly retailerCode: string;
    readonly companyCode: string;
    readonly currency: string;
    readonly heldAmount: number;
    readonly availableCreditAfter: number;
  },
  correlationId: UniqueId,
  ctx: CreditContext,
): DomainEventEnvelope<Indexed<CreditApprovedPayload>> {
  const payload: CreditApprovedPayload = {
    orderReference: input.orderReference.value,
    retailerCode: input.retailerCode,
    companyCode: input.companyCode,
    creditCode: carrier.code.value,
    currency: input.currency,
    heldAmount: input.heldAmount,
    availableCreditAfter: input.availableCreditAfter,
  };
  return createDomainEvent<Indexed<CreditApprovedPayload>>({
    eventType: 'credit.approved.v1',
    aggregateId: carrier.id,
    correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<CreditApprovedPayload>,
  });
}

/** ONE builder, ONE call site (`BuyerCredit.refuseHold`) — a genuine `over_limit` refusal and an adapter refusal (feature 20) are built by these same lines and differ only in `reason` (`BC14`, `R44`). */
export function creditRejectedEvent(
  carrier: BuyerCredit,
  input: {
    readonly orderReference: OrderNumber;
    readonly retailerCode: string;
    readonly companyCode: string;
    readonly currency: string;
    readonly requestedAmount: number;
    readonly availableCredit: number;
    readonly reason: CreditRejectionReason;
  },
  correlationId: UniqueId,
  ctx: CreditContext,
): DomainEventEnvelope<Indexed<CreditRejectedPayload>> {
  const payload: CreditRejectedPayload = {
    orderReference: input.orderReference.value,
    retailerCode: input.retailerCode,
    companyCode: input.companyCode,
    creditCode: carrier.code.value,
    currency: input.currency,
    requestedAmount: input.requestedAmount,
    availableCredit: input.availableCredit,
    reason: input.reason,
  };
  return createDomainEvent<Indexed<CreditRejectedPayload>>({
    eventType: 'credit.rejected.v1',
    aggregateId: carrier.id,
    correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<CreditRejectedPayload>,
  });
}

export function creditReleasedEvent(
  carrier: BuyerCredit,
  input: {
    readonly orderReference: OrderNumber;
    readonly retailerCode: string;
    readonly companyCode: string;
    readonly currency: string;
    readonly releasedAmount: number;
    readonly availableCreditAfter: number;
    readonly reason: CreditReleaseReason;
  },
  correlationId: UniqueId,
  ctx: CreditContext,
): DomainEventEnvelope<Indexed<CreditReleasedPayload>> {
  const payload: CreditReleasedPayload = {
    orderReference: input.orderReference.value,
    retailerCode: input.retailerCode,
    companyCode: input.companyCode,
    creditCode: carrier.code.value,
    currency: input.currency,
    releasedAmount: input.releasedAmount,
    availableCreditAfter: input.availableCreditAfter,
    reason: input.reason,
  };
  return createDomainEvent<Indexed<CreditReleasedPayload>>({
    eventType: 'credit.released.v1',
    aggregateId: carrier.id,
    correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    payload: payload as Indexed<CreditReleasedPayload>,
  });
}
