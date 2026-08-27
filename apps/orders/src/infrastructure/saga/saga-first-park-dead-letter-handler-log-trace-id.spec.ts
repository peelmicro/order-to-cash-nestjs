// Pure unit — R58 closeout (design.md §4.4): `SagaFirstParkDeadLetterHandler`'s
// SO8-style residue log (`'saga-first-park-dead-letter-handler: no order
// row for orderId, fact not recorded'`) now carries `traceId` (the ACTIVE
// span's real `traceId`) and `correlationId` (the row's own order id,
// already logged as `orderId`). No prior unit spec existed for this class
// (its behaviour is otherwise proven end to end by
// `saga-command-dead-letter.integration.spec.ts`) — this file proves the
// ONE call site in isolation, against the REAL default `CONSOLE_LOGGER`.
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { Clock } from '../../application/ports/clock.port';
import type { OrderRepository } from '../../application/ports/order-repository.port';
import type { SagaCommandRecord } from '../../application/ports/saga-command-store.port';
import type { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import type { DlqPublisher } from '../messaging/fact-retry-dispatcher';
import { tracer } from '../observability/trace-context';
import { SagaFirstParkDeadLetterHandler } from './saga-first-park-dead-letter-handler';

const fixedClock: Clock = { now: () => new Date('2026-08-26T09:00:00.000Z') };
const noopDlq: DlqPublisher = { publish: async () => undefined };

function fakeUnitOfWork(): UnitOfWork {
  return {
    async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return work({} as TransactionContext);
    },
  };
}

function orderRepositoryFindingNothing(): OrderRepository {
  return {
    async findById() {
      return null;
    },
    async findByReference() {
      return null;
    },
    async findByRequestId() {
      return null;
    },
    async save() {
      /* not reached — findById already returned null */
    },
  };
}

function parkedRow(overrides: Partial<SagaCommandRecord> = {}): SagaCommandRecord {
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
      occurredAt: '2026-08-26T09:00:00.000Z',
      payload: {},
    } as unknown as Envelope,
    triggeringEventTopic: 'otc.orders.facts.v1',
    status: 'parked',
    attempts: 3,
    deadLetteredAt: null,
    ...overrides,
  };
}

describe(
  'SagaFirstParkDeadLetterHandler — "no order row" residue log carries traceId + correlationId (R58 closeout, design.md §4.4)',
  () => {
    it("logs the REAL active span's traceId and the row's order id as correlationId when the order does not exist", async () => {
      const exporter = new InMemorySpanExporter();
      const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      const contextManager = new AsyncLocalStorageContextManager();
      provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

      try {
        const row = parkedRow();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const handler = new SagaFirstParkDeadLetterHandler(noopDlq, fakeUnitOfWork(), orderRepositoryFindingNothing(), fixedClock);

        const originSpan = tracer().startSpan('saga.park.onFirstPark');
        const { traceId: originTraceId } = originSpan.spanContext();

        await context.with(trace.setSpan(context.active(), originSpan), async () => {
          await handler.onFirstPark(row, { attempts: 3, lastError: 'no responders' });
        });
        originSpan.end();

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
        expect(logged.message).toBe('saga-first-park-dead-letter-handler: no order row for orderId, fact not recorded');
        expect(logged.traceId).toBe(originTraceId);
        expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(logged.correlationId).toBe(row.orderId.value);

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
        const row = parkedRow();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const handler = new SagaFirstParkDeadLetterHandler(noopDlq, fakeUnitOfWork(), orderRepositoryFindingNothing(), fixedClock);

        await handler.onFirstPark(row, { attempts: 3, lastError: 'no responders' });

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const rawLine = errorSpy.mock.calls[0]![0] as string;
        expect(rawLine).not.toContain('"traceId":"undefined"');
        const logged = JSON.parse(rawLine) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(logged, 'traceId')).toBe(false);
        expect(logged.correlationId).toBe(row.orderId.value);

        errorSpy.mockRestore();
      } finally {
        contextManager.disable();
        await provider.shutdown();
      }
    });
  },
);
