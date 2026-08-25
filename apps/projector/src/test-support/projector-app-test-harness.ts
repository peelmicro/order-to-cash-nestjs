// Boots the REAL `AppModule` (real MongoDB via env vars pointed at a
// Testcontainers fixture, real Kafka microservice transport) for the G
// group specs (design.md §10, tasks.md group G — R50-R53), which are about
// Kafka+MongoDB, never about the update signal. `NATS_CONNECTION`
// (app.module.ts, exported for exactly this reason) is overridden with a
// countable fake, so these specs need no NATS broker at all — the signal
// itself (PR17-PR19) is proved separately, against REAL NATS, by
// infrastructure/signal/update-signal.integration.spec.ts.
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { Db } from 'mongodb';
import { AppModule, MONGO_DB, NATS_CONNECTION } from '../app.module';
import { ensureReadModelIndexes } from '../infrastructure/persistence/read-model-indexes';
import type { MongoHandle } from '../infrastructure/persistence/mongo-client';
import type { StandaloneMongoTestFixture } from './mongo-test-fixture';
import type { KafkaTestFixture } from './kafka-test-fixture';
import { waitForConsumerGroupReady } from './kafka-test-fixture';

export interface FakeNatsConnection {
  readonly publishCalls: { subject: string; data: Uint8Array }[];
  publish(subject: string, data: Uint8Array): void;
  close(): Promise<void>;
}

function makeFakeNatsConnection(): FakeNatsConnection {
  const publishCalls: { subject: string; data: Uint8Array }[] = [];
  return {
    publishCalls,
    publish: (subject, data) => {
      publishCalls.push({ subject, data });
    },
    close: async () => {},
  };
}

export interface ProjectorTestApp {
  readonly app: INestApplication;
  readonly db: Db;
  readonly dbName: string;
  readonly nats: FakeNatsConnection;
  close(): Promise<void>;
}

/**
 * Points the REAL, unmodified `mongo.config.ts`/`kafka.config.ts` loaders at
 * the disposable fixtures — same "env-var driven, single source of truth"
 * pattern every service in this codebase uses (apps/notifications' own
 * harness comment). `MONGO_INITDB_ROOT_USERNAME`/`PASSWORD` are deliberately
 * LEFT AT THEIR DEFAULTS (`otc_mongo_root`/`otc_mongo_dev_password`) — the
 * caller MUST use `startAuthenticatedMongoTestFixture` (mongo-test-fixture.ts),
 * whose container is configured with exactly those same credentials.
 */
function pointEnvAtFixtures(mongoHost: string, mongoHostPort: number, mongoDatabase: string): void {
  process.env.MONGO_HOST = mongoHost;
  process.env.MONGO_HOST_PORT = String(mongoHostPort);
  process.env.MONGO_DB_READMODEL = mongoDatabase;
}

function clearEnv(): void {
  delete process.env.MONGO_HOST;
  delete process.env.MONGO_HOST_PORT;
  delete process.env.MONGO_DB_READMODEL;
}

export async function bootProjectorTestApp(
  mongo: StandaloneMongoTestFixture,
  kafka: KafkaTestFixture,
  groupId: string,
  // Optional: reuse a SPECIFIC database name across two separate boots
  // (replay-determinism.integration.spec.ts's step 2/3 — drop the
  // collection, then reconsume into the SAME database with a fresh Nest
  // app and a fresh consumer group). Defaults to a fresh random name, same
  // as every other G-group spec needs.
  dbName: string = mongo.db().databaseName,
): Promise<ProjectorTestApp> {
  pointEnvAtFixtures(mongo.host, mongo.port, dbName);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NATS_CONNECTION)
    .useValue(makeFakeNatsConnection())
    .compile();

  const app = moduleRef.createNestApplication();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: { clientId: `otc-projector-test-${groupId}`, brokers: [...kafka.brokers] },
      consumer: { groupId, sessionTimeout: 30000 },
      subscribe: { fromBeginning: true },
      run: { partitionsConsumedConcurrently: 1 },
    },
  });
  await app.startAllMicroservices();
  await app.init();

  // ServerKafka appends `-server` to the configured groupId unconditionally
  // (same finding apps/notifications' own harness records).
  await waitForConsumerGroupReady(kafka.brokers, `${groupId}-server`);

  const { db: realDb } = app.get<MongoHandle>(MONGO_DB);
  await ensureReadModelIndexes(realDb);

  const nats = app.get<FakeNatsConnection>(NATS_CONNECTION);

  return {
    app,
    db: realDb,
    dbName,
    nats,
    async close(): Promise<void> {
      await app.close();
      clearEnv();
    },
  };
}
