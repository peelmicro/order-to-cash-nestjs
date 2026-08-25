import { describe, expect, it } from 'vitest';
import { MongoHealthCheck } from './mongo-health-check';
import { NatsHealthCheck } from './nats-health-check';

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
});
