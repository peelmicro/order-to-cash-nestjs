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
  OrderConfirmed,
  OrderMarkedDespatched,
  OrderMarkedStockReserved,
  OrderPlacedFactRecorded,
} from '../events/saga-dispatch.events.js';
import {
  HandleCreditApprovedFactCommand,
  HandleCreditRejectedFactCommand,
  HandleInvoiceIssuedFactCommand,
  HandleOrderDespatchedFactCommand,
  HandleOrderPlacedFactCommand,
  HandleStockReservedFactCommand,
} from './saga-fact.commands.js';
import {
  HandleCreditApprovedFactHandler,
  HandleCreditRejectedFactHandler,
  HandleInvoiceIssuedFactHandler,
  HandleOrderDespatchedFactHandler,
  HandleOrderPlacedFactHandler,
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
    const command = new HandleOrderPlacedFactCommand(envelope());

    const result = await handler.execute(command);

    expect(inner.handle).toHaveBeenCalledWith(command.envelope);
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

    await handler.execute(new HandleOrderPlacedFactCommand(envelope()));

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('HandleOrderPlacedFactHandler publishes nothing on ignored', async () => {
    const inner = fakeHandler({ outcome: 'ignored' });
    const eventBus = fakeEventBus();
    const handler = new HandleOrderPlacedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleOrderPlacedFactCommand(envelope()));

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('HandleStockReservedFactHandler publishes OrderMarkedStockReserved on processed+enqueued', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'credit.hold' });
    const eventBus = fakeEventBus();
    const handler = new HandleStockReservedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleStockReservedFactCommand(envelope()));

    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(OrderMarkedStockReserved);
  });

  it('HandleCreditRejectedFactHandler publishes CreditRejectionRecorded on processed+enqueued (path B, R27)', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'stock.release' });
    const eventBus = fakeEventBus();
    const handler = new HandleCreditRejectedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleCreditRejectedFactCommand(envelope()));

    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(CreditRejectionRecorded);
  });

  it('HandleCreditApprovedFactHandler publishes OrderConfirmed on processed+enqueued (R21)', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'despatch.create' });
    const eventBus = fakeEventBus();
    const handler = new HandleCreditApprovedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleCreditApprovedFactCommand(envelope()));

    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(OrderConfirmed);
  });

  it('HandleOrderDespatchedFactHandler publishes OrderMarkedDespatched on processed+enqueued', async () => {
    const inner = fakeHandler({ outcome: 'processed', enqueued: 'invoice.issue' });
    const eventBus = fakeEventBus();
    const handler = new HandleOrderDespatchedFactHandler(inner as unknown as SagaFactHandler, eventBus as never);

    await handler.execute(new HandleOrderDespatchedFactCommand(envelope()));

    expect(eventBus.publish.mock.calls[0]?.[0]).toBeInstanceOf(OrderMarkedDespatched);
  });

  it('handlers for facts that never own a command (invoice.issued.v1) take no EventBus at all and just delegate', async () => {
    const inner = fakeHandler({ outcome: 'processed' });
    const handler = new HandleInvoiceIssuedFactHandler(inner as unknown as SagaFactHandler);

    const result = await handler.execute(new HandleInvoiceIssuedFactCommand(envelope()));

    expect(result).toEqual({ outcome: 'processed' });
    expect(inner.handle).toHaveBeenCalledTimes(1);
  });
});
