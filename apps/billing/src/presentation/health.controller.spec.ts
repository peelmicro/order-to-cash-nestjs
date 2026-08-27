// R60/OR6 (A8b) — readiness aggregation logic with faked `HealthCheck`s, no
// container, no DI container: mirrors the shape
// apps/gateway/src/infrastructure/health/health-checks.spec.ts establishes
// for the individual checks, applied here to `HealthController`'s own
// all-up/any-down aggregation and status-code branching.
import { describe, expect, it, vi } from 'vitest';
import type { HealthCheck } from '../application/ports/health-check.port';
import { HealthController } from './health.controller';

function fakeResponse(): { status: ReturnType<typeof vi.fn> } {
  return { status: vi.fn() };
}

function up(name: string): HealthCheck {
  return { name, check: async () => ({ status: 'up' }) };
}

function down(name: string, detail: string): HealthCheck {
  return { name, check: async () => ({ status: 'down', detail }) };
}

describe('HealthController', () => {
  it('R60 — live() always answers 200 up, independent of any check', () => {
    const controller = new HealthController([down('writeModel', 'unreachable')]);
    expect(controller.live()).toEqual({ status: 'up' });
  });

  it('R60 — ready() reports up (no status override) when every check is up', async () => {
    const controller = new HealthController([up('writeModel'), up('factStream'), up('rpcTransport')]);
    const res = fakeResponse();

    const body = await controller.ready(res as never);

    expect(body).toEqual({
      status: 'up',
      checks: {
        writeModel: { status: 'up' },
        factStream: { status: 'up' },
        rpcTransport: { status: 'up' },
      },
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('R60 — ready() reports down and sets 503 when ANY single check is down, naming the failing check', async () => {
    const controller = new HealthController([up('writeModel'), down('factStream', 'broker unreachable'), up('rpcTransport')]);
    const res = fakeResponse();

    const body = await controller.ready(res as never);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(body.status).toBe('down');
    expect(body.checks?.factStream).toEqual({ status: 'down', detail: 'broker unreachable' });
    expect(body.checks?.writeModel).toEqual({ status: 'up' });
  });
});
