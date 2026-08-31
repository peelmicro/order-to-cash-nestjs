// Pure unit — R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3): `DegradingNotificationSender`'s
// own "email delivery degraded" log now carries `traceId` (the ACTIVE
// span's real `traceId`, `activeTraceId()`) — the REAL default
// `CONSOLE_LOGGER` output, never the fake `recordingLogger()` injected
// logger `degrading-notification-sender.spec.ts` uses to assert `meta`
// shape only.
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { NotificationMessage, NotificationSender } from '../../application/ports/notification-sender.port';
import { tracer } from '../observability/trace-context';
import { DegradingNotificationSender } from './degrading-notification-sender';

const MESSAGE: NotificationMessage = {
  to: 'retailer01@retailer.order-to-cash.example',
  subject: 'subject',
  text: 'text',
  html: '<p>html</p>',
  correlationId: 'order-1',
};

const QUOTA_EXHAUSTED_ERROR = Object.assign(
  new Error('Invalid login: 535 5.7.0 The email limit is reached. Please upgrade your plan'),
  { code: 'EAUTH', responseCode: 535 },
);

describe('DegradingNotificationSender — degraded-send log carries traceId + correlationId (R58 closeout, design.md §4.4)', () => {
  it("logs the REAL active span's traceId and the message's OWN correlationId — not merely field presence, equal to the real originating ids", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const inner: NotificationSender = { send: vi.fn().mockRejectedValue(QUOTA_EXHAUSTED_ERROR) };
      const fallback: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
      const sender = new DegradingNotificationSender(inner, fallback);

      const originSpan = tracer().startSpan('fact.consume order.placed.v1');
      const { traceId: originTraceId } = originSpan.spanContext();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        await expect(sender.send(MESSAGE)).resolves.toBeUndefined();
      });
      originSpan.end();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.event).toBe('notification.send.degraded');
      expect(logged.correlationId).toBe('order-1');
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it('omits traceId entirely — never the literal string "undefined" — when no span is active', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const inner: NotificationSender = { send: vi.fn().mockRejectedValue(QUOTA_EXHAUSTED_ERROR) };
      const fallback: NotificationSender = { send: vi.fn().mockResolvedValue(undefined) };
      const sender = new DegradingNotificationSender(inner, fallback);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(sender.send(MESSAGE)).resolves.toBeUndefined();

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
