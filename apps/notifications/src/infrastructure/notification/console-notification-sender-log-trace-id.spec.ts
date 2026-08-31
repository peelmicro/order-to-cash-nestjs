// B5 closeout (progress/review_final_checkpoint.md) — `ConsoleNotificationSender.send`'s
// structured log line now carries `correlationId` (`message.correlationId`,
// already on the port and populated by
// `NotificationDispatchService.dispatch`) and `traceId` (the ACTIVE span's
// real `traceId`, `activeTraceId()`) — same formula, same shape as every
// other R58 site in this service
// (`degrading-notification-sender-log-trace-id.spec.ts`).
//
// The second test is the one the finding insists on: it does NOT call
// `ConsoleNotificationSender` directly. It drives it through
// `DegradingNotificationSender` — exactly the composition
// `app.module.ts`'s `NOTIFICATION_SENDER` factory builds in production
// (`new DegradingNotificationSender(new SmtpNotificationSender(...), new
// ConsoleNotificationSender())`) — with the inner (SMTP) sender failing
// PERMANENTLY, so the console adapter is reached only via the degradation
// fallback. On that path the console line is the ONLY record a
// notification went out, and this proves it stays traceable there too.
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { NotificationMessage, NotificationSender } from '../../application/ports/notification-sender.port';
import { tracer } from '../observability/trace-context';
import { ConsoleNotificationSender } from './console-notification-sender';
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

describe('ConsoleNotificationSender — "would have sent an email" log carries traceId + correlationId (B5 closeout)', () => {
  it("logs the message's OWN correlationId and the REAL active span's traceId on a direct send", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const sender = new ConsoleNotificationSender();
      const originSpan = tracer().startSpan('fact.consume order.placed.v1');
      const { traceId: originTraceId } = originSpan.spanContext();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        await sender.send(MESSAGE);
      });
      originSpan.end();

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.correlationId).toBe('order-1');
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);

      logSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it('omits correlationId and traceId entirely — never the literal string "undefined" — when neither is available', async () => {
    const sender = new ConsoleNotificationSender();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await sender.send({ to: MESSAGE.to, subject: MESSAGE.subject, text: MESSAGE.text, html: MESSAGE.html });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const rawLine = logSpy.mock.calls[0]![0] as string;
    expect(rawLine).not.toContain('"traceId":"undefined"');
    expect(rawLine).not.toContain('"correlationId":"undefined"');
    const logged = JSON.parse(rawLine) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(logged, 'correlationId')).toBe(false);

    logSpy.mockRestore();
  });

  it('the PRODUCTION degraded path — DegradingNotificationSender falling back to ConsoleNotificationSender after a PERMANENT SMTP failure — still produces a traceable console line', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      // Same composition app.module.ts's NOTIFICATION_SENDER factory
      // builds in production: DegradingNotificationSender(inner=SMTP,
      // fallback=ConsoleNotificationSender). `inner` is a stand-in for
      // SmtpNotificationSender that fails exactly the way a quota
      // exhausted SMTP host does — classifySendFailure(QUOTA_EXHAUSTED_ERROR)
      // === 'permanent', so this exercises the fallback branch, not the
      // rethrow branch.
      const inner: NotificationSender = { send: vi.fn().mockRejectedValue(QUOTA_EXHAUSTED_ERROR) };
      const fallback = new ConsoleNotificationSender();
      const degrading = new DegradingNotificationSender(inner, fallback);

      const originSpan = tracer().startSpan('fact.consume order.placed.v1');
      const { traceId: originTraceId } = originSpan.spanContext();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        await expect(degrading.send(MESSAGE)).resolves.toBeUndefined();
      });
      originSpan.end();

      // The degradation warning fired (degrading-notification-sender's
      // own concern, already guarded elsewhere) AND the fallback's own
      // "would have sent an email" line fired — that second line is what
      // this test is actually about.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(fallback.callCount).toBe(1);
      expect(logSpy).toHaveBeenCalledTimes(1);

      const logged = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toBe('notifications: console adapter — would have sent an email');
      expect(logged.correlationId).toBe('order-1');
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);

      errorSpy.mockRestore();
      logSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
