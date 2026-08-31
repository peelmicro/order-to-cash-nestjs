// Pure unit — R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3): `NotificationDispatchService`'s
// own N13 "compensating delete failed" log now carries `traceId` (the
// ACTIVE span's real `traceId`, `activeTraceId()`) — the REAL default
// `CONSOLE_LOGGER` output, never the fake `{ error: vi.fn() }` logger
// `notification-dispatch.service.spec.ts` injects to assert `meta` shape
// only.
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Envelope } from '@otc/contracts';
import type { NotificationMessage, NotificationSender } from './ports/notification-sender.port';
import { tracer } from '../infrastructure/observability/trace-context';
import {
  NotificationDispatchService,
  type ConsumptionOutcome,
  type DeletesProcessedEvent,
  type RunsIdempotently,
} from './notification-dispatch.service';

const ENVELOPE: Envelope = {
  eventId: 'event-1',
  eventType: 'order.placed.v1',
  aggregateId: 'aggregate-1',
  correlationId: 'order-1',
  causationId: 'cause-1',
  occurredAt: '2026-08-24T10:00:00.000Z',
  payload: {},
};

const MESSAGE: NotificationMessage = { to: 'to@example.com', subject: 'subject', text: 'text', html: '<p>html</p>' };

function realIdempotency(): RunsIdempotently {
  return {
    async runOnce(_eventId, _consumer, work): Promise<ConsumptionOutcome> {
      await work({} as never);
      return 'processed';
    },
  };
}

function failingCompensation(compensationError: Error): DeletesProcessedEvent {
  return {
    async delete(): Promise<void> {
      throw compensationError;
    },
  };
}

describe('NotificationDispatchService — N13 compensation-failure log carries traceId + correlationId (R58 closeout, design.md §4.4)', () => {
  it("logs the REAL active span's traceId and the envelope's OWN correlationId — not merely field presence, equal to the real originating ids", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const sendError = new Error('SMTP timeout');
      const compensationError = new Error('MySQL connection reset');
      const sender: NotificationSender = { send: vi.fn().mockRejectedValue(sendError) };
      const service = new NotificationDispatchService(
        realIdempotency(),
        sender,
        failingCompensation(compensationError),
      );

      const originSpan = tracer().startSpan('fact.consume order.placed.v1');
      const { traceId: originTraceId } = originSpan.spanContext();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        await expect(service.dispatch(ENVELOPE, () => MESSAGE)).rejects.toBe(sendError);
      });
      originSpan.end();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toContain('compensating delete failed');
      expect(logged.correlationId).toBe(ENVELOPE.correlationId);
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
      const sendError = new Error('SMTP timeout');
      const compensationError = new Error('MySQL connection reset');
      const sender: NotificationSender = { send: vi.fn().mockRejectedValue(sendError) };
      const service = new NotificationDispatchService(
        realIdempotency(),
        sender,
        failingCompensation(compensationError),
      );

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(service.dispatch(ENVELOPE, () => MESSAGE)).rejects.toBe(sendError);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const rawLine = errorSpy.mock.calls[0]![0] as string;
      expect(rawLine).not.toContain('"traceId":"undefined"');
      const logged = JSON.parse(rawLine) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);
      expect(logged.correlationId).toBe(ENVELOPE.correlationId);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
