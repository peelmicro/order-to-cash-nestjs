// R60/OR6 (A8c) — proven against a GENUINELY paused/unpaused real
// container, not a mock: `docker pause`/`docker unpause` against the REAL
// `apache/kafka:4.3.1` container `startKafkaTestFixture` starts — this
// service's fact stream (the MySQL half is already proven, twice over, by
// apps/orders' and apps/billing's own copies of this spec). Exercises the
// REAL production `HealthController`/`MysqlHealthCheck`/`KafkaHealthCheck`
// classes `app.module.ts` wires, composed here into a small, hand-built
// Nest module — same shape every other service's own copy of this spec
// establishes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { READINESS_CHECKS, type HealthCheck } from './application/ports/health-check.port';
import { HealthController } from './presentation/health.controller';
import { MysqlHealthCheck } from './infrastructure/health/mysql-health-check';
import { createKafkaHealthClient, KafkaHealthCheck } from './infrastructure/health/kafka-health-check';
import {
  startNotificationsTestFixture,
  type NotificationsTestFixture,
} from './infrastructure/persistence/test-support/notifications-test-fixture';
import { startKafkaTestFixture, type KafkaTestFixture } from './test-support/kafka-test-fixture';
import { loadKafkaConfig } from './infrastructure/messaging/kafka.config';

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

describe('health-probes — R60/OR6, notifications (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1)', () => {
  let mysqlFixture: NotificationsTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let app: INestApplication;

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture] = await Promise.all([startNotificationsTestFixture(), startKafkaTestFixture()]);

    const checks: readonly HealthCheck[] = [
      new MysqlHealthCheck(mysqlFixture.pool),
      new KafkaHealthCheck(createKafkaHealthClient(loadKafkaConfig({ KAFKA_BROKERS: kafkaFixture.brokers.join(',') } as NodeJS.ProcessEnv))),
    ];

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: READINESS_CHECKS, useValue: checks }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([mysqlFixture?.teardown(), kafkaFixture?.teardown()]);
  });

  it('R60 — reports ready (200, every check up) when every dependency is reachable', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'up',
      checks: {
        writeModel: { status: 'up' },
        factStream: { status: 'up' },
      },
    });
  });

  it(
    'R60 — pausing the REAL fact-stream (Kafka) container makes readiness report 503/down for factStream ONLY, while liveness stays 200/up throughout, and readiness recovers once the container is unpaused',
    async () => {
      const liveBefore = await request(app.getHttpServer()).get('/health/live');
      expect(liveBefore.status).toBe(200);
      expect(liveBefore.body).toEqual({ status: 'up' });

      await pauseContainer(kafkaFixture.container.getId());
      try {
        await waitFor('readiness observes the paused fact stream', async () => {
          const res = await request(app.getHttpServer()).get('/health/ready');
          return res.status === 503 && res.body.status === 'down' && res.body.checks?.factStream?.status === 'down';
        });

        const res = await request(app.getHttpServer()).get('/health/ready');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('down');
        expect(res.body.checks.factStream.status).toBe('down');
        expect(res.body.checks.writeModel).toEqual({ status: 'up' });

        const liveDuring = await request(app.getHttpServer()).get('/health/live');
        expect(liveDuring.status).toBe(200);
        expect(liveDuring.body).toEqual({ status: 'up' });
      } finally {
        await unpauseContainer(kafkaFixture.container.getId());
      }

      await waitFor('readiness recovers once the fact stream is unpaused', async () => {
        const res = await request(app.getHttpServer()).get('/health/ready');
        return res.status === 200 && res.body.status === 'up';
      });
    },
    90_000,
  );
});
