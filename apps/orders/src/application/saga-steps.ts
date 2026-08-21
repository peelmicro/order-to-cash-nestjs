// The 13-fact step table as data (design.md §4) — the direct transcription
// of saga.md §3.1/§4 plus the consumption map §5. Pure data + pure
// functions, framework-free: no port, no clock, no DB. Every fact ×
// every status is unit-tested exhaustively in saga-steps.spec.ts.
import type { CompensationStep, Envelope, StockReleasedPayload } from '@otc/contracts';
import { UniqueId } from '@otc/shared-kernel';
import type { CancellationReason } from '../domain/order-cancellation-reason.js';
import type { Order, TransitionContext } from '../domain/order.js';
import type { OrderStatus } from '../domain/order-status.js';

/** The five outbound saga commands (design.md §6.1) — the closed set `commandAfter` may name. */
export const SAGA_COMMAND_KINDS = [
  'stock.reserve',
  'stock.release',
  'despatch.create',
  'credit.hold',
  'invoice.issue',
] as const;

export type SagaCommandKind = (typeof SAGA_COMMAND_KINDS)[number];

export type SagaStep =
  | { readonly kind: 'skip' }
  | {
      readonly kind: 'advance';
      readonly precondition: OrderStatus;
      readonly apply: (order: Order, ctx: TransitionContext, fact: Envelope) => void;
      readonly commandAfter?: SagaCommandKind;
    }
  | {
      readonly kind: 'cancel';
      readonly precondition: OrderStatus;
      readonly reason: (fact: Envelope) => CancellationReason;
      readonly compensationSteps: (fact: Envelope) => readonly CompensationStep[];
    };

/** `ctx.occurredAt` = the fact's own `occurredAt` (when it became true in the domain); `ctx.causationId` = the fact's `eventId` (design.md §4.1, R12). */
export function transitionContextFrom(fact: Envelope): TransitionContext {
  return {
    occurredAt: new Date(fact.occurredAt),
    causationId: UniqueId.from(fact.eventId),
  };
}

/**
 * `StockReleasedPayload.reason` -> `CancellationReason` (SO7, design.md
 * §4.3): the fact's own field is the ONLY place "pending compensation is a
 * credit rejection" is knowable — there is no saga-instance record.
 */
export function mapReason(reason: StockReleasedPayload['reason']): CancellationReason {
  switch (reason) {
    case 'credit_rejected':
      return 'credit_rejected';
    case 'order_cancelled':
      return 'operator_cancelled';
    default: {
      const exhaustive: never = reason;
      throw new Error(`saga-steps: mapReason: unmapped stock.released.v1 reason "${String(exhaustive)}"`);
    }
  }
}

/** Builds the one-element `compensationSteps` array from the OBSERVED `stock.released.v1` fact (SO7) — the aggregate never sees the fact itself, only what this function hands it. */
export function stepsFrom(fact: Envelope): readonly CompensationStep[] {
  const payload = fact.payload as StockReleasedPayload;
  return [
    {
      step: 'stock_released',
      eventId: fact.eventId,
      eventType: fact.eventType,
      occurredAt: fact.occurredAt,
      summary: `stock released — reason: ${payload.reason}`,
    },
  ];
}

/** Table T-1 (design.md §4.1) — the direct transcription of saga.md §3.1/§4/§5, one entry per one of the 13 fact types this service ever sees on its three consumed topics. */
export const SAGA_STEPS: Readonly<Record<string, SagaStep>> = {
  'order.placed.v1': {
    kind: 'advance',
    precondition: 'placed',
    // R19: status unchanged on this edge — the order is already `placed`
    // from `PlaceOrderHandler` (feature 15); this fact only triggers the
    // owed `stock.reserve` command.
    apply: () => {
      /* no-op — R19 */
    },
    commandAfter: 'stock.reserve',
  },
  'stock.reserved.v1': {
    kind: 'advance',
    precondition: 'placed',
    apply: (order, ctx) => order.markStockReserved(ctx),
    commandAfter: 'credit.hold',
  },
  'stock.rejected.v1': {
    kind: 'cancel',
    precondition: 'placed',
    // R26 — reservation is all-or-nothing: nothing was acquired, nothing to release.
    reason: () => 'stock_rejected',
    compensationSteps: () => [],
  },
  'credit.approved.v1': {
    kind: 'advance',
    precondition: 'stock_reserved',
    // One load/save, one order.confirmed.v1 (R21) — both edges applied to the same aggregate instance before it is saved once.
    apply: (order, ctx) => {
      order.approveCredit(ctx);
      order.confirm(ctx);
    },
    commandAfter: 'despatch.create',
  },
  'credit.rejected.v1': {
    kind: 'advance',
    precondition: 'stock_reserved',
    // R27 — status unchanged; the order stays in the safe, resumable stock_reserved state until stock.released.v1 completes the compensation (design.md §4.3).
    apply: () => {
      /* no-op — R27 */
    },
    commandAfter: 'stock.release',
  },
  'stock.released.v1': {
    kind: 'cancel',
    precondition: 'stock_reserved',
    reason: (fact) => mapReason((fact.payload as StockReleasedPayload).reason),
    compensationSteps: (fact) => stepsFrom(fact),
  },
  'order.despatched.v1': {
    kind: 'advance',
    precondition: 'confirmed',
    apply: (order, ctx) => order.markDespatched(ctx),
    commandAfter: 'invoice.issue',
  },
  'invoice.issued.v1': {
    kind: 'advance',
    precondition: 'despatched',
    // R23 — no command owed: the saga now waits for the outside world (a remittance).
    apply: (order, ctx) => order.markInvoiced(ctx),
  },
  'payment.received.v1': {
    kind: 'advance',
    precondition: 'invoiced',
    apply: (order, ctx) => order.markPaid(ctx),
  },
  'credit.released.v1': {
    kind: 'advance',
    precondition: 'paid',
    // R24 — emits order.completed.v1, closing the saga.
    apply: (order, ctx) => order.complete(ctx),
  },
  // The three facts Orders produces itself (SO2) — consuming them would be
  // a loop (saga.md §5). Skipped before any I/O by the caller.
  'order.confirmed.v1': { kind: 'skip' },
  'order.completed.v1': { kind: 'skip' },
  'order.cancelled.v1': { kind: 'skip' },
};

export function stepFor(eventType: string): SagaStep | undefined {
  return SAGA_STEPS[eventType];
}
