// Pure unit — a fake `KafkaClientLike`/`KafkaProducerLike` capturing the
// exact record `send(...)` receives. Proves OR4/R57's DLQ-side claim: the
// headers a dead-lettered fact publishes carry the SAME real traceId as
// whatever context was active when `publish(...)` was called — read back
// through the real propagator, not a bare string-presence check.
import { describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import { extractKafkaTraceContext } from '../observability/trace-context';
import type { KafkaClientLike, KafkaSendRecord } from '../outbox/kafka-fact-publisher';
import { KafkaDlqPublisher } from './kafka-dlq-publisher';

function envelope(): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-08-26T10:00:00.000Z',
    payload: {},
  };
}

function fakeClient(): { client: KafkaClientLike; sent: KafkaSendRecord[] } {
  const sent: KafkaSendRecord[] = [];
  const client: KafkaClientLike = {
    producer: () => ({
      connect: async () => {},
      disconnect: async () => {},
      send: async (record) => {
        sent.push(record);
      },
    }),
  };
  return { client, sent };
}

describe('KafkaDlqPublisher.publish — trace propagation (OR4, R57)', () => {
  it('injects the caller\'s active real traceId into the DLQ message headers, extractable back to the SAME traceId', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const { client, sent } = fakeClient();
      const publisher = new KafkaDlqPublisher(client);
      const span = provider.getTracer('test').startSpan('test-consume-span');
      const { traceId } = span.spanContext();

      await context.with(trace.setSpan(context.active(), span), () =>
        publisher.publish('otc.orders.facts.v1', envelope(), {
          failedConsumer: 'orders.saga',
          attempts: 3,
          error: new Error('boom'),
          firstFailedAt: new Date('2026-08-26T10:00:00.000Z'),
          failedAt: new Date('2026-08-26T10:00:01.000Z'),
        }),
      );
      span.end();

      expect(sent).toHaveLength(1);
      const [record] = sent;
      const message = record!.messages[0]!;
      const extracted = extractKafkaTraceContext(message.headers as never);
      const extractedSpanContext = trace.getSpanContext(extracted);

      expect(extractedSpanContext).toBeDefined();
      expect(extractedSpanContext!.traceId).toBe(traceId);
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it('with no active span/context, publishes with no traceparent header at all (no spurious trace fabricated)', async () => {
    const { client, sent } = fakeClient();
    const publisher = new KafkaDlqPublisher(client);

    await publisher.publish('otc.orders.facts.v1', envelope(), {
      failedConsumer: 'orders.saga',
      attempts: 3,
      error: new Error('boom'),
      firstFailedAt: new Date('2026-08-26T10:00:00.000Z'),
      failedAt: new Date('2026-08-26T10:00:01.000Z'),
    });

    const message = sent[0]!.messages[0]!;
    expect(message.headers.traceparent).toBeUndefined();
  });
});
