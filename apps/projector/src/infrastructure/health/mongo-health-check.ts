import type { Db } from 'mongodb';
import type { HealthCheck, HealthCheckResult } from '../../application/ports/health-check.port';

export class MongoHealthCheck implements HealthCheck {
  readonly name = 'readModel';

  constructor(private readonly db: Db) {}

  async check(): Promise<HealthCheckResult> {
    try {
      await this.db.command({ ping: 1 });
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }
}
