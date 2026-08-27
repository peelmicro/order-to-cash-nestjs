// R60/OR6 (A8c) — proven against a GENUINELY paused/unpaused real
// container, not a mock: `docker pause`/`docker unpause` against the REAL
// `mysql:8.4.11` container `startBillingTestFixture` starts (a second
// service's own MySQL pause/unpause proof, for variety alongside Orders' —
// Fulfillment already covers the NATS half). Exercises the REAL production
// `HealthController`/`MysqlHealthCheck`/`NatsHealthCheck` classes
// `app.module.ts` wires, composed here into a small, hand-built Nest
// module — same "compose the real production classes directly, skip the
// rest of AppModule's DI graph" shape apps/orders'/apps/fulfillment's own
// copies of this spec establish.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NatsConnection } from 'nats';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { READINESS_CHECKS, type HealthCheck } from './application/ports/health-check.port';
import { HealthController } from './presentation/health.controller';
import { MysqlHealthCheck } from './infrastructure/health/mysql-health-check';
import { NatsHealthCheck } from './infrastructure/health/nats-health-check';
import { startBillingTestFixture, type BillingTestFixture } from './infrastructure/persistence/test-support/billing-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from './infrastructure/messaging/test-support/nats-test-fixture';

const execFileAsync = promisify(execFile);

// README.md's own "two-daemon quirk": Testcontainers reads `DOCKER_HOST`,
// falling back to `/var/run/docker.sock` — it does NOT follow the `docker`
// CLI's active context. Pinning the CLI to the same socket is what makes
// `pause`/`unpause` target the container Testcontainers actually started.
const DOCKER_ENV = { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock' };

async function pauseContainer(id: string): Promise<void> {
  await execFileAsync('docker', ['pause', id], { env: DOCKER_ENV });
}

async function unpauseContainer(id: string): Promise<void> {
  await execFileAsync('docker', ['unpause', id], { env: DOCKER_ENV });
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}: condition not met within ${timeoutMs}ms`);
}

describe('health-probes — R60/OR6, billing (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine)', () => {
  let mysqlFixture: BillingTestFixture;
  let natsFixture: NatsTestFixture;
  let natsConnection: NatsConnection;
  let app: INestApplication;

  beforeAll(async () => {
    [mysqlFixture, natsFixture] = await Promise.all([startBillingTestFixture(), startNatsTestFixture()]);
    natsConnection = await natsFixture.connect();

    const checks: readonly HealthCheck[] = [new MysqlHealthCheck(mysqlFixture.pool), new NatsHealthCheck(natsConnection)];

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: READINESS_CHECKS, useValue: checks }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await natsConnection?.close();
    await Promise.all([mysqlFixture?.teardown(), natsFixture?.teardown()]);
  });

  it('R60 — reports ready (200, every check up) when every dependency is reachable', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'up',
      checks: {
        writeModel: { status: 'up' },
        rpcTransport: { status: 'up' },
      },
    });
  });

  it(
    'R60 — pausing the REAL write-model (MySQL) container makes readiness report 503/down for writeModel ONLY, while liveness stays 200/up throughout, and readiness recovers once the container is unpaused',
    async () => {
      const liveBefore = await request(app.getHttpServer()).get('/health/live');
      expect(liveBefore.status).toBe(200);
      expect(liveBefore.body).toEqual({ status: 'up' });

      await pauseContainer(mysqlFixture.container.getId());
      try {
        await waitFor('readiness observes the paused write model', async () => {
          const res = await request(app.getHttpServer()).get('/health/ready');
          return res.status === 503 && res.body.status === 'down' && res.body.checks?.writeModel?.status === 'down';
        });

        const res = await request(app.getHttpServer()).get('/health/ready');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('down');
        expect(res.body.checks.writeModel.status).toBe('down');
        expect(res.body.checks.rpcTransport).toEqual({ status: 'up' });

        const liveDuring = await request(app.getHttpServer()).get('/health/live');
        expect(liveDuring.status).toBe(200);
        expect(liveDuring.body).toEqual({ status: 'up' });
      } finally {
        await unpauseContainer(mysqlFixture.container.getId());
      }

      await waitFor('readiness recovers once the write model is unpaused', async () => {
        const res = await request(app.getHttpServer()).get('/health/ready');
        return res.status === 200 && res.body.status === 'up';
      });
    },
    90_000,
  );
});
