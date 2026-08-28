// Pure unit — R58 closeout (design.md §4.4): `SagaCommandSweeperService`'s
// per-row diagnostic log (`'saga-command-sweeper: dispatch of a claimed
// row threw'`) now carries `traceId` (the ACTIVE span's real `traceId`)
// and `correlationId` (the row's own order id, already logged as
// `orderId`). REAL timers, not fake ones — `@sinonjs/fake-timers` (this
// repo's `vi.useFakeTimers()`) stores and directly invokes callbacks
// rather than scheduling a genuine libuv timer, which does NOT preserve
// `AsyncLocalStorage` continuation the way a real `setTimeout` does; a
// real, short delay is used instead so the active span genuinely survives
// into `runCycle`'s per-row catch block.
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port';
import type { SagaCommandRecord, SagaCommandStore } from '../../application/ports/saga-command-store.port';
import type { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import type { DispatchesSagaCommands } from './saga-command-dispatcher';
import { tracer } from '../observability/trace-context';
import { SagaCommandSweeperService, type SagaCommandSweeperConfig } from './saga-command-sweeper.service';

function fakeUnitOfWork(): UnitOfWork {
  return {
    async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return work({} as TransactionContext);
    },
  };
}

function row(overrides: Partial<SagaCommandRecord> = {}): SagaCommandRecord {
  return {
    id: UniqueId.generate(),
    orderId: UniqueId.generate(),
    orderReference: OrderNumber.fromSequence(1),
    command: 'stock.reserve',
    payload: {
      orderReference: 'ORD-000001',
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      lines: [{ productCode: 'PRD-0001', units: 1 }],
    },
    triggeringEventId: UniqueId.generate(),
    triggeringEventEnvelope: {
      eventId: UniqueId.generate().value,
      eventType: 'order.placed.v1',
      aggregateId: UniqueId.generate().value,
      correlationId: UniqueId.generate().value,
      causationId: UniqueId.generate().value,
      occurredAt: '2026-08-20T09:00:00.000Z',
      payload: {},
    } as unknown as Envelope,
    triggeringEventTopic: 'otc.orders.facts.v1',
    status: 'pending',
    attempts: 0,
    deadLetteredAt: null,
    ...overrides,
  };
}

function config(overrides: Partial<SagaCommandSweeperConfig> = {}): SagaCommandSweeperConfig {
  return { enabled: true, intervalMs: 60_000, pendingGraceMs: 10_000, batchLimit: 100, ...overrides };
}

const fixedClock: Clock = { now: () => new Date('2026-08-20T10:00:00.000Z') };

function waitForCall(spy: ReturnType<typeof vi.spyOn>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (spy.mock.calls.length > 0) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitForCall: condition not met within timeout'));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe('SagaCommandSweeperService — per-row log carries traceId + correlationId (R58 closeout, design.md §4.4)', () => {
  it('logs the REAL active span\'s traceId and the row\'s order id as correlationId when a claimed row\'s dispatch throws', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const claimed = [row({ command: 'stock.reserve' })];
      const store: SagaCommandStore = {
        async enqueue() {
          return 'enqueued' as const;
        },
        async findByOrderAndCommand() {
          return null;
        },
        claimDue: vi.fn().mockResolvedValue(claimed),
        async markSent() {
          return true;
        },
        async park() {
          return true;
        },
        async markRejected() {
          return true;
        },
        async claimDeadLetter() {
          return true;
        },
      };
      const dispatcher: DispatchesSagaCommands = { dispatch: vi.fn().mockRejectedValue(new Error('boom')) };
      const service = new SagaCommandSweeperService(fakeUnitOfWork(), store, dispatcher, fixedClock, config());

      const originSpan = tracer().startSpan('saga.sweeper.cycle');
      const { traceId: originTraceId } = originSpan.spanContext();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      context.with(trace.setSpan(context.active(), originSpan), () => {
        service.onApplicationBootstrap();
      });

      await waitForCall(errorSpy);
      originSpan.end();
      await service.onApplicationShutdown();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toBe('saga-command-sweeper: dispatch of a claimed row threw');
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(logged.correlationId).toBe(claimed[0]!.orderId.value);

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
      const claimed = [row({ command: 'stock.reserve' })];
      const store: SagaCommandStore = {
        async enqueue() {
          return 'enqueued' as const;
        },
        async findByOrderAndCommand() {
          return null;
        },
        claimDue: vi.fn().mockResolvedValue(claimed),
        async markSent() {
          return true;
        },
        async park() {
          return true;
        },
        async markRejected() {
          return true;
        },
        async claimDeadLetter() {
          return true;
        },
      };
      const dispatcher: DispatchesSagaCommands = { dispatch: vi.fn().mockRejectedValue(new Error('boom')) };
      const service = new SagaCommandSweeperService(fakeUnitOfWork(), store, dispatcher, fixedClock, config());

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      service.onApplicationBootstrap();

      await waitForCall(errorSpy);
      await service.onApplicationShutdown();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const rawLine = errorSpy.mock.calls[0]![0] as string;
      expect(rawLine).not.toContain('"traceId":"undefined"');
      const logged = JSON.parse(rawLine) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);
      expect(logged.correlationId).toBe(claimed[0]!.orderId.value);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
