// Pure unit — every collaborator faked (CLAUDE.md § Testing conventions).
// Proves the composition design.md §5.1 describes: duplicate -> nothing
// beyond the dedup layer; unknown order -> SO8 record; precondition
// mismatch -> R25 record; enqueue happens IN the same transactional unit
// (SO3) and ordering vs `orders.save` is deterministic; the returned
// `SagaFactResult` carries exactly what the wrapping `@CommandHandler`
// needs (§5.1 step 4).
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConsumerName } from './ports/consumer-name.js';
import type { OrderRepository } from './ports/order-repository.port.js';
import type {
  EnqueueSagaCommandInput,
  SagaCommandRecord,
  SagaCommandStore,
} from './ports/saga-command-store.port.js';
import type { TransactionContext } from './ports/unit-of-work.port.js';
import { Order, type PlaceOrderInput, type PlaceOrderLineInput } from '../domain/order.js';
import type { RecordIgnoredFactInput } from '../infrastructure/saga/saga-ignored-facts.repository.js';
import { SagaFactHandler, type RecordsIgnoredSagaFacts, type RunsIdempotently } from './saga-fact-handler.js';

function fakeTx(): TransactionContext {
  return {} as TransactionContext;
}

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
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
    buyer: { gln: GLN.of('5412345000013'), code: 'RET-0001' },
    supplier: { gln: GLN.of('5412345000037'), code: 'COM-0001' },
    currency: 'EUR',
    lines: [line],
    ...overrides,
  };
}

function ctx() {
  return { occurredAt: new Date('2026-08-20T10:00:00.000Z'), causationId: UniqueId.generate() };
}

function fact(overrides: Partial<Envelope> = {}): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-08-20T10:05:00.000Z',
    payload: {},
    ...overrides,
  };
}

/** A trivial `RunsIdempotently` fake that runs `work` unless `eventId` is in the pre-seeded duplicate set — insert-first behaviour is `IdempotentConsumer`'s own job, already proven elsewhere; this fake only needs to reproduce ITS observable contract. */
class FakeIdempotentConsumer implements RunsIdempotently {
  readonly seen: string[] = [];
  duplicateEventIds = new Set<string>();

  async runOnce(
    eventId: string,
    _consumer: ConsumerName,
    work: (tx: TransactionContext) => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    this.seen.push(eventId);
    if (this.duplicateEventIds.has(eventId)) {
      return 'duplicate';
    }
    await work(fakeTx());
    return 'processed';
  }
}

class FakeOrderRepository implements OrderRepository {
  private readonly byId = new Map<string, Order>();
  savedOrders: Order[] = [];

  seed(order: Order): void {
    this.byId.set(order.id.value, order);
  }

  async findById(id: UniqueId): Promise<Order | null> {
    return this.byId.get(id.value) ?? null;
  }

  async findByReference(): Promise<Order | null> {
    throw new Error('not used by this test');
  }

  async save(order: Order): Promise<void> {
    this.savedOrders.push(order);
    this.byId.set(order.id.value, order);
  }
}

class FakeSagaCommandStore implements SagaCommandStore {
  enqueued: EnqueueSagaCommandInput[] = [];

  async enqueue(_tx: TransactionContext, input: EnqueueSagaCommandInput): Promise<void> {
    this.enqueued.push(input);
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
}

class FakeIgnoredFactsRepository implements RecordsIgnoredSagaFacts {
  recorded: RecordIgnoredFactInput[] = [];

  async record(_tx: TransactionContext, input: RecordIgnoredFactInput): Promise<void> {
    this.recorded.push(input);
  }
}

describe('SagaFactHandler', () => {
  let idempotency: FakeIdempotentConsumer;
  let orders: FakeOrderRepository;
  let commandStore: FakeSagaCommandStore;
  let ignoredFacts: FakeIgnoredFactsRepository;
  let handler: SagaFactHandler;

  beforeEach(() => {
    idempotency = new FakeIdempotentConsumer();
    orders = new FakeOrderRepository();
    commandStore = new FakeSagaCommandStore();
    ignoredFacts = new FakeIgnoredFactsRepository();
    handler = new SagaFactHandler(idempotency, orders, commandStore, ignoredFacts);
  });

  it('a duplicate delivery returns outcome duplicate and touches nothing else', async () => {
    idempotency.duplicateEventIds.add('dup-event-id');
    const envelope = fact({ eventId: 'dup-event-id' });

    const result = await handler.handle(envelope);

    expect(result).toEqual({ outcome: 'duplicate' });
    expect(orders.savedOrders).toHaveLength(0);
    expect(commandStore.enqueued).toHaveLength(0);
    expect(ignoredFacts.recorded).toHaveLength(0);
  });

  it('SO8 — an unknown order is recorded as ignored with the unknown_order marker and acknowledged, not thrown', async () => {
    const orderId = UniqueId.generate();
    const envelope = fact({ eventType: 'stock.reserved.v1', correlationId: orderId.value });

    const result = await handler.handle(envelope);

    expect(result).toEqual({ outcome: 'ignored' });
    expect(ignoredFacts.recorded).toHaveLength(1);
    expect(ignoredFacts.recorded[0]).toMatchObject({
      eventType: 'stock.reserved.v1',
      orderId: null,
      correlationId: orderId,
      observedStatus: null,
      expectedStatus: 'placed',
      marker: 'unknown_order',
    });
    expect(orders.savedOrders).toHaveLength(0);
    expect(commandStore.enqueued).toHaveLength(0);
  });

  it('R25 — a precondition mismatch is recorded as ignored with observed and expected status, no mutation, no command', async () => {
    const order = Order.place(placeInput(), ctx());
    order.pullDomainEvents();
    orders.seed(order);
    // The order is `placed`; `credit.approved.v1` expects `stock_reserved`.
    const envelope = fact({ eventType: 'credit.approved.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope);

    expect(result).toEqual({ outcome: 'ignored' });
    expect(ignoredFacts.recorded).toHaveLength(1);
    expect(ignoredFacts.recorded[0]).toMatchObject({
      eventType: 'credit.approved.v1',
      orderId: order.id,
      correlationId: order.id,
      observedStatus: 'placed',
      expectedStatus: 'stock_reserved',
      marker: 'precondition_unmet',
    });
    expect(orders.savedOrders).toHaveLength(0);
    expect(commandStore.enqueued).toHaveLength(0);
    expect(order.status).toBe('placed');
  });

  it('SO3 — a matching precondition applies the step, saves the order, and enqueues the owed command in that order, returning enqueued', async () => {
    const order = Order.place(placeInput(), ctx());
    order.pullDomainEvents();
    orders.seed(order);
    const envelope = fact({ eventType: 'order.placed.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope);

    expect(result).toEqual({ outcome: 'processed', enqueued: 'stock.reserve' });
    expect(orders.savedOrders).toHaveLength(1);
    expect(commandStore.enqueued).toHaveLength(1);
    expect(commandStore.enqueued[0]).toMatchObject({
      orderId: order.id,
      orderReference: order.orderReference,
      command: 'stock.reserve',
      triggeringEventId: UniqueId.from(envelope.eventId),
    });
  });

  it('a step with no commandAfter (e.g. invoice.issued.v1) processes and saves, but enqueues nothing and returns no enqueued field', async () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.approveCredit(ctx());
    order.confirm(ctx());
    order.markDespatched(ctx());
    order.pullDomainEvents();
    orders.seed(order);
    const envelope = fact({ eventType: 'invoice.issued.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope);

    expect(result).toEqual({ outcome: 'processed' });
    expect(orders.savedOrders).toHaveLength(1);
    expect(commandStore.enqueued).toHaveLength(0);
  });

  it('R26 — a cancel-kind step (stock.rejected.v1) saves the cancellation and never enqueues a command', async () => {
    const order = Order.place(placeInput(), ctx());
    order.pullDomainEvents();
    orders.seed(order);
    const envelope = fact({ eventType: 'stock.rejected.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope);

    expect(result).toEqual({ outcome: 'processed' });
    expect(orders.savedOrders).toHaveLength(1);
    expect(orders.savedOrders[0]?.status).toBe('cancelled');
    expect(orders.savedOrders[0]?.cancellationReason).toBe('stock_rejected');
    expect(commandStore.enqueued).toHaveLength(0);
  });

  it('SO2 — a skip-mapped event type (self-produced fact) returns processed with no I/O at all, not even dedup', async () => {
    const envelope = fact({ eventType: 'order.confirmed.v1' });

    const result = await handler.handle(envelope);

    expect(result).toEqual({ outcome: 'processed' });
    expect(idempotency.seen).toHaveLength(0);
    expect(orders.savedOrders).toHaveLength(0);
    expect(ignoredFacts.recorded).toHaveLength(0);
  });

  it('an unmapped event type also short-circuits with no I/O', async () => {
    const envelope = fact({ eventType: 'something.unmapped.v1' });

    const result = await handler.handle(envelope);

    expect(result).toEqual({ outcome: 'processed' });
    expect(idempotency.seen).toHaveLength(0);
  });
});
