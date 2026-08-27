// OTel SDK bootstrap — same shape and reasoning as
// apps/orders/src/infrastructure/observability/tracing.ts (design.md
// §4.3/§6, A5a, R57/OR4). This is the ONE service that gets an actual
// `Instrumentation`: `@opentelemetry/instrumentation-http` auto-patches
// Node's `http`/`https` modules — both the inbound side (a span per
// request Express handles) and the outbound side (a span per outgoing
// `http.request`, e.g. the `nats` client's own use of `http` for nothing
// relevant here, but any future outbound HTTP call gets it for free) —
// which is why this file, unlike the other three services' copies, is
// imported as `main.ts`'s literal first line: the instrumentation must
// patch `http` before `@nestjs/platform-express`/`http` itself is
// `require`d anywhere else in the module graph, or the patch never takes.
//
// A7 (metrics, R59/OR5, design.md §4.5) widens this SAME bootstrap to also
// register a real, globally-visible `MeterProvider` — `metrics.ts`'s
// `meter()` resolves against whatever `MeterProvider` is currently
// registered, the SAME "global proxy" convention `tracer()` already
// establishes above for spans. No per-service `/metrics` HTTP endpoint
// (design.md §4.5's own stated choice) — `PeriodicExportingMetricReader`
// pushes over OTLP to the same `otel-collector:4317` the trace exporter
// already targets.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317';

export const tracingSdk = new NodeSDK({
  serviceName: 'gateway',
  traceExporter: new OTLPTraceExporter({ url: OTEL_EXPORTER_OTLP_ENDPOINT }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: OTEL_EXPORTER_OTLP_ENDPOINT }),
  }),
  instrumentations: [new HttpInstrumentation()],
});

tracingSdk.start();
