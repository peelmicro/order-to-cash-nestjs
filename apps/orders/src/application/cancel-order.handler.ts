// The `orders.cancel` responder's application logic (feature 41,
// `orders_cancel_responder`, extended by its own follow-up pass and then
// REDESIGNED by SA-4) — operator-initiated cancellation, a NEW saga trigger
// distinct from the fact-driven R19-R29 flow: an RPC request, not a
// consumed fact. `specs/shared/saga.md` §4.3's generalisation table is the
// exact spec this class transcribes:
//
//   | Operator cancels while `placed`                       | nothing acquired            | (none)                                    | cancel `operator_cancelled` |
//   | Operator cancels while `stock_reserved`                | stock reservation            | stock reservation (`stock.release`)       | cancel `operator_cancelled` |
//   | Operator cancels while `credit_approved`/`confirmed`   | stock reservation, credit hold | stock reservation FIRST, THEN credit hold | cancel `operator_cancelled` — unless the despatch consumed the stock first |
//   | `despatched` onward, or already `cancelled`            | —                             | —                                          | `ORDER_NOT_CANCELLABLE`     |
//
// All four branches are built here, and since SA-4 the three compensating
// statuses share ONE enqueue site: `stock.release` goes first, always.
//
// WHY STOCK FIRST, against reverse-order-of-acquisition (saga.md §4.3,
// "The despatch already requested"). Step 3 issues `despatch.create` in the
// same handler that confirms the order, so an operator cancellation of a
// `credit_approved`/`confirmed` order ALWAYS races a despatch that has
// already been requested, and both want the same stock reservation.
// Fulfillment decides the two under one lock, so exactly one wins. Release
// the stock first and let it arbitrate: if the release wins,
// `stock.released.v1` arrives and the orchestrator issues `credit.release`,
// whose `credit.released.v1` then cancels the order; if the despatch wins,
// `stock.release` releases nothing, emits no fact, NO `credit.release` is
// ever issued, and the order despatches with its hold intact. Releasing the
// credit hold first — which reverse order of acquisition alone would
// suggest, and which this file did before SA-4 — is exactly wrong here: a
// despatch that then won would ship an order whose credit hold had already
// been returned.
//
// This class only ever issues the FIRST command of that chain; the second
// hop is composed entirely from the EXISTING generic fact-driven step-table
// machinery (`saga-steps.ts`: `stock.released.v1`'s `credit_approved`/
// `confirmed` variants owe `credit.release`; `credit.released.v1`'s own
// variants for those statuses are the terminal cancel), exactly the way
// `credit.rejected.v1` -> `stock.release` -> `stock.released.v1` already
// completes R27/R28's compensation.
import type { CommandBus } from '@nestjs/cqrs';
import { UniqueId, type OrderNumber } from '@otc/shared-kernel';
import type { Envelope, StockReleaseRequestPayload } from '@otc/contracts';
import { OrderTransitionNotAllowedError } from '../domain/order-errors.js';
import type { OrderStatus } from '../domain/order-status.js';
import type { CancellationReason } from '../domain/order-cancellation-reason.js';
import { IssueStockReleaseCommand } from './commands/saga-dispatch.commands.js';
import { OPERATOR_CANCEL_EVENT_TYPE } from './operator-cancel-envelope.js';
import type { Clock } from './ports/clock.port.js';
import type { OrderRepository } from './ports/order-repository.port.js';
import type { EnqueueSagaCommandInput, SagaCommandStore } from './ports/saga-command-store.port.js';
import type { UnitOfWork } from './ports/unit-of-work.port.js';

export interface CancelOrderCommand {
  readonly orderId: string;
  readonly note?: string;
}

export type CancelOrderResult =
  | { readonly outcome: 'not_found' }
  | {
      readonly outcome: 'not_cancellable';
      readonly orderId: string;
      readonly orderReference: string;
      readonly status: OrderStatus;
    }
  | {
      readonly outcome: 'compensation_pending';
      readonly orderId: string;
      readonly orderReference: string;
      readonly status: OrderStatus;
      /** SA-4: ORDERED, and the order is the whole claim — `['stock_release']` from `stock_reserved`; `['stock_release', 'credit_release']` from `credit_approved`/`confirmed`, stock first. A caller comparing this by membership rather than by sequence cannot see a transposition. */
      readonly compensationPlanned: readonly ('credit_release' | 'stock_release')[];
    }
  | {
      readonly outcome: 'cancelled';
      readonly orderId: string;
      readonly orderReference: string;
      readonly status: 'cancelled';
      readonly cancellationReason: CancellationReason;
    };

/** `Order.status` values for which credit was already held AND stock is still reserved — SA-4 releases the CONTESTED resource (stock) first and lets `stock.released.v1` owe the credit release (saga.md §4.3). */
const CREDIT_HELD_STATUSES = new Set<OrderStatus>(['credit_approved', 'confirmed']);

/**
 * A plain class, not `@Injectable()` — same "no decorator needed, wired via
 * `useFactory`" shape `PlaceOrderHandler` already uses (place-order.handler.ts).
 */
export class CancelOrderHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly orders: OrderRepository,
    private readonly commandStore: SagaCommandStore,
    private readonly commandBus: CommandBus,
    private readonly clock: Clock,
    /** `ORDERS_FACTS_TOPIC` (infrastructure/outbox/kafka.config.ts) — threaded in as a plain string, never imported directly here: the application layer must not depend on infrastructure (CLAUDE.md's domain/application purity rule extends to this file even though it is not `domain/`, mirroring how `SagaFactHandler.handle` receives `sourceTopic` as a parameter from its presentation-layer caller rather than importing the constant itself). */
    private readonly ordersFactsTopic: string,
  ) {}

  async execute(command: CancelOrderCommand): Promise<CancelOrderResult> {
    const orderId = UniqueId.from(command.orderId);
    const order = await this.orders.findById(orderId);
    if (!order) {
      return { outcome: 'not_found' };
    }

    // SA-4 — the SAME first command for all three compensating statuses:
    // `stock.release`. What differs is only what the reply PLANS: one hop
    // from `stock_reserved` (stock is the only acquisition), two — stock
    // then credit, in release order — from `credit_approved`/`confirmed`.
    if (CREDIT_HELD_STATUSES.has(order.status)) {
      return this.beginStockReleaseCompensation(order.id, order.orderReference, order.status, ['stock_release', 'credit_release'], command.note);
    }

    if (order.status === 'stock_reserved') {
      return this.beginStockReleaseCompensation(order.id, order.orderReference, 'stock_reserved', ['stock_release'], command.note);
    }

    // `placed`, OR a terminal status the aggregate itself refuses to leave
    // (`despatched`/`invoiced`/`paid`/`completed`/already-`cancelled`) —
    // `Order.cancel` is the ONE guard for both outcomes, reused verbatim:
    // R8/O5/O7's edge table already refuses every `(from, cancelled)` pair
    // that is not legal, via `OrderTransitionNotAllowedError`. No new
    // status-set check is written here (feature 41's own acceptance
    // criterion: "no new domain modeling").
    return this.unitOfWork.execute(async (tx) => {
      const txOrder = await this.orders.findById(orderId, tx);
      if (!txOrder) {
        return { outcome: 'not_found' };
      }
      try {
        txOrder.cancel('operator_cancelled', { occurredAt: this.clock.now(), causationId: UniqueId.generate() }, []);
      } catch (error) {
        if (error instanceof OrderTransitionNotAllowedError) {
          return {
            outcome: 'not_cancellable',
            orderId: txOrder.id.value,
            orderReference: txOrder.orderReference.value,
            status: txOrder.status,
          };
        }
        throw error;
      }
      await this.orders.save(txOrder, tx);
      return {
        outcome: 'cancelled',
        orderId: txOrder.id.value,
        orderReference: txOrder.orderReference.value,
        status: 'cancelled',
        cancellationReason: txOrder.cancellationReason!,
      };
    });
  }

  /**
   * SA-4 — the ONE direct enqueue site, shared by all three compensating
   * statuses (saga.md §4.3). Issues `stock.release` (reason
   * `order_cancelled`, distinct from the fact-driven flow's
   * `credit_rejected`) through the EXACT SAME durable mechanism R27/R28
   * use: `SagaCommandStore.enqueue` inside a transaction, then the same
   * in-process fast-path hop (`IssueStockReleaseCommand` ->
   * `SagaCommandDispatcher.dispatch`) `OrderSagas`' `@Saga()` stream uses
   * for the fact-driven case — no second compensation mechanism. The order
   * is left exactly where it is (`stock_reserved`, `credit_approved` or
   * `confirmed`) until the release fact arrives:
   *
   *   - from `stock_reserved`, `stock.released.v1`'s EXISTING, already
   *     reason-parametric step cancels the order directly (R28/SO7);
   *   - from `credit_approved`/`confirmed`, `stock.released.v1` owes
   *     `credit.release` and `credit.released.v1` is what finally cancels —
   *     or, if the racing despatch won the reservation instead, no fact
   *     arrives at all, nothing is released, and the cancellation is
   *     overtaken (saga.md §4.3's "The despatch wins").
   *
   * `compensationPlanned` is what the two cases differ by, and it is passed
   * in rather than derived here so the ORDER of its elements is decided at
   * the one call site that knows the status.
   */
  private async beginStockReleaseCompensation(
    orderId: UniqueId,
    orderReference: OrderNumber,
    status: OrderStatus,
    compensationPlanned: readonly ('credit_release' | 'stock_release')[],
    note: string | undefined,
  ): Promise<CancelOrderResult> {
    const requestId = UniqueId.generate();
    const payload: StockReleaseRequestPayload = {
      orderReference: orderReference.value,
      reason: 'order_cancelled',
    };

    await this.enqueueOperatorCancelCommand({
      id: UniqueId.generate(),
      orderId,
      orderReference,
      command: 'stock.release',
      payload,
      triggeringEventId: requestId,
      triggeringEventEnvelope: this.buildTriggeringEnvelope(orderId, requestId, note),
      triggeringEventTopic: this.ordersFactsTopic,
    });

    // The fast path (design.md §5.5) — best-effort: a crash between the
    // commit above and this hop still leaves the durable `pending` row for
    // the sweeper (SO3), the same crash-window composition R29 already
    // relies on for every fact-driven command.
    await this.commandBus.execute(new IssueStockReleaseCommand(orderId.value));

    return {
      outcome: 'compensation_pending',
      orderId: orderId.value,
      orderReference: orderReference.value,
      status,
      compensationPlanned,
    };
  }

  /**
   * A synthetic "triggering fact" envelope — `EnqueueSagaCommandInput`
   * requires one (saga-command-store.port.ts), because every OTHER saga
   * command this system ever enqueues is fact-triggered (R19-R29). An
   * operator cancel is not: there is no fact to attach. `eventType`
   * `'orders.cancel.requested'` is deliberately NOT one of the fourteen
   * real wire fact types (asyncapi.yaml) — it exists purely as this row's
   * diagnostic "why was this enqueued" bookkeeping, read only if the
   * command ever exhausts its retries and reaches
   * `SagaFirstParkDeadLetterHandler` (OR3), which republishes it to
   * `${ordersFactsTopic}.dlq` verbatim, tagged truthfully as an operator
   * cancel request, never as a fact that did not happen.
   *
   * SA-4 gave this envelope a SECOND reader: `hasAcceptedOperatorCancel`
   * (saga-command-store.port.ts) answers "was an operator cancellation
   * already accepted for this order?" by testing exactly this `eventType`
   * on the order's `credit.release`/`stock.release` rows, which is why the
   * literal lives in `operator-cancel-envelope.ts` and is imported by both
   * sides rather than spelled twice.
   */
  private buildTriggeringEnvelope(orderId: UniqueId, requestId: UniqueId, note: string | undefined): Envelope {
    return {
      eventId: requestId.value,
      eventType: OPERATOR_CANCEL_EVENT_TYPE,
      aggregateId: orderId.value,
      correlationId: orderId.value,
      causationId: requestId.value,
      occurredAt: this.clock.now().toISOString(),
      payload: {
        orderId: orderId.value,
        reason: 'operator_cancelled',
        ...(note !== undefined ? { note } : {}),
      },
    };
  }

  /** Enqueues `input` inside its own transaction — the one piece of I/O shared verbatim by both compensation branches. */
  private async enqueueOperatorCancelCommand(input: EnqueueSagaCommandInput): Promise<void> {
    await this.unitOfWork.execute(async (tx) => {
      await this.commandStore.enqueue(tx, input);
    });
  }
}
