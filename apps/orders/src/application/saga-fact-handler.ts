// The ONE generic transactional unit (design.md §5.1) — the ten
// `@CommandHandler` wrappers in `commands/saga-fact.handlers.ts` are
// one-line delegations to this. Composes the EXISTING, UNMODIFIED
// `IdempotentConsumer` (outbox_and_idempotency design.md §6) with the step
// table (saga-steps.ts) and the aggregate's own command methods — zero
// duplicated orchestration logic, zero new dedup mechanism.
import type { Envelope } from '@otc/contracts';
import { UniqueId } from '@otc/shared-kernel';
import type { ConsumerName } from './ports/consumer-name.js';
import type { OrderRepository } from './ports/order-repository.port.js';
import { NOOP_SAGA_METRICS, type RecordsSagaMetrics } from './ports/saga-metrics.port.js';
import type { SagaCommandStore } from './ports/saga-command-store.port.js';
import type { TransactionContext } from './ports/unit-of-work.port.js';
import { buildSagaCommandPayload } from './saga-command-payloads.js';
import { stepForStatus, stepVariantsFor, transitionContextFrom, type SagaCommandKind, type SagaStep } from './saga-steps.js';
import type { OrderStatus } from '../domain/order-status.js';
import type { ConsumptionOutcome } from '../infrastructure/messaging/idempotent-consumer.js';
import type { RecordIgnoredFactInput } from '../infrastructure/saga/saga-ignored-facts.repository.js';

/** SA-4 — the one `eventType` whose handling cannot be expressed by a status-keyed step-table variant alone (it depends on whether an operator cancellation was already ACCEPTED, which is not a status). See `handle`'s own comment at the check. */
const LATE_CREDIT_APPROVAL_EVENT_TYPE = 'credit.approved.v1';

export type SagaFactOutcome = 'processed' | 'duplicate' | 'ignored';

export interface SagaFactResult {
  readonly outcome: SagaFactOutcome;
  /** Set only when `outcome === 'processed'` AND the step owed a command — the ONLY signal the wrapping `@CommandHandler` needs to know whether to publish a dispatch-owed event (design.md §5.1 step 4). */
  readonly enqueued?: SagaCommandKind;
}

/**
 * The narrow surface `SagaFactHandler` needs from `IdempotentConsumer` (the
 * EXISTING, UNMODIFIED class, outbox_and_idempotency design.md §6) — same
 * "narrow structural interface, real class satisfies it, a unit test fakes
 * it" shape as `NatsRequestClient`/`RunsOutboxOnce` elsewhere in this
 * codebase. `IdempotentConsumer.runOnce` itself calls straight through to
 * Drizzle, so widening this to the concrete class would force even a pure
 * unit test onto a real database.
 */
export interface RunsIdempotently {
  runOnce(
    eventId: string,
    consumer: ConsumerName,
    work: (tx: TransactionContext) => Promise<void>,
  ): Promise<ConsumptionOutcome>;
}

/** The narrow surface `SagaFactHandler` needs from `SagaIgnoredFactsRepository` — same reasoning as `RunsIdempotently` above. */
export interface RecordsIgnoredSagaFacts {
  record(tx: TransactionContext, input: RecordIgnoredFactInput): Promise<void>;
}

export class SagaFactHandler {
  constructor(
    private readonly idempotency: RunsIdempotently,
    private readonly orders: OrderRepository,
    private readonly commandStore: SagaCommandStore,
    private readonly ignoredFacts: RecordsIgnoredSagaFacts,
    // A7 (metrics, R59/OR5) — opt-in, defaults to a no-op so every
    // existing construction site/test stays unaffected, the same shape
    // `SagaCommandDispatcher`'s `firstParkHandler` (OR3) already
    // established.
    private readonly sagaMetrics: RecordsSagaMetrics = NOOP_SAGA_METRICS,
  ) {}

  /** `sourceTopic` — the Kafka topic constant `SagaFactsController.route` already knows for this call, threaded through so `commandStore.enqueue` can capture it verbatim (R29's dead-letter clause / OR3, observability_reliability design.md §4.2). */
  async handle(envelope: Envelope, sourceTopic: string): Promise<SagaFactResult> {
    const variants = stepVariantsFor(envelope.eventType);
    // Absent or every variant `skip` (the three self-produced facts, SO2)
    // — no I/O at all, not even a dedup row. In production this branch is
    // defensive: the presentation controller's `factCommandFor` map
    // (saga-fact.commands.ts) never dispatches a command for these event
    // types in the first place. `credit.released.v1` now has THREE
    // variants (feature 41's follow-up pass) — none of them `skip`, so
    // this check still correctly proceeds to I/O for it.
    if (variants.length === 0 || variants.every((variant) => variant.kind === 'skip')) {
      return { outcome: 'processed' };
    }
    // The precondition to report on an `ignored` record when NO variant
    // matches — unambiguous for every existing single-variant fact type
    // (unchanged behaviour); `null` for a multi-variant fact type
    // (`credit.released.v1`), where no single "the expected status" exists
    // — the ignored-facts table's own diagnostic marker plus `eventType`
    // is enough to find `saga-steps.ts`'s full precondition set for a
    // human investigating it.
    const soleExpectedStatus: OrderStatus | null =
      variants.length === 1 && variants[0]!.kind !== 'skip' ? (variants[0] as Exclude<SagaStep, { kind: 'skip' }>).precondition : null;

    let enqueued: SagaCommandKind | undefined;
    let ignored = false;

    const outcome = await this.idempotency.runOnce(envelope.eventId, 'orders.saga', async (tx) => {
      const correlationId = UniqueId.from(envelope.correlationId);
      const order = await this.orders.findById(correlationId, tx);

      if (!order) {
        // SO8 — a fact can never legitimately precede its own order's row
        // (order.placed.v1 commits with the order in one transaction, R13);
        // an unknown order is cross-environment residue, not an ordering
        // problem.
        await this.ignoredFacts.record(tx, {
          eventId: UniqueId.from(envelope.eventId),
          eventType: envelope.eventType,
          orderId: null,
          correlationId,
          observedStatus: null,
          expectedStatus: soleExpectedStatus,
          marker: 'unknown_order',
        });
        ignored = true;
        return;
      }

      // SA-4 (saga.md §4.3, "A credit approval that arrives after the
      // cancellation") — the ONE fact type that needs a check BEFORE the
      // generic status-precondition dispatch below. A `credit.hold` issued
      // before an operator cancelled a `stock_reserved` order can still be
      // approved; left to the generic dispatch, that late
      // `credit.approved.v1` would take the ORDINARY advance (approve,
      // confirm, owe `despatch.create`) and resurrect an order that is
      // being cancelled. The hold WAS acquired, so it is unwound:
      // `credit.release` and nothing else — no transition, no
      // `order.confirmed.v1`, no `despatch.create`. That release is not one
      // of the cancellation's recorded compensation steps; it reaches the
      // timeline as its own `credit.released.v1`.
      //
      // Two shapes qualify, exactly as the spec enumerates them: still
      // `stock_reserved` with the stock release under way (the accepted
      // cancellation left the order untouched, so the enqueued row is the
      // only evidence — `hasAcceptedOperatorCancel`), or already
      // `cancelled` with reason `operator_cancelled`. Every OTHER stale
      // combination — `cancelled`/`stock_rejected`,
      // `cancelled`/`credit_rejected`, or any status with no accepted
      // operator cancel — falls through to the generic dispatch, which R25
      // ignores exactly as before.
      if (envelope.eventType === LATE_CREDIT_APPROVAL_EVENT_TYPE) {
        const lateForAnAcceptedOperatorCancel =
          order.status === 'cancelled'
            ? order.cancellationReason === 'operator_cancelled'
            : order.status === 'stock_reserved' && (await this.commandStore.hasAcceptedOperatorCancel(tx, order.id));

        if (lateForAnAcceptedOperatorCancel) {
          await this.commandStore.enqueue(tx, {
            id: UniqueId.generate(),
            orderId: order.id,
            orderReference: order.orderReference,
            command: 'credit.release',
            payload: buildSagaCommandPayload('credit.release', order, envelope),
            triggeringEventId: UniqueId.from(envelope.eventId),
            triggeringEventEnvelope: envelope,
            triggeringEventTopic: sourceTopic,
          });
          // Reported as owed on EITHER enqueue outcome — D1's own reasoning
          // at the generic call site below: `already_owed` means the row
          // exists, and the fast path re-dispatches the row that actually
          // exists rather than inserting a second one.
          enqueued = 'credit.release';
          // No `orders.save`: the order is deliberately NOT transitioned.
          return;
        }
      }

      const step = stepForStatus(envelope.eventType, order.status);
      if (!step) {
        // R25 — equality only, no ranges, extended unchanged to fact types
        // with more than one legal precondition: NO variant's precondition
        // equals the order's CURRENT status. Every unmet precondition on
        // first delivery is impossible by construction (design.md §4.4);
        // in practice this is always a stale redelivery.
        await this.ignoredFacts.record(tx, {
          eventId: UniqueId.from(envelope.eventId),
          eventType: envelope.eventType,
          orderId: order.id,
          correlationId,
          observedStatus: order.status,
          expectedStatus: soleExpectedStatus,
          marker: 'precondition_unmet',
        });
        ignored = true;
        return;
      }

      const ctx = transitionContextFrom(envelope);

      if (step.kind === 'advance') {
        step.apply(order, ctx, envelope);
        this.recordSagaCompletionIfClosed(order, ctx);
        await this.orders.save(order, tx);
        if (step.commandAfter) {
          const payload = buildSagaCommandPayload(step.commandAfter, order, envelope);
          // D1: `enqueue` is idempotent on (order_id, command) — a distinct-eventId
          // duplicate of a fact whose precondition still holds (e.g. a redelivered
          // credit.rejected.v1 mid-compensation) resolves to 'already_owed' rather
          // than a unique-key violation. Either outcome reports the SAME command as
          // owed, so the fast path always re-dispatches the row that actually exists
          // — a `sent` row is a silent no-op there, a `pending`/`parked` one is
          // (re-)dispatched.
          await this.commandStore.enqueue(tx, {
            id: UniqueId.generate(),
            orderId: order.id,
            orderReference: order.orderReference,
            command: step.commandAfter,
            payload,
            triggeringEventId: UniqueId.from(envelope.eventId),
            triggeringEventEnvelope: envelope,
            triggeringEventTopic: sourceTopic,
          });
          enqueued = step.commandAfter;
        }
      } else {
        const reason = step.reason(envelope);
        const compensationSteps = step.compensationSteps(envelope);
        order.cancel(reason, ctx, compensationSteps);
        this.recordSagaCompletionIfClosed(order, ctx);
        await this.orders.save(order, tx);
      }
    });

    if (outcome === 'duplicate') {
      return { outcome: 'duplicate' };
    }
    if (ignored) {
      return { outcome: 'ignored' };
    }
    return { outcome: 'processed', enqueued };
  }

  /**
   * A7 (metrics, R59/OR5, design.md §4.5) — `otc_saga_completion_ms`,
   * recorded ONLY when this transition just moved `order` to `'completed'`
   * or `'cancelled'` (the two statuses `Order.complete`/`Order.cancel`
   * produce — every other `advance`/`cancel` step lands on a DIFFERENT
   * status, so this check alone correctly distinguishes "the fact that
   * closed the saga" from every other saga-step fact without hardcoding
   * which of the ten fact types is the closing one). The duration is the
   * REAL wall-clock span from the order's OWN `order.placed.v1` timestamp
   * — `order.orderDate`, which `PlaceOrderHandler` sets from the EXACT
   * same `clock.now()` value used to build `order.placed.v1`'s own
   * `occurredAt` (verified by reading `place-order.handler.ts`) — to
   * `ctx.occurredAt`, the CLOSING fact's own envelope timestamp. Never a
   * newly-read clock value here: both ends are facts' own stamped
   * instants, so the metric measures what actually happened in the
   * domain, not how fast this handler itself ran.
   */
  private recordSagaCompletionIfClosed(order: { readonly status: string; readonly orderDate: Date }, ctx: { readonly occurredAt: Date }): void {
    if (order.status !== 'completed' && order.status !== 'cancelled') {
      return;
    }
    const durationMs = ctx.occurredAt.getTime() - order.orderDate.getTime();
    this.sagaMetrics.recordSagaCompletion(durationMs, order.status);
  }
}
