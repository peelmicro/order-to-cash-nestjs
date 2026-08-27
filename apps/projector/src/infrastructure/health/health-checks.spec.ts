// R60/OR6 — pure unit tests, faked collaborators, no container: mirrors
// apps/gateway/src/infrastructure/health/health-checks.spec.ts's own shape
// for the Mongo check (byte-identical copy), widened with the fact-stream
// (Kafka) check the gateway does not need. No RPC check (PR21 — this
// service issues no RPC request to any service).
import { describe, expect, it, vi } from 'vitest';
import { MongoHealthCheck } from './mongo-health-check';
import { KafkaHealthCheck } from './kafka-health-check';

describe('MongoHealthCheck', () => {
  it('R60 — reports up when the ping command succeeds', async () => {
    const db = { command: async () => ({ ok: 1 }) };
    const check = new MongoHealthCheck(db as never);
    await expect(check.check()).resolves.toEqual({ status: 'up' });
  });

  it('R60 — reports down with a detail when the ping fails', async () => {
    const db = {
      command: async () => {
        throw new Error('connection refused');
      },
    };
    const check = new MongoHealthCheck(db as never);
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
