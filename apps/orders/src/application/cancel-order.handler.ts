// The `orders.cancel` responder's application logic (feature 41,
// `orders_cancel_responder`, extended by its own follow-up pass) —
// operator-initiated cancellation, a NEW saga trigger distinct from the
// fact-driven R19-R29 flow: an RPC request, not a consumed fact.
// `specs/shared/saga.md` §4.3's generalisation table is the exact spec
// this class transcribes:
//
//   | Operator cancels while `placed`                       | nothing acquired            | (none)                                    | cancel `operator_cancelled` |
//   | Operator cancels while `stock_reserved`                | stock reservation            | stock reservation (`stock.release`)       | cancel `operator_cancelled` |
//   | Operator cancels while `credit_approved`/`confirmed`   | stock reservation, credit hold | credit hold, THEN stock reservation      | cancel `operator_cancelled` |
//   | `despatched` onward, or already `cancelled`            | —                             | —                                          | `ORDER_NOT_CANCELLABLE`     |
//
// All four branches are built here. The `credit_approved`/`confirmed`
// branch (this file's own follow-up pass, closing the gap the first pass
// correctly refused to fake — see `progress/impl_orders_cancel_responder.md`'s
// original section) issues `billing.credit.release` FIRST — the newly
// added asyncapi.yaml channel, `@otc/contracts` types, and Billing
// responder — through the SAME durable `SagaCommandStore.enqueue` +
// fast-path (`IssueCreditReleaseCommand` -> `SagaCommandDispatcher.dispatch`)
// mechanism the `stock_reserved` branch already uses below. The order
// stays `credit_approved`/`confirmed` (unchanged) until `credit.released.v1`
// arrives; `saga-steps.ts`'s `credit.released.v1` step now has a SECOND and
// THIRD variant (precondition `credit_approved`/`confirmed`) that owes
// `stock.release` next — the exact reverse-order-of-acquisition chain
// saga.md §4.3 requires, composed entirely from the EXISTING generic
// fact-driven step-table machinery (no new orchestration written in THIS
// class for the second step): `credit.released.v1` (credit_approved/
// confirmed variant) -> owes `stock.release` -> `stock.released.v1`
// (EXISTING, already reason-parametric step) -> cancels
// `operator_cancelled`. This class only ever issues the FIRST command of
// that chain; the rest happens the same way `credit.rejected.v1` ->
// `stock.release` -> `stock.released.v1` already completes R27/R28's
// compensation today.
import type { CommandBus } from '@nestjs/cqrs';
import { UniqueId, type OrderNumber } from '@otc/shared-kernel';
import type { CreditReleaseRequestPayload, Envelope, StockReleaseRequestPayload } from '@otc/contracts';
import { OrderTransitionNotAllowedError } from '../domain/order-errors.js';
import type { OrderStatus } from '../domain/order-status.js';
import type { CancellationReason } from '../domain/order-cancellation-reason.js';
import { IssueCreditReleaseCommand, IssueStockReleaseCommand } from './commands/saga-dispatch.commands.js';
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
      readonly compensationPlanned: readonly ('credit_release' | 'stock_release')[];
    }
  | {
      readonly outcome: 'cancelled';
      readonly orderId: string;
      readonly orderReference: string;
      readonly status: 'cancelled';
      readonly cancellationReason: CancellationReason;
    };

/** `Order.status` values for which credit was already held and stock is still reserved — reverse-order compensation releases credit FIRST, then stock (saga.md §4.3). */
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

    if (CREDIT_HELD_STATUSES.has(order.status)) {
      return this.beginCreditReleaseCompensation(order.id, order.orderReference, order.status, order.retailerCode, order.companyCode, command.note);
    }

    if (order.status === 'stock_reserved') {
      return this.beginStockReleaseCompensation(order.id, order.orderReference, command.note);
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
   * R8's `stock_reserved` branch (saga.md §4.3) — issues `stock.release`
   * (reason `order_cancelled`, distinct from the fact-driven flow's
   * `credit_rejected`) through the EXACT SAME durable mechanism R27/R28
   * use: `SagaCommandStore.enqueue` inside a transaction, then the same
   * in-process fast-path hop (`IssueStockReleaseCommand` ->
   * `SagaCommandDispatcher.dispatch`) `OrderSagas`' `@Saga()` stream uses
   * for the fact-driven case — no second compensation mechanism. The
   * order stays `stock_reserved` (unchanged) until `stock.released.v1`
   * arrives; `saga-steps.ts`'s EXISTING `stock.released.v1` step (precondition
   * `stock_reserved`, `mapReason('order_cancelled') -> 'operator_cancelled'`)
   * completes the cancellation without any change to that file — it was
   * already reason-parametric.
   */
  private async beginStockReleaseCompensation(
    orderId: UniqueId,
    orderReference: OrderNumber,
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
      status: 'stock_reserved',
      compensationPlanned: ['stock_release'],
    };
  }

  /**
   * R8's `credit_approved`/`confirmed` branch (saga.md §4.3, this file's
   * own follow-up pass) — issues `billing.credit.release` FIRST (reverse
   * order of acquisition: credit was acquired SECOND, after stock, so it
   * is released FIRST), through the IDENTICAL durable mechanism
   * `beginStockReleaseCompensation` above uses: `SagaCommandStore.enqueue`
   * inside a transaction, then the fast-path hop
   * (`IssueCreditReleaseCommand` -> `SagaCommandDispatcher.dispatch`).
   * `reason` is not a caller-supplied field on `CreditReleaseRequestPayload`
   * — Billing's `billing.credit.release` responder always releases with
   * reason `order_cancelled` (the only external trigger for that RPC).
   * The order stays `credit_approved`/`confirmed` (unchanged) until
   * `credit.released.v1` arrives; `saga-steps.ts`'s SECOND/THIRD variant
   * of that step (precondition `credit_approved`/`confirmed`) then owes
   * `stock.release` — completing the reverse-order chain entirely through
   * the EXISTING generic fact-driven step-table machinery, no second
   * orchestration call from THIS class.
   */
  private async beginCreditReleaseCompensation(
    orderId: UniqueId,
    orderReference: OrderNumber,
    status: OrderStatus,
    retailerCode: string,
    companyCode: string,
    note: string | undefined,
  ): Promise<CancelOrderResult> {
    const requestId = UniqueId.generate();
    const payload: CreditReleaseRequestPayload = {
      orderReference: orderReference.value,
      retailerCode,
      companyCode,
    };

    await this.enqueueOperatorCancelCommand({
      id: UniqueId.generate(),
      orderId,
      orderReference,
      command: 'credit.release',
      payload,
      triggeringEventId: requestId,
      triggeringEventEnvelope: this.buildTriggeringEnvelope(orderId, requestId, note),
      triggeringEventTopic: this.ordersFactsTopic,
    });

    // The fast path (design.md §5.5) — same best-effort/crash-window
    // composition as every other saga command's fast-path hop; the
    // durable `pending` row above is what actually guarantees delivery
    // (SO3), via the sweeper if this in-process hop is lost.
    await this.commandBus.execute(new IssueCreditReleaseCommand(orderId.value));

    return {
      outcome: 'compensation_pending',
      orderId: orderId.value,
      orderReference: orderReference.value,
      status,
      // Reverse order of acquisition (saga.md §4.3) — credit_release is
      // issued NOW; stock_release follows once credit.released.v1 arrives
      // (saga-steps.ts's credit_approved/confirmed variant), not issued
      // by this class.
      compensationPlanned: ['credit_release', 'stock_release'],
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
   * cancel request, never as a fact that did not happen. Shared by both
   * compensation branches (`stock_reserved` and `credit_approved`/
   * `confirmed`) — the SAME diagnostic shape either way.
   */
  private buildTriggeringEnvelope(orderId: UniqueId, requestId: UniqueId, note: string | undefined): Envelope {
    return {
      eventId: requestId.value,
      eventType: 'orders.cancel.requested',
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
