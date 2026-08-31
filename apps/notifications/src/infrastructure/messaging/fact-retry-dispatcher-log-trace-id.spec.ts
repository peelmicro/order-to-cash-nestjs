// Pure unit — R58 closeout (design.md §4.4, Phase 25 traceability audit
// `progress/review_traceability_audit.md` §3): `FactRetryDispatcher`'s own
// dead-letter log line (`'fact-retry-dispatcher: exhausted attempts, fact
// dead-lettered'`) now carries `traceId` (the ACTIVE span's real
// `traceId`, `activeTraceId()`) and `correlationId` (the envelope's own,
// always present) — the same closeout `apps/orders`'s own
// `fact-retry-dispatcher-log-trace-id.spec.ts` already proves for the
// canonical file. Exercises the REAL default `CONSOLE_LOGGER` (no injected
// fake logger), same standard this repo's other `*-log-trace-id.spec.ts`
// files hold.
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port';
import { tracer } from '../observability/trace-context';
import { FactRetryDispatcher, type DlqPublisher } from './fact-retry-dispatcher';

function fixedClock(): Clock {
  return { now: () => new Date('2026-08-31T09:00:00.000Z') };
}

const noopDelay = { for: async () => undefined };
const noopDlq: DlqPublisher = { publish: async () => undefined };

function envelope(): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: new Date('2026-08-31T09:00:00.000Z'),
    payload: {},
  } as unknown as Envelope;
}

describe('FactRetryDispatcher (notifications) — dead-letter log carries traceId + correlationId (R58 closeout, design.md §4.4)', () => {
  it("logs the REAL active span's traceId and the fact's OWN correlationId — not merely field presence, equal to the real originating ids", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const env = envelope();
      const originSpan = tracer().startSpan('fact.consume order.placed.v1');
      const { traceId: originTraceId } = originSpan.spanContext();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const dispatcher = new FactRetryDispatcher(fixedClock(), noopDelay, noopDlq, {
        maxAttempts: 1,
        backoffBaseMs: 0,
      });

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        await dispatcher.dispatch('otc.orders.facts.v1', env, 'notifications', async () => {
          throw new Error('boom');
        });
      });
      originSpan.end();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toBe('fact-retry-dispatcher: exhausted attempts, fact dead-lettered');
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(logged.correlationId).toBe(env.correlationId);

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
      const env = envelope();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const dispatcher = new FactRetryDispatcher(fixedClock(), noopDelay, noopDlq, {
        maxAttempts: 1,
        backoffBaseMs: 0,
      });

      await dispatcher.dispatch('otc.orders.facts.v1', env, 'notifications', async () => {
        throw new Error('boom');
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const rawLine = errorSpy.mock.calls[0]![0] as string;
      expect(rawLine).not.toContain('"traceId":"undefined"');
      const logged = JSON.parse(rawLine) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);
      expect(logged.correlationId).toBe(env.correlationId);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
