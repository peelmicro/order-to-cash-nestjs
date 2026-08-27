// COPY OF (adapted) — apps/gateway/src/application/ports/health-check.port.ts
// R60/OR6 — design.md §4.6's table: Orders' three live dependencies are the
// WRITE MODEL (MySQL), the FACT STREAM (Kafka, the outbox relay's
// producer/admin surface) and the RPC TRANSPORT (NATS, the outbound
// `fulfillment.stock.check`/saga-command connection). Liveness
// (`GET /health/live`) checks NONE of them — R60's own words: "deliberately
// independent of dependencies".
export interface HealthCheckResult {
  readonly status: 'up' | 'down';
  readonly detail?: string;
}

export interface HealthCheck {
  readonly name: string;
  check(): Promise<HealthCheckResult>;
}

export const READINESS_CHECKS = Symbol('ReadinessChecks');
