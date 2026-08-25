// Boots the REAL `AppModule` — real MongoDB (the read model) via env vars
// pointed at a disposable Testcontainers fixture, same "env-var driven,
// single source of truth" pattern apps/projector's own
// `test-support/projector-app-test-harness.ts` establishes for Mongo. The
// outbound `NATS_CONNECTION` provider IS overridden, with a REAL,
// pre-connected fixture connection (`nats.connect()`) rather than going
// through the `NATS_URL` env-var path — `@testcontainers/nats`'s container
// requires the auth that connection already carries
// (`container.getConnectionOptions()`); a bare `NATS_URL` string
// reconnection fails "Authorization Violation" against it, the same
// reason every OTHER service's own integration harness in this repo
// (apps/orders/src/test-support/saga-integration-harness.ts, apps/billing's
// and apps/fulfillment's own copies) overrides `NATS_CONNECTION` directly
// instead. Exercised through `supertest` as an HTTP client only (CLAUDE.md
// Testing conventions).
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Db } from 'mongodb';
import type { NatsConnection } from 'nats';
import { AppModule, MONGO_DB, NATS_CONNECTION } from '../app.module';
import { NatsStreamSignalAdapter } from '../infrastructure/messaging/nats-stream-signal.adapter';
import type { MongoHandle } from '../infrastructure/persistence/mongo-client';
import { setupDocs } from '../presentation/setup-docs';
import { createValidationPipe } from '../presentation/validation-pipe';
import type { StandaloneMongoTestFixture } from './mongo-test-fixture';
import type { NatsTestFixture } from './nats-test-fixture';

export interface GatewayTestApp {
  readonly app: INestApplication;
  readonly db: Db;
  readonly natsConnection: NatsConnection;
  close(): Promise<void>;
}

/**
 * F5 (review) — integration tests set the operator credentials
 * EXPLICITLY rather than relying on `operator.config.ts`'s fallback
 * default, so a future change to that default cannot silently strand
 * every `POST /auth/login` call in this suite.
 */
export const TEST_OPERATOR_USERNAME = 'operator';
export const TEST_OPERATOR_PASSWORD = 'gateway-integration-test-operator-password';

function pointEnvAtFixtures(mongo: StandaloneMongoTestFixture, dbName: string): void {
  process.env.MONGO_HOST = mongo.host;
  process.env.MONGO_HOST_PORT = String(mongo.port);
  process.env.MONGO_DB_READMODEL = dbName;
  process.env.GATEWAY_RPC_TIMEOUT_MS = '2000';
  process.env.JWT_SECRET = 'gateway-integration-test-secret';
  process.env.GATEWAY_OPERATOR_USERNAME = TEST_OPERATOR_USERNAME;
  process.env.GATEWAY_OPERATOR_PASSWORD = TEST_OPERATOR_PASSWORD;
}

function clearEnv(): void {
  delete process.env.MONGO_HOST;
  delete process.env.MONGO_HOST_PORT;
  delete process.env.MONGO_DB_READMODEL;
  delete process.env.GATEWAY_RPC_TIMEOUT_MS;
  delete process.env.JWT_SECRET;
  delete process.env.GATEWAY_OPERATOR_USERNAME;
  delete process.env.GATEWAY_OPERATOR_PASSWORD;
}

export async function bootGatewayTestApp(
  mongo: StandaloneMongoTestFixture,
  nats: NatsTestFixture,
  dbName: string = mongo.db().databaseName,
): Promise<GatewayTestApp> {
  pointEnvAtFixtures(mongo, dbName);

  const natsConnection = await nats.connect();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NATS_CONNECTION)
    .useValue(natsConnection)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(createValidationPipe());
  setupDocs(app);
  await app.init();

  app.get(NatsStreamSignalAdapter).start();
  const { db } = app.get<MongoHandle>(MONGO_DB);

  return {
    app,
    db,
    natsConnection,
    async close(): Promise<void> {
      // `NatsConnectionCloser`'s `onApplicationShutdown` hook closes the
      // (overridden) `natsConnection` as part of `app.close()` — no
      // separate close call needed here.
      await app.close();
      clearEnv();
    },
  };
}
