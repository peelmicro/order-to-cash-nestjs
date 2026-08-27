// Pure unit — R58 closeout (design.md §4.4): `SagaCommandDispatcher`'s two
// structured log lines — `'saga-command-dispatcher: command sent'` (info)
// and `'saga-command-dispatcher: exhausted attempts, command parked'`
// (error, the DLQ-adjacent park diagnostic) — now carry `traceId` (the
// ACTIVE span's real `traceId`, `activeTraceId()`) and `correlationId`
// (the order id, already threaded as the RPC `meta.correlationId` — SO4's
// own FS2 convention — now also surfaced in the log line itself).
// Exercises the REAL default `CONSOLE_LOGGER` (no injected fake logger —
// `saga-command-dispatcher.spec.ts`'s own suite never asserts against the
// real serialised JSON line), the same standard
// `fact-retry-dispatcher-log-trace-id.spec.ts`/`saga-facts-log-trace-id.
// spec.ts` hold.
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { UniqueId, OrderNumber } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { SagaCommandStore, SagaCommandRecord } from '../../application/ports/saga-command-store.port';
import { SagaCommandTransportError, type SagaCommandsPort } from '../../application/ports/saga-commands.port';
import { tracer } from '../observability/trace-context';
import { DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, SagaCommandDispatcher } from './saga-command-dispatcher';

function triggeringEnvelope(): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'order.placed.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-08-26T09:00:00.000Z',
    payload: {},
  } as unknown as Envelope;
}

function pendingRow(overrides: Partial<SagaCommandRecord> = {}): SagaCommandRecord {
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
    triggeringEventEnvelope: triggeringEnvelope(),
    triggeringEventTopic: 'otc.orders.facts.v1',
    status: 'pending',
    attempts: 0,
    deadLetteredAt: null,
    ...overrides,
  };
}

function fakeStore(row: SagaCommandRecord | null, options: { parkReturns?: boolean } = {}): SagaCommandStore {
  return {
    async enqueue() {
      throw new Error('not used by this test');
    },
    async findByOrderAndCommand() {
      return row;
    },
    async claimDue() {
      throw new Error('not used by this test');
    },
    async markSent() {
      return true;
    },
    async park() {
      return options.parkReturns ?? true;
    },
    async claimDeadLetter() {
      return true;
    },
  };
}

function fakePort(overrides: Partial<SagaCommandsPort> = {}): SagaCommandsPort {
  return {
    reserveStock: vi.fn(),
    releaseStock: vi.fn(),
    createDespatch: vi.fn(),
    holdCredit: vi.fn(),
    issueInvoice: vi.fn(),
    ...overrides,
  };
}

async function noDelay(): Promise<void> {}

describe('SagaCommandDispatcher — log lines carry traceId + correlationId (R58 closeout, design.md §4.4)', () => {
  it('"command sent" logs the REAL active span\'s traceId and the order id as correlationId — not merely field presence', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const row = pendingRow();
      const store = fakeStore(row);
      const reserveStock = vi.fn().mockResolvedValue({ outcome: 'accepted', orderReference: 'ORD-000001' });
      const dispatcher = new SagaCommandDispatcher(fakePort({ reserveStock }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, noDelay);

      const originSpan = tracer().startSpan('saga.dispatch stock.reserve');
      const { traceId: originTraceId } = originSpan.spanContext();
      const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        await dispatcher.dispatch(row.orderId, 'stock.reserve');
      });
      originSpan.end();

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(infoSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toBe('saga-command-dispatcher: command sent');
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(logged.correlationId).toBe(row.orderId.value);

      infoSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it('"command parked" logs the REAL active span\'s traceId and the order id as correlationId — not merely field presence', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const row = pendingRow();
      const store = fakeStore(row);
      const reserveStock = vi.fn().mockRejectedValue(new SagaCommandTransportError('fulfillment.stock.reserve', 'no responders'));
      const dispatcher = new SagaCommandDispatcher(fakePort({ reserveStock }), store, DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG, noDelay);

      const originSpan = tracer().startSpan('saga.dispatch stock.reserve');
      const { traceId: originTraceId } = originSpan.spanContext();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await context.with(trace.setSpan(context.active(), originSpan), async () => {
        await dispatcher.dispatch(row.orderId, 'stock.reserve');
      });
      originSpan.end();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.message).toBe('saga-command-dispatcher: exhausted attempts, command parked');
      expect(logged.traceId).toBe(originTraceId);
      expect(logged.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(logged.correlationId).toBe(row.orderId.value);

      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });

  it('omits traceId entirely — never the literal string "undefined" — when no span is active, on both call sites', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const sentRow = pendingRow();
      const sentStore = fakeStore(sentRow);
      const reserveStockOk = vi.fn().mockResolvedValue({ outcome: 'accepted', orderReference: 'ORD-000001' });
      const sentDispatcher = new SagaCommandDispatcher(
        fakePort({ reserveStock: reserveStockOk }),
        sentStore,
        DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG,
        noDelay,
      );
      const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await sentDispatcher.dispatch(sentRow.orderId, 'stock.reserve');
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const sentLine = infoSpy.mock.calls[0]![0] as string;
      expect(sentLine).not.toContain('"traceId":"undefined"');
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(sentLine), 'traceId')).toBe(false);
      infoSpy.mockRestore();

      const parkedRow = pendingRow();
      const parkedStore = fakeStore(parkedRow);
      const reserveStockFail = vi.fn().mockRejectedValue(new SagaCommandTransportError('fulfillment.stock.reserve', 'no responders'));
      const parkedDispatcher = new SagaCommandDispatcher(
        fakePort({ reserveStock: reserveStockFail }),
        parkedStore,
        DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG,
        noDelay,
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await parkedDispatcher.dispatch(parkedRow.orderId, 'stock.reserve');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const parkedLine = errorSpy.mock.calls[0]![0] as string;
      expect(parkedLine).not.toContain('"traceId":"undefined"');
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(parkedLine), 'traceId')).toBe(false);
      errorSpy.mockRestore();
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
