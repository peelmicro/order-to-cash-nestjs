// R60/OR6 — pure unit tests, faked collaborators, no container: mirrors
// apps/gateway/src/infrastructure/health/health-checks.spec.ts's own shape.
// No Kafka check for Fulfillment (design.md §4.6's table — it consumes no
// fact in this feature).
import { describe, expect, it, vi } from 'vitest';
import { MysqlHealthCheck } from './mysql-health-check';
import { NatsHealthCheck } from './nats-health-check';

describe('MysqlHealthCheck', () => {
  it('R60 — reports up when the ping query succeeds', async () => {
    const pool = { query: vi.fn().mockResolvedValue([[{ '1': 1 }], []]) };
    const check = new MysqlHealthCheck(pool as never);
    await expect(check.check()).resolves.toEqual({ status: 'up' });
    expect(pool.query).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT 1' }));
  });

  it('R60 — reports down with a detail when the ping query rejects', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const check = new MysqlHealthCheck(pool as never);
    await expect(check.check()).resolves.toEqual({ status: 'down', detail: 'connection refused' });
  });
});

describe('NatsHealthCheck', () => {
  it('R60 — reports up when the connection is open and rtt() resolves', async () => {
    const connection = { isClosed: () => false, rtt: async () => 3 };
    const check = new NatsHealthCheck(connection as never);
    await expect(check.check()).resolves.toEqual({ status: 'up' });
  });

  it('R60 — reports down immediately when the connection is closed, without calling rtt()', async () => {
    let rttCalled = false;
    const connection = {
      isClosed: () => true,
      rtt: async () => {
        rttCalled = true;
        return 0;
      },
    };
    const check = new NatsHealthCheck(connection as never);

    const result = await check.check();

    expect(result.status).toBe('down');
    expect(rttCalled).toBe(false);
  });

  it('R60 — reports down when rtt() never settles within the bounded timeout (a stalled-but-open connection)', async () => {
    const connection = {
      isClosed: () => false,
      rtt: () => new Promise<number>(() => {}),
    };
    const check = new NatsHealthCheck(connection as never);

    const result = await check.check();

    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/timed out/);
  }, 10_000);
});
