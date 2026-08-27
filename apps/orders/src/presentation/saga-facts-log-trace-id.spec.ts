// Pure unit — A6a (R58, design.md §4.4): `SagaFactsController`'s own
// structured error log (the malformed-envelope, log-and-ack branch, the
// ONE call site this controller ever logs through) gains `traceId`
// alongside `message`/`meta`, sourced from the ACTIVE span
// (`trace.getActiveSpan()?.spanContext().traceId`, `trace-context.ts`'s
// `activeTraceId()`). Two things this file proves, neither of which
// `saga-facts.controller.spec.ts`'s existing malformed-envelope case does
// (it injects a FAKE logger, bypassing the real `CONSOLE_LOGGER` entirely):
//
//   1. a REAL traceId, extracted from the inbound Kafka message's OWN
//      headers — even though this branch runs BEFORE `parseFactEnvelope`
//      succeeds, `route` now extracts-and-continues the trace context
//      FIRST (A6a widened this), so a malformed value that still carried
//      a real `traceparent` (every fact this service's own outbox relay
//      publishes does) logs its real originating traceId, not nothing;
//   2. the "no active span" case behaves sanely — no `traceId` key at
//      all, and never the literal string `"undefined"` serialised into
//      the JSON line — proven against the REAL `console.error` output,
//      not a fake logger's `meta` object.
import { describe, expect, it, vi } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { tracer } from '../infrastructure/observability/trace-context';
import { SagaFactsController } from './saga-facts.controller';
import { ORDERS_FACTS_TOPIC } from '../infrastructure/outbox/kafka.config';

function fakeKafkaContext(headers: Record<string, string> | undefined) {
  return { getMessage: () => ({ headers }) } as never;
}

const passthroughDispatcher = { dispatch: (_topic: string, env: unknown, _consumer: string, process: (e: unknown) => Promise<void>) => process(env) } as never;

describe('SagaFactsController — malformed-envelope log carries traceId (A6a, R58, design.md §4.4)', () => {
  it('logs the REAL traceId extracted from the inbound Kafka message headers, even though the value never parsed as an envelope', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const upstreamSpan = tracer().startSpan('outbox.publish order.placed.v1');
      const { traceId: originTraceId } = upstreamSpan.spanContext();
      const headers: Record<string, string> = {};
      context.with(trace.setSpan(context.active(), upstreamSpan), () => {
        propagation.inject(context.active(), headers);
      });
      upstreamSpan.end();
      expect(headers.traceparent).toBeDefined();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const controller = new SagaFactsController({ execute: vi.fn() } as never, passthroughDispatcher);

      await controller.onOrdersFact('{not valid json', fakeKafkaContext(headers));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.topic).toBe(ORDERS_FACTS_TOPIC);
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it('omits traceId entirely — never the literal string "undefined" — when the message carries no traceparent header at all', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const controller = new SagaFactsController({ execute: vi.fn() } as never, passthroughDispatcher);

      await controller.onOrdersFact('{not valid json', fakeKafkaContext(undefined));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const rawLine = errorSpy.mock.calls[0]![0] as string;
      expect(rawLine).not.toContain('undefined');
      const logged = JSON.parse(rawLine) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
