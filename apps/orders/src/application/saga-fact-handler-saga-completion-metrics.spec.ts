// Pure unit — A7 (metrics, R59/OR5, design.md §4.5): `SagaFactHandler`'s
// `otc_saga_completion_ms` recording, proven against a FAKE
// `RecordsSagaMetrics` collaborator (the business-logic proof: WHEN it
// fires, WHAT duration it computes) — the real OTel histogram wiring
// (`OtelSagaMetrics`) is proven separately in
// `otel-saga-metrics.spec.ts`. The binding standard this file exists to
// satisfy: prove the duration is measured from the order's OWN
// `order.placed.v1` timestamp to the REAL closing fact's own timestamp,
// not from an arbitrary starting point (e.g. `Date.now()` at handler-call
// time) — every case below uses TWO deliberately different, far-apart
// timestamps (the order's `orderDate` and each fact's `occurredAt`) so a
// handler that measured from the wrong instant would compute a visibly
// wrong duration, not a coincidentally-correct one.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import { describe, expect, it } from 'vitest';
import type { ConsumerName } from './ports/consumer-name.js';
import type { OrderRepository } from './ports/order-repository.port.js';
import type {
  EnqueueOutcome,
  EnqueueSagaCommandInput,
  SagaCommandRecord,
  SagaCommandStore,
} from './ports/saga-command-store.port.js';
import type { SagaCompletionOutcome } from './ports/saga-metrics.port.js';
import type { TransactionContext } from './ports/unit-of-work.port.js';
import { Order, type PlaceOrderInput, type PlaceOrderLineInput, type TransitionContext } from '../domain/order.js';
import type { RecordIgnoredFactInput } from '../infrastructure/saga/saga-ignored-facts.repository.js';
import { SagaFactHandler, type RecordsIgnoredSagaFacts, type RunsIdempotently } from './saga-fact-handler.js';

// The order's OWN order.placed.v1 timestamp — deliberately far from every
// fact's own `occurredAt` below, so a correct implementation and a buggy
// one (e.g. one that measured from `Date.now()`, or from `ctx.occurredAt`
// on BOTH ends) disagree by an obviously-wrong amount, not a
// coincidentally-close one.
const ORDER_PLACED_AT = new Date('2026-01-01T00:00:00.000Z');

function placeInput(overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  const line: PlaceOrderLineInput = {
    productCode: 'PRD-0001',
    description: 'Widget',
    quantity: Quantity.of(2),
    unitPrice: Money.of(1_000, 'EUR'),
    lineDiscount: Money.of(0, 'EUR'),
  };
  return {
    id: UniqueId.generate(),
    orderReference: OrderNumber.fromSequence(1),
    orderDate: ORDER_PLACED_AT,
    buyer: { gln: GLN.of('5412345000013'), code: 'RET-0001' },
    supplier: { gln: GLN.of('5412345000037'), code: 'COM-0001' },
    currency: 'EUR',
    lines: [line],
    ...overrides,
  };
}

function ctxAt(occurredAt: string): TransitionContext {
  return { occurredAt: new Date(occurredAt), causationId: UniqueId.generate() };
}

function fact(overrides: Partial<Envelope> = {}): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-01-01T00:00:00.000Z',
    payload: {},
    ...overrides,
  };
}

class FakeIdempotentConsumer implements RunsIdempotently {
  async runOnce(
    _eventId: string,
    _consumer: ConsumerName,
    work: (tx: TransactionContext) => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    await work({} as TransactionContext);
    return 'processed';
  }
}

class FakeOrderRepository implements OrderRepository {
  private readonly byId = new Map<string, Order>();

  seed(order: Order): void {
    this.byId.set(order.id.value, order);
  }

  async findById(id: UniqueId): Promise<Order | null> {
    return this.byId.get(id.value) ?? null;
  }

  async findByReference(): Promise<Order | null> {
    throw new Error('not used by this test');
  }

  async findByRequestId(): Promise<Order | null> {
    throw new Error('not used by this test');
  }

  async save(order: Order): Promise<void> {
    this.byId.set(order.id.value, order);
  }
}

class FakeSagaCommandStore implements SagaCommandStore {
  async enqueue(_tx: TransactionContext, _input: EnqueueSagaCommandInput): Promise<EnqueueOutcome> {
    return 'enqueued';
  }

  async findByOrderAndCommand(): Promise<SagaCommandRecord | null> {
    throw new Error('not used by this test');
  }

  async claimDue(): Promise<readonly SagaCommandRecord[]> {
    throw new Error('not used by this test');
  }

  async markSent(): Promise<boolean> {
    throw new Error('not used by this test');
  }

  async park(): Promise<boolean> {
    throw new Error('not used by this test');
  }

  async markRejected(): Promise<boolean> {
    throw new Error('not used by this test');
  }

  async claimDeadLetter(): Promise<boolean> {
    throw new Error('not used by this test');
  }
}

class FakeIgnoredFactsRepository implements RecordsIgnoredSagaFacts {
  async record(_tx: TransactionContext, _input: RecordIgnoredFactInput): Promise<void> {
    /* not asserted by this file */
  }
}

class FakeSagaMetrics {
  readonly recorded: Array<{ durationMs: number; outcome: SagaCompletionOutcome }> = [];

  recordSagaCompletion(durationMs: number, outcome: SagaCompletionOutcome): void {
    this.recorded.push({ durationMs, outcome });
  }
}

function newHandler(orders: FakeOrderRepository, sagaMetrics: FakeSagaMetrics): SagaFactHandler {
  return new SagaFactHandler(
    new FakeIdempotentConsumer(),
    orders,
    new FakeSagaCommandStore(),
    new FakeIgnoredFactsRepository(),
    sagaMetrics,
  );
}

describe('SagaFactHandler — otc_saga_completion_ms (A7, R59, OR5, design.md §4.5)', () => {
  it('R24 — the fact that completes the saga (credit.released.v1, precondition paid) records EXACTLY ONE completion, measured from order.orderDate (the real order.placed.v1 timestamp) to THIS fact\'s own occurredAt', async () => {
    const order = Order.place(placeInput(), ctxAt('2026-01-01T00:00:00.000Z'));
    order.markStockReserved(ctxAt('2026-01-01T01:00:00.000Z'));
    order.approveCredit(ctxAt('2026-01-01T02:00:00.000Z'));
    order.confirm(ctxAt('2026-01-01T02:00:00.000Z'));
    order.markDespatched(ctxAt('2026-01-02T00:00:00.000Z'));
    order.markInvoiced(ctxAt('2026-01-03T00:00:00.000Z'));
    order.markPaid(ctxAt('2026-01-10T00:00:00.000Z'));
    order.pullDomainEvents();
    const orders = new FakeOrderRepository();
    orders.seed(order);
    const sagaMetrics = new FakeSagaMetrics();
    const handler = newHandler(orders, sagaMetrics);

    const closingOccurredAt = '2026-01-15T12:30:00.000Z';
    const envelope = fact({ eventType: 'credit.released.v1', correlationId: order.id.value, occurredAt: closingOccurredAt });

    const result = await handler.handle(envelope, 'otc.billing.facts.v1');

    expect(result.outcome).toBe('processed');
    expect(sagaMetrics.recorded).toHaveLength(1);
    const expectedDurationMs = new Date(closingOccurredAt).getTime() - ORDER_PLACED_AT.getTime();
    expect(expectedDurationMs).toBe(14 * 24 * 60 * 60 * 1000 + 12.5 * 60 * 60 * 1000); // sanity: 14d12h30m
    expect(sagaMetrics.recorded[0]).toEqual({ durationMs: expectedDurationMs, outcome: 'completed' });
  });

  it('R26 — a direct cancel (stock.rejected.v1, precondition placed) records EXACTLY ONE cancellation, measured from order.orderDate to THIS fact\'s own occurredAt', async () => {
    const order = Order.place(placeInput(), ctxAt('2026-01-01T00:00:00.000Z'));
    order.pullDomainEvents();
    const orders = new FakeOrderRepository();
    orders.seed(order);
    const sagaMetrics = new FakeSagaMetrics();
    const handler = newHandler(orders, sagaMetrics);

    const closingOccurredAt = '2026-01-01T00:05:00.000Z';
    const envelope = fact({ eventType: 'stock.rejected.v1', correlationId: order.id.value, occurredAt: closingOccurredAt });

    const result = await handler.handle(envelope, 'otc.fulfillment.facts.v1');

    expect(result.outcome).toBe('processed');
    expect(sagaMetrics.recorded).toEqual([{ durationMs: 5 * 60 * 1000, outcome: 'cancelled' }]);
  });

  it('R27/R28 — the compensation-completing cancel (stock.released.v1, precondition stock_reserved) records EXACTLY ONE cancellation, not two, even though credit.rejected.v1 already advanced the saga once', async () => {
    const order = Order.place(placeInput(), ctxAt('2026-01-01T00:00:00.000Z'));
    order.markStockReserved(ctxAt('2026-01-01T01:00:00.000Z'));
    order.pullDomainEvents();
    const orders = new FakeOrderRepository();
    orders.seed(order);
    const sagaMetrics = new FakeSagaMetrics();
    const handler = newHandler(orders, sagaMetrics);

    // First: credit.rejected.v1 — an ADVANCE step (no status change, R27),
    // must record NOTHING (the saga has not closed yet).
    await handler.handle(
      fact({ eventType: 'credit.rejected.v1', correlationId: order.id.value, occurredAt: '2026-01-01T02:00:00.000Z' }),
      'otc.billing.facts.v1',
    );
    expect(sagaMetrics.recorded).toHaveLength(0);

    // Then: stock.released.v1 — the CANCEL step that actually closes it.
    const closingOccurredAt = '2026-01-01T03:00:00.000Z';
    const result = await handler.handle(
      fact({
        eventType: 'stock.released.v1',
        correlationId: order.id.value,
        occurredAt: closingOccurredAt,
        payload: { reason: 'credit_rejected' },
      }),
      'otc.fulfillment.facts.v1',
    );

    expect(result.outcome).toBe('processed');
    expect(sagaMetrics.recorded).toEqual([{ durationMs: 3 * 60 * 60 * 1000, outcome: 'cancelled' }]);
  });

  it('a non-closing advance step (order.placed.v1 itself) records NOTHING', async () => {
    const order = Order.place(placeInput(), ctxAt('2026-01-01T00:00:00.000Z'));
    order.pullDomainEvents();
    const orders = new FakeOrderRepository();
    orders.seed(order);
    const sagaMetrics = new FakeSagaMetrics();
    const handler = newHandler(orders, sagaMetrics);

    await handler.handle(
      fact({ eventType: 'order.placed.v1', correlationId: order.id.value, occurredAt: '2026-01-01T00:00:00.000Z' }),
      'otc.orders.facts.v1',
    );

    expect(sagaMetrics.recorded).toHaveLength(0);
  });

  it('an ignored fact (precondition unmet) records NOTHING', async () => {
    const order = Order.place(placeInput(), ctxAt('2026-01-01T00:00:00.000Z'));
    order.pullDomainEvents();
    const orders = new FakeOrderRepository();
    orders.seed(order);
    const sagaMetrics = new FakeSagaMetrics();
    const handler = newHandler(orders, sagaMetrics);

    // `credit.approved.v1` expects `stock_reserved`; the order is `placed`.
    const result = await handler.handle(
      fact({ eventType: 'credit.approved.v1', correlationId: order.id.value }),
      'otc.billing.facts.v1',
    );

    expect(result.outcome).toBe('ignored');
    expect(sagaMetrics.recorded).toHaveLength(0);
  });
});
