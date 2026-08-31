// Pure unit — R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3): `ProjectorFactsController`'s
// TWO structured log call sites — the PR3 malformed-envelope branch and the
// PR4 unknown-eventType branch — now carry `traceId`/`correlationId` per
// R58's own wording. Exercises the REAL default `CONSOLE_LOGGER` (no
// injected fake logger — `projector-facts.controller.spec.ts`'s own cases
// only ever assert the fake `meta` object), same standard this repo's
// other `*-log-trace-id.spec.ts` files hold.
import { CommandBus } from '@nestjs/cqrs';
import { describe, expect, it, vi } from 'vitest';
import type { KafkaContext } from '@nestjs/microservices';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { UnknownFactTypeError } from '../domain/fact-projection';
import type { DispatchesFactRetries } from '../infrastructure/messaging/fact-retry-dispatcher';
import { tracer } from '../infrastructure/observability/trace-context';
import { orderPlacedEnvelope } from '../test-support/envelope-fixtures';
import { ProjectorFactsController } from './projector-facts.controller';

function passthroughRetryDispatcher(): DispatchesFactRetries {
  return {
    async dispatch(_sourceTopic, envelope, _consumer, process) {
      await process(envelope);
    },
  };
}

describe('ProjectorFactsController — malformed-envelope and unknown-eventType logs carry traceId/correlationId (R58 closeout, design.md §4.4)', () => {
  it('PR3 (malformed envelope) — logs the REAL traceId extracted from the inbound Kafka headers, BEFORE parsing; carries no correlationId (none trustworthy)', async () => {
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

      const commandBus = { execute: vi.fn() } as unknown as CommandBus;
      const controller = new ProjectorFactsController(commandBus, passthroughRetryDispatcher());
      const kafkaContext = { getMessage: () => ({ headers }) } as unknown as KafkaContext;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      // Missing required fields -> malformed, but the Kafka message's OWN
      // headers (independent of the unparseable payload) still carry a
      // real traceparent.
      await expect(controller.onOrdersFact({ eventType: 'order.placed.v1' }, kafkaContext)).resolves.toBeUndefined();

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

  it('PR3 (malformed envelope) — omits traceId entirely, never the literal string "undefined", when the Kafka message carries no headers at all', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const commandBus = { execute: vi.fn() } as unknown as CommandBus;
      const controller = new ProjectorFactsController(commandBus, passthroughRetryDispatcher());
      const kafkaContext = { getMessage: () => ({ headers: undefined }) } as unknown as KafkaContext;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(controller.onOrdersFact({ eventType: 'order.placed.v1' }, kafkaContext)).resolves.toBeUndefined();

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

  it("PR4 (unknown eventType) — logs the REAL active span's traceId and the envelope's OWN correlationId", async () => {
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

      const commandBus = {
        execute: vi.fn(async () => {
          throw new UnknownFactTypeError('bogus.fact.v1');
        }),
      } as unknown as CommandBus;
      const controller = new ProjectorFactsController(commandBus, passthroughRetryDispatcher());
      const kafkaContext = { getMessage: () => ({ headers }) } as unknown as KafkaContext;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const envelope = orderPlacedEnvelope({ eventType: 'stock.teleported.v1' });

      await expect(controller.onFulfillmentFact(envelope, kafkaContext)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toContain('unknown eventType');
      expect(logged.correlationId).toBe(envelope.correlationId);
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
