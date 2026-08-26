// Pure unit — the brief's own binding proof: "for the retry stays on the
// same trace, prove it with the actual traceId captured at each retry
// attempt, all equal — not merely no error was thrown" and "proof that a
// retried fact's DLQ publish stays on the originating trace" (OR4, R57,
// design.md §4.3). Uses the REAL `FactRetryDispatcher` (a fake
// Clock/DelayPort so retries are instant, exactly the existing
// `fact-retry-dispatcher.spec.ts` convention) driven through the REAL
// `SagaFactsController.route`, so the span/context wiring under test is
// the production wiring, not a re-implementation of it.
import { describe, expect, it } from 'vitest';
import { UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Clock } from '../application/ports/clock.port';
import { FactRetryDispatcher, type DelayPort, type DlqPublishMeta, type DlqPublisher } from '../infrastructure/messaging/fact-retry-dispatcher';
import { extractKafkaTraceContext, tracer } from '../infrastructure/observability/trace-context';
import { SagaFactsController } from './saga-facts.controller';

function fixedClock(): Clock {
  return { now: () => new Date('2026-08-26T10:00:00.000Z') };
}

function instantDelay(): DelayPort {
  return { async for() {} };
}

function fakeKafkaEnvelopeHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  // Simulates what the outbox relay's own manual "publish" span injected
  // into the Kafka message the controller receives (`outbox-relay.ts`).
  return { 'x-event-type': 'order.placed.v1', 'content-type': 'application/json', ...overrides };
}

function fakeKafkaContext(headers: Record<string, string>) {
  return { getMessage: () => ({ headers }) } as never;
}

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

describe('SagaFactsController.route — trace continuity across retries and the DLQ publish (OR4, R57)', () => {
  it('every in-line retry attempt AND the eventual DLQ publish observe the SAME real traceId as the fact that triggered them, extracted from the inbound Kafka header — not a fresh one', async () => {
    // A real TracerProvider, registered for this test only — never
    // sdk-node's own OTLP exporter (design.md §8).
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      // The trace the (simulated) upstream outbox-relay publish span
      // started — its traceId is what every downstream observation below
      // must match.
      const upstreamSpan = tracer().startSpan('outbox.publish order.placed.v1');
      const { traceId: originTraceId } = upstreamSpan.spanContext();
      const headers: Record<string, string> = {};
      context.with(trace.setSpan(context.active(), upstreamSpan), () => {
        propagation.inject(context.active(), headers);
      });
      upstreamSpan.end();
      expect(headers.traceparent).toBeDefined();

      const kafkaHeaders = fakeKafkaEnvelopeHeaders(headers);

      // A CommandBus that ALWAYS throws — forces the dispatcher to
      // exhaust every attempt and dead-letter, which is exactly the
      // scenario the brief asks to be proven, not just the happy path.
      const observedTraceIdsPerAttempt: string[] = [];
      const commandBus = {
        execute: async () => {
          const span = trace.getActiveSpan();
          observedTraceIdsPerAttempt.push(span?.spanContext().traceId ?? 'NO-ACTIVE-SPAN');
          throw new Error('processing always fails, forcing exhaustion');
        },
      };

      const dlqCalls: Array<{ sourceTopic: string; envelope: Envelope; meta: DlqPublishMeta; headers: Record<string, string> }> = [];
      const dlq: DlqPublisher = {
        async publish(sourceTopic, env, meta) {
          // Mirrors what KafkaDlqPublisher.publish actually does (OR1/
          // OR4): builds a plain headers object and injects the THEN-
          // active context into it (kafka-dlq-publisher.ts's own
          // `injectIntoStringHeaders(headers)` call).
          const dlqHeaders: Record<string, string> = {};
          propagation.inject(context.active(), dlqHeaders);
          dlqCalls.push({ sourceTopic, envelope: env, meta, headers: dlqHeaders });
        },
      };

      const retryDispatcher = new FactRetryDispatcher(fixedClock(), instantDelay(), dlq, { maxAttempts: 3, backoffBaseMs: 0 });

      const controller = new SagaFactsController(commandBus as never, retryDispatcher);
      const fact = envelope();

      await controller.onOrdersFact(fact, fakeKafkaContext(kafkaHeaders));

      // Every one of the 3 attempts saw the SAME real, non-degenerate
      // traceId — the actual property under test, not "no error thrown".
      expect(observedTraceIdsPerAttempt).toHaveLength(3);
      expect(new Set(observedTraceIdsPerAttempt).size).toBe(1);
      expect(observedTraceIdsPerAttempt[0]).toBe(originTraceId);
      expect(observedTraceIdsPerAttempt[0]).toMatch(/^[0-9a-f]{32}$/);

      // The DLQ publish itself: its injected headers extract back to the
      // SAME originating traceId — the "any eventual DLQ publish stays on
      // the same trace" proof.
      expect(dlqCalls).toHaveLength(1);
      const dlqExtractedContext = extractKafkaTraceContext(dlqCalls[0]!.headers);
      const dlqSpanContext = trace.getSpanContext(dlqExtractedContext);
      expect(dlqSpanContext).toBeDefined();
      expect(dlqSpanContext!.traceId).toBe(originTraceId);

      // The consume span itself (`saga.consume order.placed.v1`) is
      // exported as a real, ended span with the SAME traceId, parented on
      // the upstream publish span.
      const finished = exporter.getFinishedSpans();
      const consumeSpan = finished.find((s) => s.name === 'saga.consume order.placed.v1');
      expect(consumeSpan).toBeDefined();
      expect(consumeSpan!.spanContext().traceId).toBe(originTraceId);
      expect(consumeSpan!.parentSpanContext?.spanId).toBe(upstreamSpan.spanContext().spanId);
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
