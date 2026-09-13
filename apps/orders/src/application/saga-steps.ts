// The 13-fact step table as data (design.md §4) — the direct transcription
// of saga.md §3.1/§4 plus the consumption map §5. Pure data + pure
// functions, framework-free: no port, no clock, no DB. Every fact ×
// every status is unit-tested exhaustively in saga-steps.spec.ts.
import type { CompensationStep, CreditReleasedPayload, Envelope, StockReleasedPayload } from '@otc/contracts';
import { UniqueId } from '@otc/shared-kernel';
import type { CancellationReason } from '../domain/order-cancellation-reason.js';
import type { Order, TransitionContext } from '../domain/order.js';
import type { OrderStatus } from '../domain/order-status.js';

/**
 * The six outbound saga commands (design.md §6.1, extended by feature 41's
 * follow-up pass and re-pointed by SA-4) — the closed set `commandAfter`
 * may name. SA-4 swapped which of the two releases each side owns:
 * `credit.release` is now named by a step-table row (`stock.released.v1`'s
 * `credit_approved`/`confirmed` variants), and `stock.release` is what
 * `CancelOrderHandler` enqueues DIRECTLY for every operator cancellation —
 * the "outside the fact-driven table, same durable mechanism" shape, now
 * used by all three compensating statuses.
 */
export const SAGA_COMMAND_KINDS = [
  'stock.reserve',
  'stock.release',
  'despatch.create',
  'credit.hold',
  'invoice.issue',
  'credit.release',
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

/**
 * `CreditReleasedPayload.reason` -> `CancellationReason` for
 * `credit.released.v1`'s `credit_approved`/`confirmed` variants (SA-4) —
 * `mapReason`'s mirror for the OTHER completing fact. `order_cancelled` is
 * the only reason ever legal at those statuses (Billing's
 * `billing.credit.release` responder always releases with it; the RPC has
 * no caller-chosen reason at all), and `invoice_paid` reaches this fact
 * type only on the SEPARATE `paid` advance variant, which never calls this.
 * Read from the fact rather than returned as a constant deliberately: a
 * constant would make the terminal cancellation's reason unfalsifiable by
 * anything on the wire.
 */
export function mapCreditReleaseReason(reason: CreditReleasedPayload['reason']): CancellationReason {
  if (reason !== 'order_cancelled') {
    throw new Error(`saga-steps: mapCreditReleaseReason: credit.released.v1 carried reason "${String(reason)}" at credit_approved/confirmed — expected order_cancelled`);
  }
  return 'operator_cancelled';
}

/**
 * `credit.released.v1`'s `credit_approved`/`confirmed` variants below (the
 * TERMINAL step of an operator cancellation since SA-4): TWO acquisitions
 * are unwound in this branch — stock reservation FIRST (the contested
 * resource, saga.md §4.3's "The despatch already requested"), then the
 * credit hold — so `compensationSteps` names both, in that order, not only
 * the CURRENT triggering fact (`stepsFrom` below reports only the ONE fact
 * it is handed).
 *
 * SA-4 inverted WHICH of the two has to be synthesised; the trade-off
 * itself is unchanged. This step-table function has no saga-instance record
 * of the EARLIER `stock.released.v1` fact's own `eventId`/`occurredAt` —
 * this codebase keeps no such cross-fact state anywhere (`saga-steps.ts`'s
 * own module header: "the aggregate never sees the fact itself, only what
 * this function hands it") — so the synthesised `stock_released` entry
 * below deliberately carries NO `eventId` (the schema's own field is
 * optional, `CompensationStep.eventId?`) and reuses the CURRENT fact's
 * `occurredAt` rather than fabricate an earlier one; a reader tracing
 * `order.cancelled.v1`'s `compensationSteps` back to the stock release's
 * OWN outbox row must join on `(orderReference, eventType)` instead of a
 * direct `eventId`, a known, disclosed limitation, not a silent gap.
 */
function stepsFromStockThenCreditRelease(fact: Envelope): readonly CompensationStep[] {
  return [
    {
      step: 'stock_released',
      eventType: 'stock.released.v1',
      occurredAt: fact.occurredAt,
      summary:
        'stock released — reason: order_cancelled (the contested resource, released FIRST so Fulfillment\'s own lock can arbitrate it against a despatch already requested — saga.md §4.3)',
    },
    {
      step: 'credit_released',
      eventId: fact.eventId,
      eventType: fact.eventType,
      occurredAt: fact.occurredAt,
      summary: 'credit released — reason: order_cancelled',
    },
  ];
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

/**
 * `SAGA_STEPS`'s value type: MOST fact types have exactly one legal
 * precondition (one `SagaStep`); `credit.released.v1` and
 * `stock.released.v1` (the `credit_approved`/`confirmed` operator-cancel
 * branch) are the two fact types with
 * more than one — an array of variants, each with its OWN precondition.
 * `stepForStatus` selects the one variant (if any) whose precondition
 * matches the order's CURRENT status; `stepFor` (kept for every existing
 * single-variant caller/test, unchanged) refuses an ambiguous
 * multi-variant lookup rather than silently picking one.
 */
type SagaStepEntry = SagaStep | readonly SagaStep[];

/** Table T-1 (design.md §4.1) — the direct transcription of saga.md §3.1/§4/§5, one entry per one of the 13 fact types this service ever sees on its three consumed topics. */
export const SAGA_STEPS: Readonly<Record<string, SagaStepEntry>> = {
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
  // Three variants. SA-4 re-pointed the second and third:
  //   - `stock_reserved` (R28, SO7, UNCHANGED): compensation path B's
  //     terminal fact — reached either from `credit.rejected.v1`'s
  //     automatic compensation or the operator-cancel-while-`stock_reserved`
  //     branch (`cancel-order.handler.ts`).
  //   - `credit_approved`/`confirmed`: the operator cancellation's FIRST
  //     release, and the one that had to be raced. `CancelOrderHandler`
  //     enqueues `stock.release` directly; this fact arriving means the
  //     release WON Fulfillment's one lock against the `despatch.create`
  //     already in flight, so the credit hold may now safely be returned —
  //     an ADVANCE owing `credit.release`, deliberately with NO transition
  //     (mirroring `credit.rejected.v1`'s own R27 no-op): the order stays
  //     `credit_approved`/`confirmed` until `credit.released.v1` completes
  //     the cancellation below. Had the DESPATCH won instead, no
  //     `stock.released.v1` is emitted at all, this variant is never
  //     reached, and no `credit.release` is ever issued — which is the
  //     whole point of releasing stock first (saga.md §4.3).
  'stock.released.v1': [
    {
      kind: 'cancel',
      precondition: 'stock_reserved',
      reason: (fact) => mapReason((fact.payload as StockReleasedPayload).reason),
      compensationSteps: (fact) => stepsFrom(fact),
    },
    {
      kind: 'advance',
      precondition: 'credit_approved',
      apply: () => {
        /* no-op — status unchanged until credit.released.v1 arrives */
      },
      commandAfter: 'credit.release',
    },
    {
      kind: 'advance',
      precondition: 'confirmed',
      apply: () => {
        /* no-op — status unchanged until credit.released.v1 arrives */
      },
      commandAfter: 'credit.release',
    },
  ],
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
  // Three variants. SA-4 re-pointed the second and third:
  //   - `paid` (R24, UNCHANGED): the happy-path release after payment —
  //     completes the saga.
  //   - `credit_approved`/`confirmed`: the operator cancellation's SECOND
  //     and FINAL release, and therefore the step that actually cancels.
  //     The stock was released first and `stock.released.v1`'s own variant
  //     above owed this `credit.release`; this fact arriving completes the
  //     chain, so `compensationSteps` names BOTH releases in release order
  //     (`stepsFromStockThenCreditRelease`, this file's own function above)
  //     — not only this one fact, unlike every other `cancel`-kind step.
  //     `reason` on the incoming fact is always `order_cancelled` here
  //     (Billing's `CreditReleaseHandler` releases with no other reason via
  //     this RPC; the ONLY way `credit.released.v1` carries `invoice_paid`
  //     is PaymentRegisterHandler's own internal call, which the R47 outbox
  //     ordering guarantees is never observed before the order has already
  //     advanced to `paid`) — asserted, not merely assumed, by
  //     `mapCreditReleaseReason` above.
  'credit.released.v1': [
    {
      kind: 'advance',
      precondition: 'paid',
      // R24 — emits order.completed.v1, closing the saga.
      apply: (order, ctx) => order.complete(ctx),
    },
    {
      kind: 'cancel',
      precondition: 'credit_approved',
      reason: (fact) => mapCreditReleaseReason((fact.payload as CreditReleasedPayload).reason),
      compensationSteps: (fact) => stepsFromStockThenCreditRelease(fact),
    },
    {
      kind: 'cancel',
      precondition: 'confirmed',
      reason: (fact) => mapCreditReleaseReason((fact.payload as CreditReleasedPayload).reason),
      compensationSteps: (fact) => stepsFromStockThenCreditRelease(fact),
    },
  ],
  // The three facts Orders produces itself (SO2) — consuming them would be
  // a loop (saga.md §5). Skipped before any I/O by the caller.
  'order.confirmed.v1': { kind: 'skip' },
  'order.completed.v1': { kind: 'skip' },
  'order.cancelled.v1': { kind: 'skip' },
};

/** Every variant declared for `eventType` — `[]` when the table has no entry at all, one-element for every single-variant fact type, three for `credit.released.v1`/`stock.released.v1`. */
export function stepVariantsFor(eventType: string): readonly SagaStep[] {
  const entry = SAGA_STEPS[eventType];
  if (entry === undefined) {
    return [];
  }
  return Array.isArray(entry) ? (entry as readonly SagaStep[]) : [entry as SagaStep];
}

/**
 * `SagaFactHandler`'s ONE lookup — selects the variant (if any) whose
 * precondition matches `status` (R25's equality-only rule, extended
 * unchanged to fact types with more than one legal precondition).
 * `undefined` means R25's precondition-unmet case: no variant applies,
 * whether the fact type has one legal status or several.
 */
export function stepForStatus(eventType: string, status: OrderStatus): Exclude<SagaStep, { readonly kind: 'skip' }> | undefined {
  return stepVariantsFor(eventType).find(
    (step): step is Exclude<SagaStep, { readonly kind: 'skip' }> => step.kind !== 'skip' && step.precondition === status,
  );
}

/**
 * Kept for every existing single-variant caller (every fact type except
 * `credit.released.v1`) — returns "the" step unchanged. Throws if
 * `eventType` names more than one variant: a status-less lookup is
 * genuinely ambiguous there, and returning one variant silently would be
 * exactly the kind of accidental-precedence bug this file's own header
 * warns against. Callers that must handle every fact type generically use
 * `stepForStatus`/`stepVariantsFor` instead.
 */
export function stepFor(eventType: string): SagaStep | undefined {
  const variants = stepVariantsFor(eventType);
  if (variants.length === 0) {
    return undefined;
  }
  if (variants.length > 1) {
    throw new Error(`saga-steps: stepFor("${eventType}") is ambiguous — ${variants.length} variants exist; use stepForStatus(eventType, status) instead`);
  }
  return variants[0];
}
