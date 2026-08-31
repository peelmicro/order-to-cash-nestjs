// Pure unit — R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3): `NotificationFactsController`'s
// malformed-envelope log now carries `traceId`, extracted from the inbound
// Kafka message's headers BEFORE parsing (same widening
// `saga-facts.controller.ts`'s own R58 closeout made). Exercises the REAL
// default `CONSOLE_LOGGER` (no injected fake logger —
// `notification-facts.controller.spec.ts`'s own case only ever asserts the
// fake `meta` object).
import { describe, expect, it, vi } from 'vitest';
import type { CommandBus } from '@nestjs/cqrs';
import type { KafkaContext } from '@nestjs/microservices';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { DispatchesFactRetries } from '../infrastructure/messaging/fact-retry-dispatcher';
import { tracer } from '../infrastructure/observability/trace-context';
import { NotificationFactsController } from './notification-facts.controller';

function passthroughRetryDispatcher(): DispatchesFactRetries {
  return {
    async dispatch(_sourceTopic, envelope, _consumer, process) {
      await process(envelope);
    },
  };
}

function fakeCommandBus(): CommandBus {
  return { execute: vi.fn() } as unknown as CommandBus;
}

describe('NotificationFactsController — malformed-envelope log carries traceId (R58 closeout, design.md §4.4)', () => {
  it('logs the REAL traceId extracted from the inbound Kafka headers, BEFORE parsing; carries no correlationId (none trustworthy)', async () => {
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

      const controller = new NotificationFactsController(fakeCommandBus(), passthroughRetryDispatcher());
      const kafkaContext = { getMessage: () => ({ headers }) } as unknown as KafkaContext;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(controller.onOrdersFact('{not json', kafkaContext)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toContain('malformed fact envelope');
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(Object.prototype.hasOwnProperty.call(logged, 'correlationId')).toBe(false);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it('omits traceId entirely — never the literal string "undefined" — when the Kafka message carries no headers at all', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const controller = new NotificationFactsController(fakeCommandBus(), passthroughRetryDispatcher());
      const kafkaContext = { getMessage: () => ({ headers: undefined }) } as unknown as KafkaContext;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(controller.onOrdersFact('{not json', kafkaContext)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const rawLine = errorSpy.mock.calls[0]![0] as string;
      expect(rawLine).not.toContain('"traceId":"undefined"');
      const logged = JSON.parse(rawLine) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
