// R57 (saga_e2e_verification, Pass 1, Part 2) — proves the gap
// `feature_list.json` id 28 named is closed: `fulfillment.stock.reserve`'s
// `@MessagePattern` responder (`stock.controller.ts`) now extracts an
// inbound NATS request's `traceparent` header and CONTINUES that trace
// (not a fresh one) for the whole handler body, exactly the mechanism
// `apps/orders/src/presentation/orders-create.controller.ts` already
// established and `apps/orders/src/infrastructure/messaging/
// trace-context-propagation.integration.spec.ts` already proves for
// Orders — this is Fulfillment's own, previously missing.
//
// Real NATS + real MySQL + real Kafka (Testcontainers), the real
// `AppModule` graph (`stock-integration-harness.ts`) — a raw NATS request
// over a real socket, never a hand-built `NatsContext`. Every assertion
// reads a REAL, OTel-generated `traceId` back out of `outbox.trace_parent`
// — the write `StockController.reserve` triggers, through
// `ReserveStockCommand` → the repository save → `OutboxRecorder`'s own
// `activeTraceParent()` (A5c) — never a bare header-presence check: this
// is genuine proof the extracted context was ACTIVE at the moment the
// write happened, several `await`s and one NATS round trip away from the
// header that carried it in.
import { UniqueId } from '@otc/shared-kernel';
import { trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StockReserveReplyPayload } from '@otc/contracts';
import { STOCK_RESERVE_SUBJECT } from './presentation/stock.controller';
import { startStockIntegrationHarness, type StockIntegrationHarness } from './test-support/stock-integration-harness';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`trace-context-propagation (fulfillment): condition not met within ${timeoutMs}ms`);
}

describe('trace-context-propagation — R57, fulfillment.stock.reserve (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: StockIntegrationHarness;
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeAll(async () => {
    // Registered globally BEFORE the harness compiles/boots `AppModule` —
    // same process, so `stock.controller.ts`'s `extractNatsTraceContext`/
    // `context.with(...)` and `outbox-recorder.ts`'s `activeTraceParent()`
    // (both running inside THIS process once the harness's NATS
    // microservice starts handling requests) resolve against this real
    // `TracerProvider`/`ContextManager`/propagator, not the no-op defaults.
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    harness = await startStockIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
    contextManager?.disable();
    await provider?.shutdown();
  }, 120_000);

  it('a real inbound traceparent header on fulfillment.stock.reserve is the ACTIVE trace (same traceId) at the moment OutboxRecorder writes the outbox row — not a fresh one', async () => {
    const productCode = `PRD-TRACE-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);
    const orderReference = `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    // A real client span, exactly the shape apps/orders' own A5d NATS-RPC
    // case builds — the origin trace this request is meant to continue.
    const clientSpan = trace.getTracer('fulfillment-trace-test').startSpan('test-client-span');
    const { traceId: originTraceId, spanId: originSpanId } = clientSpan.spanContext();
    const traceparent = `00-${originTraceId}-${originSpanId}-01`;
    clientSpan.end();

    const reply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      { orderReference, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 1 }] },
      { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value, traceparent },
    );
    expect(reply).toMatchObject({ outcome: 'accepted', orderReference });

    await waitFor(async () => (await harness.outboxRowsFor(correlationId.value)).length === 1);
    const [row] = await harness.outboxRowsFor(correlationId.value);
    expect(row).toBeDefined();

    // No manual span is created between extraction and the write (unlike
    // apps/orders' outbox relay, which DOES start one on publish) — the
    // EXTRACTED remote span context is still the active one at write time,
    // so the stored value round-trips byte-identical to the header this
    // request carried in.
    expect(row!.traceParent).toBe(traceparent);
    expect(row!.traceParent).toMatch(new RegExp(`^00-${originTraceId}-[0-9a-f]{16}-01$`));
  }, 30_000);

  it('an inbound request with NO traceparent header produces NO trace_parent at all — no spurious trace fabricated', async () => {
    const productCode = `PRD-TRACE-NONE-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);
    const orderReference = `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      { orderReference, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 1 }] },
      { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value },
    );
    expect(reply).toMatchObject({ outcome: 'accepted', orderReference });

    await waitFor(async () => (await harness.outboxRowsFor(correlationId.value)).length === 1);
    const [row] = await harness.outboxRowsFor(correlationId.value);
    expect(row?.traceParent).toBeNull();
  }, 30_000);
});
