// R60/OR6 (A8c) — the ONE test in this feature proven against a GENUINELY
// stopped real dependency, not a mock: `docker pause`/`docker unpause` (via
// the Docker CLI, which itself talks to the same Docker API Testcontainers
// uses) against the REAL `mysql:8.4.11` container `startOrdersTestFixture`
// starts. Exercises the REAL production `HealthController` and the REAL
// production `MysqlHealthCheck`/`KafkaHealthCheck`/`NatsHealthCheck`
// classes `app.module.ts` wires — composed here into a small, HAND-BUILT
// Nest module (same "compose the real production classes directly, skip
// the rest of AppModule's DI graph" shape
// `orders-acceptance.integration.spec.ts`/`saga-integration-harness.ts`
// already establish in this file) rather than the FULL `AppModule`: booting
// the real `AppModule` would ALSO eagerly connect `DLQ_DEPTH_PORT`'s admin
// client and start `OutboxRelayService`'s background poll loop at
// `app.init()` time — real behaviour this spec has no interest in and that
// would only add unrelated failure surface to a test about the readiness
// mechanism itself.
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
import { createKafkaHealthClient, KafkaHealthCheck } from './infrastructure/health/kafka-health-check';
import { NatsHealthCheck } from './infrastructure/health/nats-health-check';
import { startOrdersTestFixture, type OrdersTestFixture } from './infrastructure/persistence/test-support/orders-test-fixture';
import { startKafkaTestFixture, type KafkaTestFixture } from './infrastructure/outbox/test-support/kafka-test-fixture';
import { loadKafkaConfig } from './infrastructure/outbox/kafka.config';
import { startNatsTestFixture, type NatsTestFixture } from './infrastructure/messaging/test-support/nats-test-fixture';

const execFileAsync = promisify(execFile);

// README.md's own "two-daemon quirk" note: Testcontainers reads
// `DOCKER_HOST`, falling back to `/var/run/docker.sock` — it does NOT
// follow the `docker` CLI's active context (this machine's is
// `desktop-linux`, a DIFFERENT socket). A bare `docker pause <id>` in an
// environment with more than one Docker daemon therefore fails with "No
// such container" even though the container genuinely exists — found live
// while writing this spec. `DOCKER_ENV` pins the CLI to the SAME socket
// Testcontainers itself resolved to, so `pause`/`unpause` target the real
// container Testcontainers started.
const DOCKER_ENV = { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock' };

async function pauseContainer(id: string): Promise<void> {
  await execFileAsync('docker', ['pause', id], { env: DOCKER_ENV });
}

async function unpauseContainer(id: string): Promise<void> {
  await execFileAsync('docker', ['unpause', id], { env: DOCKER_ENV });
}

/** Poll-until, never a bare sleep — same shape `saga-integration-harness.ts`'s own `waitFor` (via `waitForConsumerGroupReady`) establishes for this repo's integration specs. */
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

describe('health-probes — R60/OR6, orders (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1 + nats:2.14.5-alpine)', () => {
  let mysqlFixture: OrdersTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let natsFixture: NatsTestFixture;
  let natsConnection: NatsConnection;
  let app: INestApplication;

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture, natsFixture] = await Promise.all([
      startOrdersTestFixture(),
      startKafkaTestFixture(),
      startNatsTestFixture(),
    ]);
    natsConnection = await natsFixture.connect();

    const checks: readonly HealthCheck[] = [
      new MysqlHealthCheck(mysqlFixture.pool),
      new KafkaHealthCheck(createKafkaHealthClient(loadKafkaConfig({ KAFKA_BROKERS: kafkaFixture.brokers.join(',') } as NodeJS.ProcessEnv))),
      new NatsHealthCheck(natsConnection),
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
    await natsConnection?.close();
    await Promise.all([mysqlFixture?.teardown(), kafkaFixture?.teardown(), natsFixture?.teardown()]);
  });

  it('R60 — reports ready (200, every check up) when every dependency is reachable', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'up',
      checks: {
        writeModel: { status: 'up' },
        factStream: { status: 'up' },
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
        // Only the paused dependency goes down — factStream/rpcTransport
        // stay reachable throughout, proving the aggregation is genuinely
        // per-check, not a blanket failure.
        expect(res.body.checks.factStream).toEqual({ status: 'up' });
        expect(res.body.checks.rpcTransport).toEqual({ status: 'up' });

        // R60's own point: readiness is down, but liveness is UNAFFECTED —
        // the process is still alive, it is only withdrawn from traffic.
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
