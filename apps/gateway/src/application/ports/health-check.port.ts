// R60 — readiness depends on "the service's write model, the fact stream
// or the RPC transport". This gateway has no write model of its own and
// consumes no fact stream directly (Group D's SSE stream rides the
// projector's update SIGNAL, not the fact stream itself) — its two live
// dependencies are the READ MODEL (MongoDB, R54) and the RPC transport
// (NATS). Liveness (`GET /health/live`) checks NEITHER — R60's own words:
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
