// COPY OF (adapted) — apps/gateway/src/application/ports/health-check.port.ts
// R60/OR6 — design.md §4.6's table: Notifications' two live dependencies
// are the FACT STREAM (Kafka, the three fact topics this service consumes)
// and its OWN STORE (MySQL, the `processed_events` idempotency ledger — N1/
// N2). No RPC-transport check: this service answers no RPC and opens no
// outbound NATS connection (notification-facts.controller.ts's own header:
// "this service consumes only"). Liveness (`GET /health/live`) checks
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
