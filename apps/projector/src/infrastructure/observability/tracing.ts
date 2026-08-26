// OTel SDK bootstrap — same shape and reasoning as
// apps/orders/src/infrastructure/observability/tracing.ts (design.md
// §4.3/§6, A5a, R57/OR4); adapted for this service's own name and its own
// (Kafka-consume-only) manual span points. See that file's own header
// comment for why a REAL `ContextManager` matters, not just a real
// `TracerProvider`.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317';

export const tracingSdk = new NodeSDK({
  serviceName: 'projector',
  traceExporter: new OTLPTraceExporter({ url: OTEL_EXPORTER_OTLP_ENDPOINT }),
  instrumentations: [],
});

tracingSdk.start();
