import { describe, expect, it, vi } from 'vitest';
import type { CommandBus } from '@nestjs/cqrs';
import type { KafkaContext } from '@nestjs/microservices';
import type { Envelope } from '@otc/contracts';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NotifyOrderPlacedCommand } from '../application/commands/notify.commands';
import type { DispatchesFactRetries } from '../infrastructure/messaging/fact-retry-dispatcher';
import { extractKafkaTraceContext, tracer } from '../infrastructure/observability/trace-context';
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

/** A pass-through `DispatchesFactRetries` fake — calls `process` exactly once, no retry, no DLQ. Every case in this file is about `route`'s OWN branching (envelope parsing, notifyCommandFor's membership test), not OR1's retry/backoff policy — that policy is proven separately by fact-retry-dispatcher.spec.ts (byte-identical to the canonical, OI12). */
function passthroughRetryDispatcher(): DispatchesFactRetries {
  return {
    async dispatch(
      _sourceTopic: string,
      envelope: Envelope,
      _consumer: string,
      process: (envelope: Envelope) => Promise<void>,
    ): Promise<void> {
      await process(envelope);
    },
  };
}

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

// A5 (observability_reliability, R57/OR4): `route` now extracts a trace
// context from the inbound Kafka message's headers and starts a manual
// span around the dispatch call — a no-headers fake `KafkaContext` is
// enough for every case in this file, which is about routing, not trace
// propagation.
function fakeKafkaContext(): KafkaContext {
  return { getMessage: () => ({ headers: undefined }) } as unknown as KafkaContext;
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
    const controller = new NotificationFactsController(commandBus, passthroughRetryDispatcher());

    await controller.onOrdersFact(VALID_ORDER_PLACED_ENVELOPE, fakeKafkaContext());

    expect(execute).toHaveBeenCalledTimes(1);
    const [command] = execute.mock.calls[0]!;
    expect(command).toBeInstanceOf(NotifyOrderPlacedCommand);
    expect((command as NotifyOrderPlacedCommand).envelope).toEqual(VALID_ORDER_PLACED_ENVELOPE);
  });

  it('does NOT dispatch a Command for a fact this service does not notify on (e.g. stock.reserved.v1)', async () => {
    const { commandBus, execute } = fakeCommandBus();
    const controller = new NotificationFactsController(commandBus, passthroughRetryDispatcher());

    await controller.onFulfillmentFact({ ...VALID_ORDER_PLACED_ENVELOPE, eventType: 'stock.reserved.v1' }, fakeKafkaContext());

    expect(execute).not.toHaveBeenCalled();
  });

  it('logs and acknowledges (no throw, no dispatch) on a malformed envelope, instead of looping on redelivery', async () => {
    const { commandBus, execute } = fakeCommandBus();
    const errorLog = vi.fn();
    const logger: NotificationFactsControllerLogger = { error: errorLog };
    const controller = new NotificationFactsController(commandBus, passthroughRetryDispatcher(), logger);

    await expect(controller.onBillingFact('{not json', fakeKafkaContext())).resolves.toBeUndefined();

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

  it('A4b — a notified fact\'s CommandBus dispatch genuinely goes THROUGH the injected FactRetryDispatcher, not around it', async () => {
    const { commandBus, execute } = fakeCommandBus();
    const dispatchCalls: Array<{ sourceTopic: string; envelope: Envelope; consumer: string }> = [];
    const retryDispatcher: DispatchesFactRetries = {
      async dispatch(sourceTopic, envelope, consumer, process) {
        dispatchCalls.push({ sourceTopic, envelope, consumer });
        await process(envelope);
      },
    };
    const controller = new NotificationFactsController(commandBus, retryDispatcher);

    await controller.onOrdersFact(VALID_ORDER_PLACED_ENVELOPE, fakeKafkaContext());

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.sourceTopic).toBe(ORDERS_FACTS_TOPIC);
    expect(dispatchCalls[0]!.consumer).toBe('notifications');
    expect(dispatchCalls[0]!.envelope).toEqual(VALID_ORDER_PLACED_ENVELOPE);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('A4b — a processing failure from the CommandBus reaches the retry dispatcher rather than propagating raw out of route', async () => {
    const failingCommandBus = { execute: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as CommandBus;
    let caughtByDispatcher: unknown;
    const retryDispatcher: DispatchesFactRetries = {
      async dispatch(_sourceTopic, envelope, _consumer, process) {
        try {
          await process(envelope);
        } catch (error) {
          caughtByDispatcher = error;
          // deliberately swallowed here too — mirrors FactRetryDispatcher's
          // own "never rethrows" contract, so this fake proves the SAME
          // shape `onOrdersFact` must resolve normally against.
        }
      },
    };
    const controller = new NotificationFactsController(failingCommandBus, retryDispatcher);

    await expect(controller.onOrdersFact(VALID_ORDER_PLACED_ENVELOPE, fakeKafkaContext())).resolves.toBeUndefined();

    expect((caughtByDispatcher as Error)?.message).toBe('boom');
  });

  it('A5 (OR4, R57) — extracts the inbound Kafka header\'s trace context and CONTINUES it (same real traceId) inside CommandBus.execute, rather than starting fresh', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const upstreamSpan = tracer().startSpan('test-outbox-publish-span');
      const { traceId: originTraceId } = upstreamSpan.spanContext();
      const headers: Record<string, string> = {};
      context.with(trace.setSpan(context.active(), upstreamSpan), () => {
        propagation.inject(context.active(), headers);
      });
      upstreamSpan.end();

      let observedTraceId: string | undefined;
      const commandBus = { execute: vi.fn(async () => {
        observedTraceId = trace.getActiveSpan()?.spanContext().traceId;
      }) } as unknown as CommandBus;
      const controller = new NotificationFactsController(commandBus, passthroughRetryDispatcher());
      const kafkaContext = { getMessage: () => ({ headers }) } as unknown as KafkaContext;

      await controller.onOrdersFact(VALID_ORDER_PLACED_ENVELOPE, kafkaContext);

      expect(observedTraceId).toBeDefined();
      expect(observedTraceId).toBe(originTraceId);
      expect(observedTraceId).toMatch(/^[0-9a-f]{32}$/);

      const reExtracted = extractKafkaTraceContext(headers);
      expect(trace.getSpanContext(reExtracted)?.traceId).toBe(originTraceId);
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
