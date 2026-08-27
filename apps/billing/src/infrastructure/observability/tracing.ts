// OTel SDK bootstrap (A5a, R57/OR4) — the TRACE-ONLY half of
// apps/orders/src/infrastructure/observability/tracing.ts's own bootstrap.
// Imported as `main.ts`'s FIRST import (mirrors the `reflect-metadata`-first
// convention below it), for the exact same reason Orders' own header
// comment states: a real `TracerProvider`, a real W3C trace-context
// propagator and a real, async-hooks-based `ContextManager` must be
// registered globally BEFORE anything in this service calls
// `context.with(...)`/`propagation.extract(...)`/`propagation.inject(...)`
// (`trace-context.ts`, `outbox-recorder.ts`, `credit.controller.ts`,
// `invoice.controller.ts`) — otherwise `@opentelemetry/api`'s own default
// no-op propagator/context-manager makes every one of those calls inert:
// extraction always returns an empty context, `context.with` never
// actually threads context across an `await`.
//
// Deliberately NO `metricReader`/`PeriodicExportingMetricReader` here: A7
// (R59/OR5) metrics were scoped to Orders/Gateway only
// (`observability_reliability/design.md` §4.5, `tasks.md` A7a) and remain
// out of THIS pass's scope (`saga_e2e_verification`, Pass 1's Part 2) —
// this bootstrap exists to close R57's two disclosed extraction/write
// gaps, not to widen A7.
//
// kafkajs/nats have no official OTel auto-instrumentation, same as Orders
// — this service creates no manual span either (unlike Orders' outbox
// relay): it simply forwards a stored `trace_parent` verbatim as the
// outbound Kafka header (`outbox-relay.ts`, unchanged by this pass), so no
// `SpanKind.PRODUCER` span needs registering here. `instrumentations: []`.
//
// Not imported anywhere except `main.ts` — spec files that import
// application/domain/infrastructure modules directly (never `main.ts`)
// never trigger this side effect; the trace-continuity test registers its
// own `NodeTracerProvider` + `InMemorySpanExporter` instead (mirrors
// Orders' own `trace-context-propagation.integration.spec.ts`).
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317';

export const tracingSdk = new NodeSDK({
  serviceName: 'billing',
  traceExporter: new OTLPTraceExporter({ url: OTEL_EXPORTER_OTLP_ENDPOINT }),
  instrumentations: [],
});

tracingSdk.start();
