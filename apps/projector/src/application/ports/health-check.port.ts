// COPY OF (adapted) — apps/gateway/src/application/ports/health-check.port.ts
// R60/OR6 — design.md §4.6's table: the Projector's two live dependencies
// are the FACT STREAM (Kafka, the three fact topics this service consumes)
// and its OWN STORE (MongoDB, the `order_timeline` read model it is the
// ONLY runtime writer of — PR20). No RPC-transport check: this service
// issues NO RPC request to any service (PR21); its outbound NATS
// connection is publish-only (the update signal, design.md §7.1), not an
// RPC transport in R60's sense. Liveness (`GET /health/live`) checks
// NEITHER — R60's own words: "deliberately independent of dependencies".
export interface HealthCheckResult {
  readonly status: 'up' | 'down';
  readonly detail?: string;
}

export interface HealthCheck {
  readonly name: string;
  check(): Promise<HealthCheckResult>;
}

export const READINESS_CHECKS = Symbol('ReadinessChecks');
