// R60/OR6 — a genuine write-model reachability probe: `SELECT 1` against
// the SAME `mysql2` pool `NOTIFICATIONS_DB` is built from (app.module.ts), bounded
// by a per-query `timeout` (mysql2 destroys the connection and rejects if
// the query has not completed by then — the query never hangs past this
// window even against a paused/unreachable broker, since the timer covers
// connection acquisition AND execution, not just execution). Never cached:
// every `check()` call issues a fresh query.
import type { Pool } from 'mysql2/promise';
import type { HealthCheck, HealthCheckResult } from '../../application/ports/health-check.port';

export const MYSQL_PING_TIMEOUT_MS = 2000;

export class MysqlHealthCheck implements HealthCheck {
  readonly name = 'writeModel';

  constructor(private readonly pool: Pool) {}

  async check(): Promise<HealthCheckResult> {
    try {
      await this.pool.query({ sql: 'SELECT 1', timeout: MYSQL_PING_TIMEOUT_MS });
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }
}
