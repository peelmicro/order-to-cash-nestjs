// OTel SDK bootstrap (observability_reliability design.md §4.3/§6, A5a,
// R57/OR4). Imported as `main.ts`'s FIRST import (mirroring the existing
// `reflect-metadata`-first convention) so that a real `TracerProvider`, a
// real W3C trace-context propagator and — most importantly — a real,
// async-hooks-based `ContextManager` are registered globally BEFORE
// anything in this service calls `trace.getTracer(...)`/`context.with(...)`
// (`../messaging/trace-context.ts`, `../outbox/outbox-recorder.ts`,
// `../outbox/outbox-relay.ts`, `../../presentation/saga-facts.controller.ts`,
// `../../presentation/orders-create.controller.ts`). Without a REAL
// `ContextManager` registered, `@opentelemetry/api`'s own default
// (`NoopContextManager`) does not thread context across `await` boundaries
// at all — `context.with(ctx, fn)` just calls `fn()` directly, so a span
// extracted from an inbound NATS/Kafka header would never actually be
// "active" by the time the code that reads `context.active()` runs.
//
// kafkajs/nats have no official OTel auto-instrumentation (design.md
// §4.3), so this service's `instrumentations` list is empty — every span
// this service creates is manual, at the two points design.md names: the
// outbox relay's publish call, and `SagaFactsController.route`'s
// fact-consume entry point.
//
// Not imported anywhere except `main.ts` — a spec file that imports
// application/domain/infrastructure modules directly (never `main.ts`)
// never triggers this side effect, so unit tests are unaffected; every
// trace-propagation TEST registers its own `NodeTracerProvider` +
// `InMemorySpanExporter` (design.md §8), never this OTLP-exporting one.
//
// A7 (metrics, R59/OR5, design.md §4.5) widens this SAME bootstrap to also
// register a real, globally-visible `MeterProvider` — `metrics.ts`'s
// `meter()` (`metrics.getMeter('orders')`) resolves against whatever
// `MeterProvider` is currently registered, exactly the same "global proxy"
// convention `tracer()` already establishes for spans above. No
// per-service `/metrics` HTTP endpoint (design.md §4.5's own stated
// choice) — `PeriodicExportingMetricReader` pushes over OTLP to the same
// `otel-collector:4317` the trace exporter already targets.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317';

export const tracingSdk = new NodeSDK({
  serviceName: 'orders',
  traceExporter: new OTLPTraceExporter({ url: OTEL_EXPORTER_OTLP_ENDPOINT }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: OTEL_EXPORTER_OTLP_ENDPOINT }),
  }),
  instrumentations: [],
});

tracingSdk.start();
