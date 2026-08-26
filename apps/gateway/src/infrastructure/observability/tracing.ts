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
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317';

export const tracingSdk = new NodeSDK({
  serviceName: 'gateway',
  traceExporter: new OTLPTraceExporter({ url: OTEL_EXPORTER_OTLP_ENDPOINT }),
  instrumentations: [new HttpInstrumentation()],
});

tracingSdk.start();
