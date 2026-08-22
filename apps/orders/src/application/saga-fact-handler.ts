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
import type { SagaCommandStore } from './ports/saga-command-store.port.js';
import type { TransactionContext } from './ports/unit-of-work.port.js';
import { buildSagaCommandPayload } from './saga-command-payloads.js';
import { stepFor, transitionContextFrom, type SagaCommandKind } from './saga-steps.js';
import type { ConsumptionOutcome } from '../infrastructure/messaging/idempotent-consumer.js';
import type { RecordIgnoredFactInput } from '../infrastructure/saga/saga-ignored-facts.repository.js';

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
  ) {}

  async handle(envelope: Envelope): Promise<SagaFactResult> {
    const step = stepFor(envelope.eventType);
    // Absent or `skip` (the three self-produced facts, SO2) — no I/O at
    // all, not even a dedup row. In production this branch is defensive:
    // the presentation controller's `factCommandFor` map (saga-fact.commands.ts)
    // never dispatches a command for these event types in the first place.
    if (!step || step.kind === 'skip') {
      return { outcome: 'processed' };
    }

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
          expectedStatus: step.precondition,
          marker: 'unknown_order',
        });
        ignored = true;
        return;
      }

      if (order.status !== step.precondition) {
        // R25 — equality only, no ranges. Every unmet precondition on first
        // delivery is impossible by construction (design.md §4.4); in
        // practice this is always a stale redelivery.
        await this.ignoredFacts.record(tx, {
          eventId: UniqueId.from(envelope.eventId),
          eventType: envelope.eventType,
          orderId: order.id,
          correlationId,
          observedStatus: order.status,
          expectedStatus: step.precondition,
          marker: 'precondition_unmet',
        });
        ignored = true;
        return;
      }

      const ctx = transitionContextFrom(envelope);

      if (step.kind === 'advance') {
        step.apply(order, ctx, envelope);
        await this.orders.save(order, tx);
        if (step.commandAfter) {
          const payload = buildSagaCommandPayload(step.commandAfter, order);
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
          });
          enqueued = step.commandAfter;
        }
      } else {
        const reason = step.reason(envelope);
        const compensationSteps = step.compensationSteps(envelope);
        order.cancel(reason, ctx, compensationSteps);
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
}
