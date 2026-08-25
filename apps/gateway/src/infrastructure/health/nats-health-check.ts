import type { NatsConnection } from 'nats';
import type { HealthCheck, HealthCheckResult } from '../../application/ports/health-check.port';

export class NatsHealthCheck implements HealthCheck {
  readonly name = 'rpcTransport';

  constructor(private readonly connection: NatsConnection) {}

  async check(): Promise<HealthCheckResult> {
    if (this.connection.isClosed()) {
      return { status: 'down', detail: 'NATS connection is closed' };
    }
    try {
      await this.connection.rtt();
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }
}
