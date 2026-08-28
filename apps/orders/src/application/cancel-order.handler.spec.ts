// Pure unit — every port faked, no store, no broker (CLAUDE.md § Testing
// conventions). Proves each outcome `CancelOrderHandler.execute` can
// produce, per `specs/shared/saga.md` §4.3's generalisation table:
//   OCR-not_found        — no order for the requested id
//   OCR-placed           — immediate cancel, `operator_cancelled`, R10
//   OCR-stock_reserved   — `stock.release` (reason `order_cancelled`) enqueued
//                          + dispatched, order left `stock_reserved`
//   OCR-terminal         — `despatched`/`invoiced`/`paid`/`completed`/already-
//                          `cancelled` -> `not_cancellable`, reusing
//                          `Order.cancel`'s OWN `OrderTransitionNotAllowedError`
//                          guard (R8/R9/O5/O7) — no new domain modeling
//   OCR-credit-release   — `credit_approved`/`confirmed` -> `credit.release`
//                          enqueued + dispatched FIRST (reverse order of
//                          acquisition), order left unchanged (this file's
//                          own follow-up pass, closing the gap the first
//                          pass correctly refused to fake)
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreditReleaseRequestPayload, StockReleaseRequestPayload } from '@otc/contracts';
import { CancelOrderHandler } from './cancel-order.handler';
import { IssueCreditReleaseCommand, IssueStockReleaseCommand } from './commands/saga-dispatch.commands';
import type { Clock } from './ports/clock.port';
import type { OrderRepository } from './ports/order-repository.port';
import type { EnqueueSagaCommandInput, SagaCommandStore } from './ports/saga-command-store.port';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port';
import { Order } from '../domain/order';
import type { OrderStatus } from '../domain/order-status';

const FIXTURE_CURRENCY = 'EUR';
const FIXTURE_RETAILER_CODE = 'RET-0001';
const FIXTURE_COMPANY_CODE = 'COM-0001';
const FIXTURE_PRODUCT_CODE = 'PRD-0001';
const ORDERS_FACTS_TOPIC = 'otc.orders.facts.v1';

function fakeTx(): TransactionContext {
  return {} as TransactionContext;
}

class FakeClock implements Clock {
  constructor(private readonly current: Date) {}
  now(): Date {
    return this.current;
  }
}

/** Builds an `Order` and drives it to `status` via the aggregate's OWN transition methods — never a snapshot shortcut — so a bug in `Order`'s own state machine would show up here too. */
function orderAt(status: OrderStatus): Order {
  const ctx = { occurredAt: new Date('2026-08-21T10:00:00.000Z'), causationId: UniqueId.generate() };
  const order = Order.place(
    {
      id: UniqueId.generate(),
      orderReference: OrderNumber.fromSequence(42),
      orderDate: ctx.occurredAt,
      buyer: { gln: GLN.of('5412345000013'), code: FIXTURE_RETAILER_CODE },
      supplier: { gln: GLN.of('5412345000037'), code: FIXTURE_COMPANY_CODE },
      currency: FIXTURE_CURRENCY,
      lines: [
        {
          productCode: FIXTURE_PRODUCT_CODE,
          description: 'Widget',
          quantity: Quantity.of(2),
          unitPrice: Money.of(1_000, FIXTURE_CURRENCY),
          lineDiscount: Money.of(0, FIXTURE_CURRENCY),
        },
      ],
    },
    ctx,
  );
  if (status === 'placed') return order;
  order.markStockReserved(ctx);
  if (status === 'stock_reserved') return order;
  order.approveCredit(ctx);
  if (status === 'credit_approved') return order;
  order.confirm(ctx);
  if (status === 'confirmed') return order;
  order.markDespatched(ctx);
  if (status === 'despatched') return order;
  order.markInvoiced(ctx);
  if (status === 'invoiced') return order;
  order.markPaid(ctx);
  if (status === 'paid') return order;
  order.complete(ctx);
  return order;
}

describe('CancelOrderHandler', () => {
  let unitOfWork: UnitOfWork;
  let orders: OrderRepository;
  let commandStore: SagaCommandStore;
  let commandBus: { execute: ReturnType<typeof vi.fn> };
  let clock: Clock;
  let handler: CancelOrderHandler;
  let saveSpy: ReturnType<typeof vi.fn>;
  let enqueueSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    saveSpy = vi.fn(async () => undefined);
    enqueueSpy = vi.fn(async () => 'enqueued' as const);
    commandStore = {
      enqueue: enqueueSpy as SagaCommandStore['enqueue'],
      findByOrderAndCommand: vi.fn(),
      claimDue: vi.fn(),
      markSent: vi.fn(),
      park: vi.fn(),
      markRejected: vi.fn(),
      claimDeadLetter: vi.fn(),
    };
    unitOfWork = { execute: vi.fn(async (work: (tx: TransactionContext) => Promise<unknown>) => work(fakeTx())) as UnitOfWork['execute'] };
    orders = {
      save: saveSpy as OrderRepository['save'],
      findById: vi.fn(),
      findByReference: vi.fn(),
      findByRequestId: vi.fn(),
    };
    commandBus = { execute: vi.fn(async () => undefined) };
    clock = new FakeClock(new Date('2026-08-21T11:00:00.000Z'));

    handler = new CancelOrderHandler(unitOfWork, orders, commandStore, commandBus as never, clock, ORDERS_FACTS_TOPIC);
  });

  it('OCR-not_found — replies not_found when no order exists for the requested id', async () => {
    orders.findById = vi.fn(async () => null);

    const result = await handler.execute({ orderId: UniqueId.generate().value });

    expect(result.outcome).toBe('not_found');
    expect(saveSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('OCR-placed — cancels immediately with reason operator_cancelled, saves the order, issues no command', async () => {
    const order = orderAt('placed');
    orders.findById = vi.fn(async () => order);

    const result = await handler.execute({ orderId: order.id.value, note: 'customer changed their mind' });

    expect(result.outcome).toBe('cancelled');
    if (result.outcome !== 'cancelled') throw new Error('unreachable');
    expect(result.status).toBe('cancelled');
    expect(result.cancellationReason).toBe('operator_cancelled');

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const [savedOrder] = saveSpy.mock.calls[0]!;
    expect(savedOrder.status).toBe('cancelled');
    expect(savedOrder.cancellationReason).toBe('operator_cancelled');

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('OCR-stock_reserved — enqueues stock.release (reason order_cancelled) and dispatches the fast-path command, leaving the order stock_reserved', async () => {
    const order = orderAt('stock_reserved');
    orders.findById = vi.fn(async () => order);

    const result = await handler.execute({ orderId: order.id.value });

    expect(result.outcome).toBe('compensation_pending');
    if (result.outcome !== 'compensation_pending') throw new Error('unreachable');
    expect(result.status).toBe('stock_reserved');
    expect(result.compensationPlanned).toEqual(['stock_release']);

    // The order itself is untouched — R27/R28's own "release first, cancel
    // only when the release fact arrives" ordering (saga.md §4.3.1),
    // reused verbatim for the operator-triggered path.
    expect(saveSpy).not.toHaveBeenCalled();

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const [, input] = enqueueSpy.mock.calls[0] as [TransactionContext, EnqueueSagaCommandInput];
    expect(input.command).toBe('stock.release');
    expect(input.orderId.equals(order.id)).toBe(true);
    expect((input.payload as StockReleaseRequestPayload).reason).toBe('order_cancelled');
    expect(input.triggeringEventTopic).toBe(ORDERS_FACTS_TOPIC);
    // Deliberately NOT one of the fourteen real wire fact types
    // (cancel-order.handler.ts's header) — an operator cancel is RPC-
    // triggered, not fact-triggered, and this envelope's `eventType` must
    // stay visibly synthetic so a DLQ redrive is never mistaken for a real
    // fact replay.
    expect(input.triggeringEventEnvelope.eventType).toBe('orders.cancel.requested');

    // The fast path — the SAME command class `saga-dispatch.commands.ts`'s
    // fact-driven `stock.release` branch (`CreditRejectionRecorded`) uses,
    // reused verbatim, not a second dispatch mechanism.
    expect(commandBus.execute).toHaveBeenCalledTimes(1);
    const [dispatched] = commandBus.execute.mock.calls[0] as [IssueStockReleaseCommand];
    expect(dispatched).toBeInstanceOf(IssueStockReleaseCommand);
    expect(dispatched.orderId).toBe(order.id.value);
  });

  it.each<OrderStatus>(['credit_approved', 'confirmed'])(
    'OCR-credit-release — enqueues credit.release and dispatches the fast-path command for status %s, leaving the order unchanged (reverse order of acquisition, saga.md §4.3)',
    async (status) => {
      const order = orderAt(status);
      orders.findById = vi.fn(async () => order);

      const result = await handler.execute({ orderId: order.id.value, note: 'operator cancel' });

      expect(result.outcome).toBe('compensation_pending');
      if (result.outcome !== 'compensation_pending') throw new Error('unreachable');
      expect(result.status).toBe(status);
      // credit_release FIRST, stock_release SECOND — reverse order of
      // acquisition; only credit_release is actually issued by this call,
      // stock_release follows once credit.released.v1 arrives.
      expect(result.compensationPlanned).toEqual(['credit_release', 'stock_release']);

      // The order itself is untouched — released FIRST, cancelled only
      // once the fact chain (credit.released.v1 -> stock.release ->
      // stock.released.v1) completes, mirroring the stock_reserved
      // branch's own "release first, cancel later" ordering.
      expect(saveSpy).not.toHaveBeenCalled();

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const [, input] = enqueueSpy.mock.calls[0] as [TransactionContext, EnqueueSagaCommandInput];
      expect(input.command).toBe('credit.release');
      expect(input.orderId.equals(order.id)).toBe(true);
      const payload = input.payload as CreditReleaseRequestPayload;
      expect(payload.orderReference).toBe(order.orderReference.value);
      expect(payload.retailerCode).toBe(FIXTURE_RETAILER_CODE);
      expect(payload.companyCode).toBe(FIXTURE_COMPANY_CODE);
      expect(input.triggeringEventTopic).toBe(ORDERS_FACTS_TOPIC);
      expect(input.triggeringEventEnvelope.eventType).toBe('orders.cancel.requested');

      expect(commandBus.execute).toHaveBeenCalledTimes(1);
      const [dispatched] = commandBus.execute.mock.calls[0] as [IssueCreditReleaseCommand];
      expect(dispatched).toBeInstanceOf(IssueCreditReleaseCommand);
      expect(dispatched.orderId).toBe(order.id.value);
    },
  );

  it.each<OrderStatus>(['despatched', 'invoiced', 'paid', 'completed'])(
    'OCR-terminal — replies not_cancellable for status %s via Order.cancel\'s own OrderTransitionNotAllowedError guard, persists nothing',
    async (status) => {
      const order = orderAt(status);
      orders.findById = vi.fn(async () => order);

      const result = await handler.execute({ orderId: order.id.value });

      expect(result.outcome).toBe('not_cancellable');
      if (result.outcome !== 'not_cancellable') throw new Error('unreachable');
      expect(result.status).toBe(status);

      expect(saveSpy).not.toHaveBeenCalled();
      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(commandBus.execute).not.toHaveBeenCalled();
      // The order's OWN in-memory status is unchanged too — `Order.cancel`
      // throws before mutating `props` (`transitionTo`'s guard runs first).
      expect(order.status).toBe(status);
    },
  );

  it('OCR-terminal — an ALREADY-cancelled order also replies not_cancellable, not a duplicate order.cancelled.v1', async () => {
    const order = orderAt('placed');
    order.cancel('stock_rejected', { occurredAt: clock.now(), causationId: UniqueId.generate() }, []);
    orders.findById = vi.fn(async () => order);

    const result = await handler.execute({ orderId: order.id.value });

    expect(result.outcome).toBe('not_cancellable');
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
