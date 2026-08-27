// The 13-fact step table as data (design.md §4) — the direct transcription
// of saga.md §3.1/§4 plus the consumption map §5. Pure data + pure
// functions, framework-free: no port, no clock, no DB. Every fact ×
// every status is unit-tested exhaustively in saga-steps.spec.ts.
import type { CompensationStep, Envelope, StockReleasedPayload } from '@otc/contracts';
import { UniqueId } from '@otc/shared-kernel';
import type { CancellationReason } from '../domain/order-cancellation-reason.js';
import type { Order, TransitionContext } from '../domain/order.js';
import type { OrderStatus } from '../domain/order-status.js';

/**
 * The six outbound saga commands (design.md §6.1, extended by feature 41's
 * follow-up pass) — the closed set `commandAfter` may name, PLUS
 * `credit.release`, which `commandAfter` never names (no step-table row
 * owes it — see `credit.release`'s own comment below) but which
 * `CancelOrderHandler` enqueues directly, the same "outside the fact-driven
 * table, same durable mechanism" shape `stock.release`'s operator-cancel
 * variant already established for the `stock_reserved` branch.
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
 * Feature 41's follow-up pass, the `credit_approved`/`confirmed` variant of
 * `stock.released.v1` below: TWO acquisitions are unwound in this branch
 * (credit hold, then stock reservation — reverse order of acquisition,
 * saga.md §4.3), so `compensationSteps` should name both, not only the
 * CURRENT triggering fact (`stepsFrom` below reports only the ONE fact it
 * is handed). This step-table function has no saga-instance record of the
 * EARLIER `credit.released.v1` fact's own `eventId`/`occurredAt` — this
 * codebase keeps no such cross-fact state anywhere (`saga-steps.ts`'s own
 * module header: "the aggregate never sees the fact itself, only what this
 * function hands it") — so the synthesised `credit_released` entry below
 * deliberately carries NO `eventId` (the schema's own field is optional,
 * `CompensationStep.eventId?`) rather than fabricate one; a reader tracing
 * `order.cancelled.v1`'s `compensationSteps` back to the credit release's
 * OWN outbox row must join on `(orderReference, eventType)` instead of a
 * direct `eventId`, a known, disclosed limitation, not a silent gap.
 */
function stepsFromCreditCompensation(fact: Envelope): readonly CompensationStep[] {
  return [
    {
      step: 'credit_released',
      eventType: 'credit.released.v1',
      occurredAt: fact.occurredAt,
      summary: 'credit released — reason: order_cancelled (reverse order of acquisition, released before stock)',
    },
    ...stepsFrom(fact),
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
 * `stock.released.v1` (feature 41's follow-up pass, closing the
 * `credit_approved`/`confirmed` cancel gap) are the two fact types with
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
  // Three variants (feature 41's follow-up pass extends this from one to
  // three, symmetric with `credit.released.v1`'s own extension above):
  //   - `stock_reserved` (R28, SO7, unchanged): compensation path B's
  //     terminal fact — reached either from `credit.rejected.v1`'s
  //     automatic compensation or the operator-cancel-while-`stock_reserved`
  //     branch (`cancel-order.handler.ts`).
  //   - `credit_approved`/`confirmed` (new): the operator-cancel-while-
  //     `credit_approved`/`confirmed` branch's SECOND and final release —
  //     credit was already released (status unchanged by that step, see
  //     `credit.released.v1`'s own comment above), so THIS fact is what
  //     finally cancels the order. `reason` is always `order_cancelled`
  //     here (the only trigger for `stock.release` while `confirmed`/
  //     `credit_approved`), and `compensationSteps` names BOTH releases
  //     (`stepsFromCreditCompensation`, this file's own function above) —
  //     not only this one fact, unlike every other `cancel`-kind step.
  'stock.released.v1': [
    {
      kind: 'cancel',
      precondition: 'stock_reserved',
      reason: (fact) => mapReason((fact.payload as StockReleasedPayload).reason),
      compensationSteps: (fact) => stepsFrom(fact),
    },
    {
      kind: 'cancel',
      precondition: 'credit_approved',
      reason: () => 'operator_cancelled',
      compensationSteps: (fact) => stepsFromCreditCompensation(fact),
    },
    {
      kind: 'cancel',
      precondition: 'confirmed',
      reason: () => 'operator_cancelled',
      compensationSteps: (fact) => stepsFromCreditCompensation(fact),
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
  // Three variants (feature 41's follow-up pass, closing the
  // `credit_approved`/`confirmed` operator-cancel gap — see this file's
  // module header):
  //   - `paid` (R24, unchanged): the happy-path release after payment —
  //     completes the saga.
  //   - `credit_approved`/`confirmed`: the compensation release —
  //     `CancelOrderHandler` issues `billing.credit.release` BEFORE
  //     `stock.release` (reverse order of acquisition, saga.md §4.3); this
  //     variant's `apply` is a deliberate no-op (mirrors `credit.rejected.v1`'s
  //     own R27 no-op immediately above) — status stays `credit_approved`/
  //     `confirmed` until `stock.released.v1` completes the cancellation via
  //     ITS OWN existing, already reason-parametric step. `reason` on the
  //     incoming fact is always `order_cancelled` here (Billing's
  //     `CreditReleaseHandler` releases with no other reason via this RPC;
  //     the ONLY way `credit.released.v1` carries `invoice_paid` is
  //     PaymentRegisterHandler's own internal call, which the R47 outbox
  //     ordering guarantees is never observed before the order has already
  //     advanced to `paid`) — asserted, not merely assumed, in
  //     `saga-command-payloads.ts`'s `stockReleaseReasonFor`.
  'credit.released.v1': [
    {
      kind: 'advance',
      precondition: 'paid',
      // R24 — emits order.completed.v1, closing the saga.
      apply: (order, ctx) => order.complete(ctx),
    },
    {
      kind: 'advance',
      precondition: 'credit_approved',
      apply: () => {
        /* no-op — status unchanged until stock.released.v1 arrives */
      },
      commandAfter: 'stock.release',
    },
    {
      kind: 'advance',
      precondition: 'confirmed',
      apply: () => {
        /* no-op — status unchanged until stock.released.v1 arrives */
      },
      commandAfter: 'stock.release',
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
