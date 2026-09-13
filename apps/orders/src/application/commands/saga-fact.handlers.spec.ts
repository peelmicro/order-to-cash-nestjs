// Pure unit — `SagaFactHandler` and `EventBus` both faked. Proves the
// wrapper behaviour design.md §5.1 step 4 / §5.5 describes: delegation to
// `SagaFactHandler`, and the dispatch-owed event published ONLY on
// processed-with-enqueue — never on duplicate, ignored, or processed
// without an owed command.
import type { Envelope } from '@otc/contracts';
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import type { SagaFactHandler, SagaFactResult } from '../saga-fact-handler.js';
import {
  CreditRejectionRecorded,
  LateCreditApprovalRecorded,
  OrderConfirmed,
  OrderMarkedDespatched,
  OrderMarkedStockReserved,
  OrderPlacedFactRecorded,
  StockReleasedForCancellationRecorded,
} from '../events/saga-dispatch.events.js';
import {
  HandleCreditApprovedFactCommand,
  HandleCreditReleasedFactCommand,
  HandleCreditRejectedFactCommand,
  HandleInvoiceIssuedFactCommand,
  HandleOrderDespatchedFactCommand,
  HandleOrderPlacedFactCommand,
  HandleStockReleasedFactCommand,
  HandleStockReservedFactCommand,
} from './saga-fact.commands.js';
import {
  HandleCreditApprovedFactHandler,
  HandleCreditReleasedFactHandler,
  HandleCreditRejectedFactHandler,
  HandleInvoiceIssuedFactHandler,
  HandleOrderDespatchedFactHandler,
  HandleOrderPlacedFactHandler,
  HandleStockReleasedFactHandler,
  HandleStockReservedFactHandler,
} from './saga-fact.handlers.js';

function envelope(): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-08-20T10:00:00.000Z',
    payload: {},
  };
}

function fakeHandler(result: SagaFactResult): { handle: ReturnType<typeof vi.fn> } {
  return { handle: vi.fn().mockResolvedValue(result) };
}

function fakeEventBus(): { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn() };
}

describe('saga-fact.handlers — delegation + publish-only-on-processed-with-enqueue (design.md §5.1 step 4)', () => {
  it('HandleOrderPlacedFactHandler delegates to SagaFactHandler.handle and publishes OrderPlacedFactRecorded on processed+enqueued', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'stock.reserve' });
    const eventBus = fakeEventBus();
    const handler = new HandleOrderPlacedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);
    const command = new HandleOrderPlacedFactCommand(envelope(), 'otc.orders.facts.v1');

    const result = await handler.execute(command);

    expect(inner.handle).toHaveBeenCalledWith(command.envelope, command.topic);
    expect(result).toEqual({ outcome: 'processed', enqueued: 'stock.reserve' });
    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(OrderPlacedFactRecorded);
    expect(eventBus.publish.mock.calls[0]?.[0]).toMatchObject({
      orderId: command.envelope.correlationId,
      correlationId: command.envelope.correlationId,
    });
  });

  it('HandleOrderPlacedFactHandler publishes nothing on duplicate', async () => {
    const inner = fakeHandler({ outcome: 'duplicate' });
    const eventBus = fakeEventBus();
    const handler = new HandleOrderPlacedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleOrderPlacedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('HandleOrderPlacedFactHandler publishes nothing on ignored', async () => {
    const inner = fakeHandler({ outcome: 'ignored' });
    const eventBus = fakeEventBus();
    const handler = new HandleOrderPlacedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleOrderPlacedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('HandleStockReservedFactHandler publishes OrderMarkedStockReserved on processed+enqueued', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'credit.hold' });
    const eventBus = fakeEventBus();
    const handler = new HandleStockReservedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleStockReservedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(OrderMarkedStockReserved);
  });

  it('HandleCreditRejectedFactHandler publishes CreditRejectionRecorded on processed+enqueued (path B, R27)', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'stock.release' });
    const eventBus = fakeEventBus();
    const handler = new HandleCreditRejectedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleCreditRejectedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(CreditRejectionRecorded);
  });

  it('HandleCreditApprovedFactHandler publishes OrderConfirmed on processed+enqueued (R21)', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'despatch.create' });
    const eventBus = fakeEventBus();
    const handler = new HandleCreditApprovedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleCreditApprovedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(OrderConfirmed);
  });

  it('SA-4 — HandleCreditApprovedFactHandler publishes LateCreditApprovalRecorded, NOT OrderConfirmed, when the enqueued command is credit.release (the late approval for an accepted operator cancel)', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'credit.release' });
    const eventBus = fakeEventBus();
    const handler = new HandleCreditApprovedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleCreditApprovedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    // Publishing OrderConfirmed here would issue a despatch.create for an
    // order that is being cancelled — the event is chosen by WHICH command
    // was enqueued, never by the fact type.
    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(LateCreditApprovalRecorded);
    expect(eventBus.publish.mock.calls[0]?.[0]).not.toBeInstanceOf(OrderConfirmed);
  });

  it('SA-4 — HandleStockReleasedFactHandler publishes StockReleasedForCancellationRecorded on processed+enqueued (the credit_approved/confirmed variant owing credit.release)', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'credit.release' });
    const eventBus = fakeEventBus();
    const handler = new HandleStockReleasedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleStockReleasedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(StockReleasedForCancellationRecorded);
  });

  it('SA-4 — HandleStockReleasedFactHandler publishes nothing for R28/SO7\'s stock_reserved variant, which owes no command', async () => {
    const inner = fakeHandler({ outcome: 'processed' });
    const eventBus = fakeEventBus();
    const handler = new HandleStockReleasedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleStockReleasedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('HandleOrderDespatchedFactHandler publishes OrderMarkedDespatched on processed+enqueued', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'invoice.issue' });
    const eventBus = fakeEventBus();
    const handler = new HandleOrderDespatchedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleOrderDespatchedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(OrderMarkedDespatched);
  });

  it('SA-4 — HandleCreditReleasedFactHandler takes no EventBus at all: none of credit.released.v1\'s three variants owes a command any more (R24 completes the saga; the credit_approved/confirmed variants are the terminal cancel)', async () => {
    const inner = fakeHandler({ outcome: 'processed' });
    const handler = new HandleCreditReleasedFactHandler(inner as unknown as SagaFactHandler);

    const result = await handler.execute(new HandleCreditReleasedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(result).toEqual({ outcome: 'processed' });
    expect(inner.handle).toHaveBeenCalledTimes(1);
  });

  it('handlers for facts that never own a command (invoice.issued.v1) take no EventBus at all and just delegate', async () => {
    const inner = fakeHandler({ outcome: 'processed' });
    const handler = new HandleInvoiceIssuedFactHandler(inner as unknown as SagaFactHandler);

    const result = await handler.execute(new HandleInvoiceIssuedFactCommand(envelope(), 'otc.orders.facts.v1'));

    expect(result).toEqual({ outcome: 'processed' });
    expect(inner.handle).toHaveBeenCalledTimes(1);
  });
});
