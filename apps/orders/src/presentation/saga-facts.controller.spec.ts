// Pure unit — a fake `CommandBus`. Proves envelope parsing, routing to the
// mapped fact command (design.md §3.3), the self-fact skip with NO
// CommandBus dispatch at all (SO2), and the malformed-envelope
// log-and-ack policy.
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@otc/contracts';
import { HandleOrderPlacedFactCommand, HandleStockReservedFactCommand } from '../application/commands/saga-fact.commands';
import { ORDERS_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC } from '../infrastructure/outbox/kafka.config';
import { MalformedFactEnvelopeError, parseFactEnvelope, SagaFactsController } from './saga-facts.controller';

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-08-20T10:00:00.000Z',
    payload: {},
    ...overrides,
  };
}

describe('parseFactEnvelope', () => {
  it('accepts an already-parsed object with every required field', () => {
    const value = envelope();
    expect(parseFactEnvelope(value)).toEqual(value);
  });

  it('parses a JSON string', () => {
    const value = envelope();
    expect(parseFactEnvelope(JSON.stringify(value))).toEqual(value);
  });

  it('parses a Buffer', () => {
    const value = envelope();
    expect(parseFactEnvelope(Buffer.from(JSON.stringify(value)))).toEqual(value);
  });

  it('throws MalformedFactEnvelopeError on invalid JSON', () => {
    expect(() => parseFactEnvelope('{not json')).toThrow(MalformedFactEnvelopeError);
  });

  it('throws MalformedFactEnvelopeError when a required field is missing', () => {
    const { eventId: _drop, ...rest } = envelope();
    expect(() => parseFactEnvelope(rest)).toThrow(MalformedFactEnvelopeError);
  });

  it('throws MalformedFactEnvelopeError for a non-object value', () => {
    expect(() => parseFactEnvelope(42)).toThrow(MalformedFactEnvelopeError);
    expect(() => parseFactEnvelope(null)).toThrow(MalformedFactEnvelopeError);
  });
});

describe('SagaFactsController — routing (design.md §3.3)', () => {
  it('routes order.placed.v1 to HandleOrderPlacedFactCommand and awaits commandBus.execute', async () => {
    const execute = vi.fn().mockResolvedValue({ outcome: 'processed', enqueued: 'stock.reserve' });
    const controller = new SagaFactsController({ execute } as never);
    const value = envelope({ eventType: 'order.placed.v1' });

    await controller.onOrdersFact(value);

    expect(execute).toHaveBeenCalledTimes(1);
    const dispatched = execute.mock.calls[0]?.[0];
    expect(dispatched).toBeInstanceOf(HandleOrderPlacedFactCommand);
    expect(dispatched.envelope).toEqual(value);
  });

  it('routes stock.reserved.v1 (from the fulfillment topic) to HandleStockReservedFactCommand', async () => {
    const execute = vi.fn().mockResolvedValue({ outcome: 'processed' });
    const controller = new SagaFactsController({ execute } as never);
    const value = envelope({ eventType: 'stock.reserved.v1' });

    await controller.onFulfillmentFact(value);

    expect(execute.mock.calls[0]?.[0]).toBeInstanceOf(HandleStockReservedFactCommand);
  });

  it('SO2 — a self-produced fact (order.confirmed.v1) is acknowledged with NO CommandBus dispatch at all', async () => {
    const execute = vi.fn();
    const controller = new SagaFactsController({ execute } as never);
    const value = envelope({ eventType: 'order.confirmed.v1' });

    await controller.onOrdersFact(value);

    expect(execute).not.toHaveBeenCalled();
  });

  it('a malformed value is logged and acknowledged — no dispatch, no throw', async () => {
    const execute = vi.fn();
    const logged: Array<Record<string, unknown>> = [];
    const controller = new SagaFactsController({ execute } as never, {
      error: (message, meta) => logged.push({ message, ...meta }),
    });

    await expect(controller.onOrdersFact('{not json')).resolves.toBeUndefined();

    expect(execute).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.topic).toBe(ORDERS_FACTS_TOPIC);
  });

  it('propagates a rejection from commandBus.execute unchanged — the no-commit-redeliver contract (task E3)', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('db down'));
    const controller = new SagaFactsController({ execute } as never);

    await expect(controller.onFulfillmentFact(envelope({ eventType: 'stock.rejected.v1' }))).rejects.toThrow(
      'db down',
    );
    expect(FULFILLMENT_FACTS_TOPIC).toBe('otc.fulfillment.facts.v1');
  });
});
