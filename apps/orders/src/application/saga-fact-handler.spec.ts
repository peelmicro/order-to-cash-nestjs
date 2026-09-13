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
  EnqueueOutcome,
  EnqueueSagaCommandInput,
  SagaCommandRecord,
  SagaCommandStore,
} from './ports/saga-command-store.port.js';
import type { TransactionContext } from './ports/unit-of-work.port.js';
import { Order, type PlaceOrderInput, type PlaceOrderLineInput } from '../domain/order.js';
import type { RecordIgnoredFactInput } from '../infrastructure/saga/saga-ignored-facts.repository.js';
import { SagaFactHandler, type RecordsIgnoredSagaFacts, type RunsIdempotently } from './saga-fact-handler.js';

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
  /** Every transaction handed to `work` — a DISTINCT object per call, so a collaborator's recorded `tx` can be checked to be THIS unit of work's own (SA-4: the store query must read the same snapshot as the order it was asked about). */
  readonly handedOutTx: TransactionContext[] = [];
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
    const tx = { id: this.handedOutTx.length } as unknown as TransactionContext;
    this.handedOutTx.push(tx);
    await work(tx);
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

  async findByRequestId(): Promise<Order | null> {
    throw new Error('not used by this test');
  }

  async save(order: Order): Promise<void> {
    this.savedOrders.push(order);
    this.byId.set(order.id.value, order);
  }
}

class FakeSagaCommandStore implements SagaCommandStore {
  enqueued: EnqueueSagaCommandInput[] = [];
  nextEnqueueOutcome: EnqueueOutcome = 'enqueued';
  /** SA-4 — the order ids for which an operator cancellation has already been accepted (a `stock.release`/`credit.release` row carrying the synthetic `orders.cancel.requested` envelope). Seeded per test. */
  acceptedOperatorCancelOrderIds = new Set<string>();
  hasAcceptedOperatorCancelCalls: string[] = [];
  /** The transaction each read/write was actually performed in — SA-4's consistency claim is about WHICH snapshot, so the tx is recorded, not ignored. */
  txOfCall: TransactionContext[] = [];

  async hasAcceptedOperatorCancel(tx: TransactionContext, orderId: UniqueId): Promise<boolean> {
    this.hasAcceptedOperatorCancelCalls.push(orderId.value);
    this.txOfCall.push(tx);
    return this.acceptedOperatorCancelOrderIds.has(orderId.value);
  }

  async enqueue(_tx: TransactionContext, input: EnqueueSagaCommandInput): Promise<EnqueueOutcome> {
    this.enqueued.push(input);
    return this.nextEnqueueOutcome;
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

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'duplicate' });
    expect(orders.savedOrders).toHaveLength(0);
    expect(commandStore.enqueued).toHaveLength(0);
    expect(ignoredFacts.recorded).toHaveLength(0);
  });

  it('SO8 — an unknown order is recorded as ignored with the unknown_order marker and acknowledged, not thrown', async () => {
    const orderId = UniqueId.generate();
    const envelope = fact({ eventType: 'stock.reserved.v1', correlationId: orderId.value });

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

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

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

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

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

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

  it('FS1 — reports the owed command as enqueued when the store answers already_owed, so the fast path re-dispatches the existing row', async () => {
    const order = Order.place(placeInput(), ctx());
    order.pullDomainEvents();
    orders.seed(order);
    commandStore.nextEnqueueOutcome = 'already_owed';
    const envelope = fact({ eventType: 'order.placed.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'processed', enqueued: 'stock.reserve' });
    expect(commandStore.enqueued).toHaveLength(1);
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

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'processed' });
    expect(orders.savedOrders).toHaveLength(1);
    expect(commandStore.enqueued).toHaveLength(0);
  });

  it('R26 — a cancel-kind step (stock.rejected.v1) saves the cancellation and never enqueues a command', async () => {
    const order = Order.place(placeInput(), ctx());
    order.pullDomainEvents();
    orders.seed(order);
    const envelope = fact({ eventType: 'stock.rejected.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'processed' });
    expect(orders.savedOrders).toHaveLength(1);
    expect(orders.savedOrders[0]?.status).toBe('cancelled');
    expect(orders.savedOrders[0]?.cancellationReason).toBe('stock_rejected');
    expect(commandStore.enqueued).toHaveLength(0);
  });

  it('SO2 — a skip-mapped event type (self-produced fact) returns processed with no I/O at all, not even dedup', async () => {
    const envelope = fact({ eventType: 'order.confirmed.v1' });

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'processed' });
    expect(idempotency.seen).toHaveLength(0);
    expect(orders.savedOrders).toHaveLength(0);
    expect(ignoredFacts.recorded).toHaveLength(0);
  });

  it('an unmapped event type also short-circuits with no I/O', async () => {
    const envelope = fact({ eventType: 'something.unmapped.v1' });

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'processed' });
    expect(idempotency.seen).toHaveLength(0);
  });
});

// SA-4 (saga.md §4.3, "A credit approval that arrives after the
// cancellation") — a `credit.hold` issued before an operator cancelled a
// `stock_reserved` order can still be approved. That late
// `credit.approved.v1` must issue `credit.release` (reason
// `order_cancelled`) and NOTHING else: no transition, no
// `order.confirmed.v1`, no `despatch.create`.
describe('SagaFactHandler — SA-4: a credit.approved.v1 that arrives after an operator cancellation was accepted', () => {
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

  /** An order at `stock_reserved` — the state an operator cancellation leaves it in while its stock release is under way (the aggregate carries NO marker for the accepted cancellation, by design). */
  function stockReservedOrder(): Order {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.pullDomainEvents();
    orders.seed(order);
    return order;
  }

  it('still stock_reserved with the cancellation accepted: enqueues credit.release ONLY — no transition, no save, no despatch.create', async () => {
    const order = stockReservedOrder();
    commandStore.acceptedOperatorCancelOrderIds.add(order.id.value);
    const envelope = fact({ eventType: 'credit.approved.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'processed', enqueued: 'credit.release' });
    expect(commandStore.enqueued).toHaveLength(1);
    expect(commandStore.enqueued[0]).toMatchObject({
      orderId: order.id,
      orderReference: order.orderReference,
      command: 'credit.release',
      triggeringEventId: UniqueId.from(envelope.eventId),
      triggeringEventTopic: 'otc.orders.facts.v1',
    });
    // "and nothing else": the order is neither advanced nor saved, so no
    // order.confirmed.v1 can reach the outbox, and despatch.create — the
    // command the ORDINARY credit.approved.v1 path owes — is never enqueued.
    expect(commandStore.enqueued.map((input) => input.command)).toEqual(['credit.release']);
    expect(orders.savedOrders).toHaveLength(0);
    expect(order.status).toBe('stock_reserved');
    expect(order.pullDomainEvents()).toHaveLength(0);
    expect(ignoredFacts.recorded).toHaveLength(0);
    // The question was asked about THIS order, not some other one.
    expect(commandStore.hasAcceptedOperatorCancelCalls).toEqual([order.id.value]);
    // …and it was asked INSIDE the same transactional unit that loaded the
    // order, not on an ambient connection: the answer and the status it is
    // paired with must come from one snapshot.
    expect(idempotency.handedOutTx).toHaveLength(1);
    expect(commandStore.txOfCall[0]).toBe(idempotency.handedOutTx[0]);
  });

  it('already cancelled with reason operator_cancelled: enqueues credit.release ONLY, and never asks the store (the aggregate already answers)', async () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.cancel('operator_cancelled', ctx(), []);
    order.pullDomainEvents();
    orders.seed(order);
    const envelope = fact({ eventType: 'credit.approved.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'processed', enqueued: 'credit.release' });
    expect(commandStore.enqueued.map((input) => input.command)).toEqual(['credit.release']);
    expect(orders.savedOrders).toHaveLength(0);
    expect(order.status).toBe('cancelled');
    expect(commandStore.hasAcceptedOperatorCancelCalls).toHaveLength(0);
  });

  it('stock_reserved with NO accepted operator cancellation: the ORDINARY R21 path is untouched — confirms the order and owes despatch.create, never credit.release', async () => {
    const order = stockReservedOrder();
    const envelope = fact({ eventType: 'credit.approved.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'processed', enqueued: 'despatch.create' });
    expect(commandStore.enqueued.map((input) => input.command)).toEqual(['despatch.create']);
    expect(orders.savedOrders).toHaveLength(1);
    expect(orders.savedOrders[0]?.status).toBe('confirmed');
    expect(commandStore.hasAcceptedOperatorCancelCalls).toEqual([order.id.value]);
  });

  it.each(['stock_rejected', 'credit_rejected'] as const)(
    'already cancelled for reason %s (NOT an operator cancellation): falls through to R25 — ignored, precondition_unmet, and no credit.release',
    async (reason) => {
      const order = Order.place(placeInput(), ctx());
      if (reason === 'credit_rejected') {
        order.markStockReserved(ctx());
      }
      order.cancel(reason, ctx(), []);
      order.pullDomainEvents();
      orders.seed(order);
      const envelope = fact({ eventType: 'credit.approved.v1', correlationId: order.id.value });

      const result = await handler.handle(envelope, 'otc.orders.facts.v1');

      expect(result).toEqual({ outcome: 'ignored' });
      expect(commandStore.enqueued).toHaveLength(0);
      expect(orders.savedOrders).toHaveLength(0);
      expect(ignoredFacts.recorded[0]).toMatchObject({ eventType: 'credit.approved.v1', marker: 'precondition_unmet', observedStatus: 'cancelled' });
    },
  );

  it('a LATE credit.approved.v1 for an order already past confirmation (e.g. despatched) is still R25-ignored — this branch widens nothing', async () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.approveCredit(ctx());
    order.confirm(ctx());
    order.markDespatched(ctx());
    order.pullDomainEvents();
    orders.seed(order);
    commandStore.acceptedOperatorCancelOrderIds.add(order.id.value);
    const envelope = fact({ eventType: 'credit.approved.v1', correlationId: order.id.value });

    const result = await handler.handle(envelope, 'otc.orders.facts.v1');

    expect(result).toEqual({ outcome: 'ignored' });
    expect(commandStore.enqueued).toHaveLength(0);
    expect(commandStore.hasAcceptedOperatorCancelCalls).toHaveLength(0);
  });
});
