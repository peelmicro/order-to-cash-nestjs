// R60/OR6 — pure unit tests, faked collaborators, no container: mirrors
// apps/gateway/src/infrastructure/health/health-checks.spec.ts's own shape,
// widened with the two checks the gateway does not need (fact stream, this
// service's own store). No RPC check (this service issues no RPC).
import { describe, expect, it, vi } from 'vitest';
import { MysqlHealthCheck } from './mysql-health-check';
import { KafkaHealthCheck } from './kafka-health-check';

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

describe('KafkaHealthCheck', () => {
  it('R60 — reports up when admin.connect() and describeCluster() both succeed, and always disconnects', async () => {
    const admin = {
      connect: vi.fn().mockResolvedValue(undefined),
      describeCluster: vi.fn().mockResolvedValue({ brokers: [], controller: null, clusterId: 'x' }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = { admin: () => admin };
    const check = new KafkaHealthCheck(client as never);

    await expect(check.check()).resolves.toEqual({ status: 'up' });
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
  });

  it('R60 — reports down with a detail when describeCluster() rejects, and still disconnects', async () => {
    const admin = {
      connect: vi.fn().mockResolvedValue(undefined),
      describeCluster: vi.fn().mockRejectedValue(new Error('broker unreachable')),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = { admin: () => admin };
    const check = new KafkaHealthCheck(client as never);

    await expect(check.check()).resolves.toEqual({ status: 'down', detail: 'broker unreachable' });
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
  });

  it('R60 — reports down when admin.connect() itself rejects, without throwing out of check()', async () => {
    const admin = {
      connect: vi.fn().mockRejectedValue(new Error('connect timed out')),
      describeCluster: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = { admin: () => admin };
    const check = new KafkaHealthCheck(client as never);

    await expect(check.check()).resolves.toEqual({ status: 'down', detail: 'connect timed out' });
    expect(admin.describeCluster).not.toHaveBeenCalled();
  });
});
