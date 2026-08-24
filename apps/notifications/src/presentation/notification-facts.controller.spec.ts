import { describe, expect, it, vi } from 'vitest';
import type { CommandBus } from '@nestjs/cqrs';
import { NotifyOrderPlacedCommand } from '../application/commands/notify.commands';
import {
  ORDERS_FACTS_TOPIC,
  FULFILLMENT_FACTS_TOPIC,
  BILLING_FACTS_TOPIC,
} from '../infrastructure/messaging/kafka.config';
import {
  MalformedFactEnvelopeError,
  NotificationFactsController,
  parseFactEnvelope,
  type NotificationFactsControllerLogger,
} from './notification-facts.controller';

const VALID_ORDER_PLACED_ENVELOPE = {
  eventId: 'event-1',
  eventType: 'order.placed.v1',
  aggregateId: 'aggregate-1',
  correlationId: 'order-1',
  causationId: 'cause-1',
  occurredAt: '2026-08-24T10:00:00.000Z',
  payload: { orderReference: 'ORD-000001' },
};

function fakeCommandBus(): { commandBus: CommandBus; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn().mockResolvedValue(undefined);
  return { commandBus: { execute } as unknown as CommandBus, execute };
}

describe('parseFactEnvelope', () => {
  it('accepts an already-parsed object with every required field', () => {
    expect(parseFactEnvelope(VALID_ORDER_PLACED_ENVELOPE)).toEqual(VALID_ORDER_PLACED_ENVELOPE);
  });

  it('accepts a JSON string and parses it', () => {
    expect(parseFactEnvelope(JSON.stringify(VALID_ORDER_PLACED_ENVELOPE))).toEqual(VALID_ORDER_PLACED_ENVELOPE);
  });

  it('accepts a Buffer of JSON and parses it', () => {
    expect(parseFactEnvelope(Buffer.from(JSON.stringify(VALID_ORDER_PLACED_ENVELOPE)))).toEqual(
      VALID_ORDER_PLACED_ENVELOPE,
    );
  });

  it('throws MalformedFactEnvelopeError on invalid JSON', () => {
    expect(() => parseFactEnvelope('{not json')).toThrow(MalformedFactEnvelopeError);
  });

  it('throws MalformedFactEnvelopeError when a required field is missing', () => {
    const { eventId, ...rest } = VALID_ORDER_PLACED_ENVELOPE;
    void eventId;
    expect(() => parseFactEnvelope(rest)).toThrow(MalformedFactEnvelopeError);
  });

  it('throws MalformedFactEnvelopeError for a non-object value', () => {
    expect(() => parseFactEnvelope(42)).toThrow(MalformedFactEnvelopeError);
  });
});

describe('NotificationFactsController', () => {
  it('dispatches a Command for one of the seven notified facts, on each of the three topics', async () => {
    const { commandBus, execute } = fakeCommandBus();
    const controller = new NotificationFactsController(commandBus);

    await controller.onOrdersFact(VALID_ORDER_PLACED_ENVELOPE);

    expect(execute).toHaveBeenCalledTimes(1);
    const [command] = execute.mock.calls[0]!;
    expect(command).toBeInstanceOf(NotifyOrderPlacedCommand);
    expect((command as NotifyOrderPlacedCommand).envelope).toEqual(VALID_ORDER_PLACED_ENVELOPE);
  });

  it('does NOT dispatch a Command for a fact this service does not notify on (e.g. stock.reserved.v1)', async () => {
    const { commandBus, execute } = fakeCommandBus();
    const controller = new NotificationFactsController(commandBus);

    await controller.onFulfillmentFact({ ...VALID_ORDER_PLACED_ENVELOPE, eventType: 'stock.reserved.v1' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('logs and acknowledges (no throw, no dispatch) on a malformed envelope, instead of looping on redelivery', async () => {
    const { commandBus, execute } = fakeCommandBus();
    const errorLog = vi.fn();
    const logger: NotificationFactsControllerLogger = { error: errorLog };
    const controller = new NotificationFactsController(commandBus, logger);

    await expect(controller.onBillingFact('{not json')).resolves.toBeUndefined();

    expect(execute).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [, meta] = errorLog.mock.calls[0]!;
    expect(meta.topic).toBe(BILLING_FACTS_TOPIC);
  });

  it('routes each handler to the topic constant it names', () => {
    expect(ORDERS_FACTS_TOPIC).toBe('otc.orders.facts.v1');
    expect(FULFILLMENT_FACTS_TOPIC).toBe('otc.fulfillment.facts.v1');
    expect(BILLING_FACTS_TOPIC).toBe('otc.billing.facts.v1');
  });
});
