// R57 (saga_e2e_verification, Pass 1, Part 2) — proves the gap
// `feature_list.json` id 28 named is closed: `billing.credit.hold`'s
// `@MessagePattern` responder (`credit.controller.ts`) now extracts an
// inbound NATS request's `traceparent` header and CONTINUES that trace
// (not a fresh one) for the whole handler body, exactly the mechanism
// `apps/orders/src/presentation/orders-create.controller.ts` already
// established and `apps/orders/src/infrastructure/messaging/
// trace-context-propagation.integration.spec.ts` already proves for
// Orders — this is Billing's own, previously missing.
//
// Real NATS + real MySQL + real Kafka (Testcontainers), the real
// `AppModule` graph (`billing-integration-harness.ts`) — a raw NATS
// request over a real socket, never a hand-built `NatsContext`. Every
// assertion reads a REAL, OTel-generated `traceId` back out of
// `outbox.trace_parent` — the write `CreditController.hold` triggers,
// through `HoldCreditCommand` → the repository save → `OutboxRecorder`'s
// own `activeTraceParent()` (A5c) — never a bare header-presence check:
// this is genuine proof the extracted context was ACTIVE at the moment
// the write happened, several `await`s and one NATS round trip away from
// the header that carried it in.
import { randomUUID } from 'node:crypto';
import { UniqueId } from '@otc/shared-kernel';
import { trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreditHoldReplyPayload } from '@otc/contracts';
import { CREDIT_HOLD_SUBJECT } from './presentation/credit.controller';
import { startBillingIntegrationHarness, type BillingIntegrationHarness } from './test-support/billing-integration-harness';

const CURRENCY = 'EUR';

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

function shortId(): string {
  return randomUUID().slice(0, 6);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`trace-context-propagation (billing): condition not met within ${timeoutMs}ms`);
}

describe('trace-context-propagation — R57, billing.credit.hold (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: BillingIntegrationHarness;
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeAll(async () => {
    // Registered globally BEFORE the harness compiles/boots `AppModule` —
    // same process, so `credit.controller.ts`'s `extractNatsTraceContext`/
    // `context.with(...)` and `outbox-recorder.ts`'s `activeTraceParent()`
    // (both running inside THIS process once the harness's NATS
    // microservice starts handling requests) resolve against this real
    // `TracerProvider`/`ContextManager`/propagator, not the no-op defaults.
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    harness = await startBillingIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
    contextManager?.disable();
    await provider?.shutdown();
  }, 120_000);

  it('a real inbound traceparent header on billing.credit.hold is the ACTIVE trace (same traceId) at the moment OutboxRecorder writes the outbox row — not a fresh one', async () => {
    const retailerCode = `RET-${shortId()}`;
    const companyCode = `COM-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    // A real client span, exactly the shape apps/orders' own A5d NATS-RPC
    // case builds — the origin trace this request is meant to continue.
    const clientSpan = trace.getTracer('billing-trace-test').startSpan('test-client-span');
    const { traceId: originTraceId, spanId: originSpanId } = clientSpan.spanContext();
    const traceparent = `00-${originTraceId}-${originSpanId}-01`;
    clientSpan.end();

    const reply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      { orderReference, retailerCode, companyCode, amount: { amount: 100_000, currency: CURRENCY } },
      { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value, traceparent },
    );
    expect(reply).toMatchObject({ outcome: 'approved' });

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
    const retailerCode = `RET-${shortId()}`;
    const companyCode = `COM-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      { orderReference, retailerCode, companyCode, amount: { amount: 50_000, currency: CURRENCY } },
      { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value },
    );
    expect(reply).toMatchObject({ outcome: 'approved' });

    await waitFor(async () => (await harness.outboxRowsFor(correlationId.value)).length === 1);
    const [row] = await harness.outboxRowsFor(correlationId.value);
    expect(row?.traceParent).toBeNull();
  }, 30_000);
});
