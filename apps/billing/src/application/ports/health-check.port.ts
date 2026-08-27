// COPY OF (adapted) — apps/gateway/src/application/ports/health-check.port.ts
// R60/OR6 — design.md §4.6's table: Billing's two live dependencies are
// the WRITE MODEL (MySQL) and the RPC TRANSPORT (NATS, the
// `billing.credit.*` responders' inbound connection). No fact-stream
// check: Billing consumes no fact in this feature (saga.md §5) — it
// only PRODUCES facts via its outbox, which OR5's outbox-lag metric already
// covers. Liveness (`GET /health/live`) checks NEITHER — R60's own words:
// "deliberately independent of dependencies".
export interface HealthCheckResult {
  readonly status: 'up' | 'down';
  readonly detail?: string;
}

export interface HealthCheck {
  readonly name: string;
  check(): Promise<HealthCheckResult>;
}

export const READINESS_CHECKS = Symbol('ReadinessChecks');
