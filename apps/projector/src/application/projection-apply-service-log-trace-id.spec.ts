// Pure unit — R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3): `ProjectionApplyService`'s
// own PR19 "update signal publication failed" log now carries `traceId`
// (the ACTIVE span's real `traceId`, `activeTraceId()`) — the REAL default
// `CONSOLE_LOGGER` output, never the fake `{ error: vi.fn() }` logger
// `projection-apply.service.spec.ts` injects to assert `meta` shape only.
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { orderPlacedEnvelope } from '../test-support/envelope-fixtures';
import { tracer } from '../infrastructure/observability/trace-context';
import type { AppliedOrderTimeline, ApplyOutcome, ReadModelWriter } from './ports/read-model-writer.port';
import type { UpdateSignalPublisher } from './ports/update-signal.port';
import { ProjectionApplyService } from './projection-apply.service';

const APPLIED_DOCUMENT: AppliedOrderTimeline = {
  orderId: 'order-1',
  orderReference: 'ORD-000001',
  status: 'placed',
  cancellationReason: null,
  references: { despatchReference: null, invoiceReference: null, paymentReference: null },
  totals: { initialAmount: 2000, initialDiscount: 0, totalAmount: 2000 },
  latestEntry: {
    eventId: 'event-1',
    eventType: 'order.placed.v1',
    occurredAt: '2026-08-24T10:00:00.000Z',
    summary: 'Order ORD-000001 placed for RETAILER01',
    causationId: 'cause-1',
  },
};

function processingWriter(): ReadModelWriter {
  return {
    apply: async (_delta, _eventId, _consumer, afterApplied): Promise<ApplyOutcome> => {
      await afterApplied(APPLIED_DOCUMENT);
      return 'processed';
    },
  };
}

describe('ProjectionApplyService — PR19 signal-publish-failure log carries traceId + correlationId (R58 closeout, design.md §4.4)', () => {
  it("logs the REAL active span's traceId and the envelope's OWN correlationId — not merely field presence, equal to the real originating ids", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const publishError = new Error('NATS unreachable');
      const publisher: UpdateSignalPublisher = {
        publish: vi.fn(async () => {
          throw publishError;
        }),
      };
      const service = new ProjectionApplyService(processingWriter(), publisher);

      const originSpan = tracer().startSpan('fact.consume order.placed.v1');
      const { traceId: originTraceId } = originSpan.spanContext();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const envelope = orderPlacedEnvelope();

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        await expect(service.apply(envelope)).resolves.toBe('processed');
      });
      originSpan.end();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toContain('PR19');
      expect(logged.correlationId).toBe(envelope.correlationId);
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it('omits traceId entirely — never the literal string "undefined" — when no span is active, while still carrying correlationId', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const publishError = new Error('NATS unreachable');
      const publisher: UpdateSignalPublisher = {
        publish: vi.fn(async () => {
          throw publishError;
        }),
      };
      const service = new ProjectionApplyService(processingWriter(), publisher);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const envelope = orderPlacedEnvelope();

      await expect(service.apply(envelope)).resolves.toBe('processed');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const rawLine = errorSpy.mock.calls[0]![0] as string;
      expect(rawLine).not.toContain('"traceId":"undefined"');
      const logged = JSON.parse(rawLine) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);
      expect(logged.correlationId).toBe(envelope.correlationId);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
