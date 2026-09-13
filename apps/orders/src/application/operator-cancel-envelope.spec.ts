// Pure unit — no store, no broker. SA-4's ONE content test, proven from
// both ends: the envelope `CancelOrderHandler` actually WRITES is
// recognised, and the envelopes the fact-driven flow writes onto rows of
// the very same two commands are NOT.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelOrderHandler } from './cancel-order.handler';
import { isOperatorCancelEnvelope, OPERATOR_CANCEL_EVENT_TYPE } from './operator-cancel-envelope';
import type { Clock } from './ports/clock.port';
import type { OrderRepository } from './ports/order-repository.port';
import type { EnqueueSagaCommandInput, SagaCommandStore } from './ports/saga-command-store.port';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port';
import { Order } from '../domain/order';

const ORDERS_FACTS_TOPIC = 'otc.orders.facts.v1';

function realFact(eventType: string): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType,
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-08-21T10:00:00.000Z',
    payload: { orderReference: 'ORD-000042' },
  };
}

describe('isOperatorCancelEnvelope — SA-4\'s content test (application/operator-cancel-envelope.ts)', () => {
  it('recognises the synthetic operator-cancel envelope', () => {
    expect(isOperatorCancelEnvelope(realFact(OPERATOR_CANCEL_EVENT_TYPE))).toBe(true);
  });

  it.each([
    // The two REAL facts that put a row on the very same commands this
    // predicate scans: `credit.rejected.v1` owes `stock.release` (R27's
    // automatic compensation) and `stock.released.v1` owes `credit.release`
    // (SA-4's own second hop). Neither is an operator cancellation, and
    // counting either would make every credit-rejected order look like one.
    'credit.rejected.v1',
    'stock.released.v1',
    'credit.approved.v1',
    'order.placed.v1',
  ])('does NOT recognise the real fact %s, whose rows sit on the same commands', (eventType) => {
    expect(isOperatorCancelEnvelope(realFact(eventType))).toBe(false);
  });

  it('answers false for a missing or malformed envelope rather than throwing', () => {
    expect(isOperatorCancelEnvelope(null)).toBe(false);
    expect(isOperatorCancelEnvelope(undefined)).toBe(false);
    expect(isOperatorCancelEnvelope({} as Envelope)).toBe(false);
  });
});

// The writer and the reader must agree, and they only do because they share
// one constant: this test reads the envelope the REAL handler enqueues and
// hands it to the REAL predicate. Change the literal on either side alone
// and this fails — which is the failure mode that would otherwise be silent
// (`hasAcceptedOperatorCancel` would simply answer "no" for every order,
// and a late credit approval would resurrect a cancelled one).
describe('CancelOrderHandler writes an envelope its own reader recognises', () => {
  let enqueueSpy: ReturnType<typeof vi.fn>;
  let handler: CancelOrderHandler;
  let order: Order;

  beforeEach(() => {
    enqueueSpy = vi.fn(async () => 'enqueued' as const);
    const commandStore = {
      enqueue: enqueueSpy as SagaCommandStore['enqueue'],
      findByOrderAndCommand: vi.fn(),
      claimDue: vi.fn(),
      markSent: vi.fn(),
      park: vi.fn(),
      markRejected: vi.fn(),
      claimDeadLetter: vi.fn(),
      hasAcceptedOperatorCancel: vi.fn(),
    } as unknown as SagaCommandStore;
    const unitOfWork = {
      execute: vi.fn(async (work: (tx: TransactionContext) => Promise<unknown>) => work({} as TransactionContext)),
    } as unknown as UnitOfWork;

    const ctx = { occurredAt: new Date('2026-08-21T10:00:00.000Z'), causationId: UniqueId.generate() };
    order = Order.place(
      {
        id: UniqueId.generate(),
        orderReference: OrderNumber.fromSequence(42),
        orderDate: ctx.occurredAt,
        buyer: { gln: GLN.of('5412345000013'), code: 'RET-0001' },
        supplier: { gln: GLN.of('5412345000037'), code: 'COM-0001' },
        currency: 'EUR',
        lines: [
          {
            productCode: 'PRD-0001',
            description: 'Widget',
            quantity: Quantity.of(2),
            unitPrice: Money.of(1_000, 'EUR'),
            lineDiscount: Money.of(0, 'EUR'),
          },
        ],
      },
      ctx,
    );
    order.markStockReserved(ctx);

    const orders = {
      findById: vi.fn(async () => order),
      findByReference: vi.fn(),
      findByRequestId: vi.fn(),
      save: vi.fn(),
    } as unknown as OrderRepository;
    const clock: Clock = { now: () => new Date('2026-08-21T11:00:00.000Z') };
    const commandBus = { execute: vi.fn(async () => undefined) };

    handler = new CancelOrderHandler(unitOfWork, orders, commandStore, commandBus as never, clock, ORDERS_FACTS_TOPIC);
  });

  it('the envelope enqueued by an operator cancellation satisfies isOperatorCancelEnvelope', async () => {
    await handler.execute({ orderId: order.id.value, note: 'customer changed their mind' });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const [, input] = enqueueSpy.mock.calls[0] as [TransactionContext, EnqueueSagaCommandInput];
    expect(isOperatorCancelEnvelope(input.triggeringEventEnvelope)).toBe(true);
  });
});
