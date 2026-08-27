// COPY OF (adapted) — apps/gateway/src/infrastructure/health/nats-health-check.ts
// R60/OR6 — a genuine RPC-transport reachability probe against the SAME
// outbound `NatsConnection` `NATS_CONNECTION` provides (app.module.ts) —
// opened SOLELY for this probe, since Fulfillment issues no outbound RPC
// call of its own in this feature (app.module.ts's own header comment).
//
// Unlike the gateway's copy, this one wraps `connection.rtt()` in an
// explicit `withTimeout` — nats.js core does NOT itself bound `rtt()` with
// a short timeout (it awaits a PONG indefinitely on an established-but-
// stalled socket, e.g. a docker-paused broker: the TCP connection stays
// "open" at the OS level, so `isClosed()` stays false and the write
// succeeds, but no reply ever arrives; nats.js's own stale-connection
// detection is governed by `pingInterval`/`maxPingOut`, whose defaults are
// far too slow — minutes — for a readiness probe). Found while writing
// `health-probes.integration.spec.ts` (A8c): without this wrapper, pausing
// the NATS container left `/health/ready` hanging past the test's own
// poll timeout rather than reporting `down` within a bounded window.
import type { NatsConnection } from 'nats';
import type { HealthCheck, HealthCheckResult } from '../../application/ports/health-check.port';

export const NATS_RTT_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rtt() timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class NatsHealthCheck implements HealthCheck {
  readonly name = 'rpcTransport';

  constructor(private readonly connection: NatsConnection) {}

  async check(): Promise<HealthCheckResult> {
    if (this.connection.isClosed()) {
      return { status: 'down', detail: 'NATS connection is closed' };
    }
    try {
      await withTimeout(this.connection.rtt(), NATS_RTT_TIMEOUT_MS);
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }
}
