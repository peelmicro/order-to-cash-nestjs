// Shared Testcontainers fixture for every real-MongoDB integration spec in
// this service — `mongo:8.3.8`, the SAME pinned tag docker-compose.infra.yml
// and apps/seed's own seed.integration.spec.ts use. Standalone (no replica
// set): `$sortArray` (design.md §5.3) needs MongoDB 5.2+, which this image
// satisfies, and this service never uses a multi-document transaction
// (design.md §5.4 — rejected deliberately: the stack runs standalone).
import { randomUUID } from 'node:crypto';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient, type Db } from 'mongodb';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export const MONGO_IMAGE = 'mongo:8.3.8';

export interface MongoTestFixture {
  readonly container: StartedMongoDBContainer;
  readonly client: MongoClient;
  db(): Db;
  teardown(): Promise<void>;
}

export async function startMongoTestFixture(): Promise<MongoTestFixture> {
  const container = await new MongoDBContainer(MONGO_IMAGE).start();
  const client = new MongoClient(container.getConnectionString(), { directConnection: true });
  await client.connect();

  return {
    container,
    client,
    db: () => client.db(`otc_read_model_test_${randomUUID().slice(0, 8)}`),
    async teardown(): Promise<void> {
      await client.close();
      await container.stop();
    },
  };
}

/**
 * The AUTH-ENABLED, STANDALONE variant — for `test-support/projector-app-test-harness.ts`,
 * which boots the REAL `AppModule` through `loadMongoConfig()`'s env-var
 * path (`mongo.config.ts`'s `mongoConnectionUri`, always embedding a
 * username/password, and NEVER passing `directConnection: true` — that is
 * a test-only affordance, not something production code should carry).
 *
 * Deliberately NOT `@testcontainers/mongodb`'s `MongoDBContainer`: that
 * helper ALWAYS adds `--replSet rs0` (verified against its source, whether
 * or not auth is configured), and a replica-set member advertises ITS OWN
 * container hostname during SDAM topology discovery — unreachable from the
 * test host (`getaddrinfo EAI_AGAIN <container-id>`), and only avoidable
 * with `directConnection: true`, which production code does not use. The
 * REAL `otc-mongodb` compose service (docker-compose.infra.yml) is
 * STANDALONE, no `--replSet` — so a standalone container, built directly
 * from the SAME pinned `mongo:8.3.8` image with the SAME
 * `MONGO_INITDB_ROOT_USERNAME`/`PASSWORD` env vars compose uses, is the
 * fixture that actually matches what `connectMongo()` talks to in
 * production, and is what makes this harness able to use PRODUCTION code
 * unmodified.
 */
export const MONGO_TEST_USERNAME = 'otc_mongo_root';
export const MONGO_TEST_PASSWORD = 'otc_mongo_dev_password';

const MONGO_CONTAINER_PORT = 27017;

export interface StandaloneMongoTestFixture {
  readonly container: StartedTestContainer;
  readonly host: string;
  readonly port: number;
  readonly client: MongoClient;
  db(): Db;
  teardown(): Promise<void>;
}

export async function startAuthenticatedMongoTestFixture(): Promise<StandaloneMongoTestFixture> {
  const container = await new GenericContainer(MONGO_IMAGE)
    .withExposedPorts(MONGO_CONTAINER_PORT)
    .withEnvironment({
      MONGO_INITDB_ROOT_USERNAME: MONGO_TEST_USERNAME,
      MONGO_INITDB_ROOT_PASSWORD: MONGO_TEST_PASSWORD,
    })
    // The official mongo image's entrypoint, when
    // MONGO_INITDB_ROOT_USERNAME/PASSWORD are set, starts a TEMPORARY
    // no-auth mongod to run init scripts (creating the root user) — which
    // ALSO logs "Waiting for connections" — before shutting it down and
    // starting the REAL, auth-enabled mongod. Waiting for the FIRST
    // occurrence connects to the temporary instance moments before it
    // shuts down (`connection <monitor> ... closed`, found live). The
    // SECOND occurrence is the real server.
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(MONGO_CONTAINER_PORT);
  // ONE shared, already-connected client — every `db()` call below reuses
  // it (a fresh database name each time), same "one client, many logical
  // databases" shape `startMongoTestFixture` above uses.
  const client = new MongoClient(
    `mongodb://${MONGO_TEST_USERNAME}:${MONGO_TEST_PASSWORD}@${host}:${port}/?authSource=admin`,
    { directConnection: true },
  );
  await client.connect();

  return {
    container,
    host,
    port,
    client,
    db: () => client.db(`otc_read_model_test_${randomUUID().slice(0, 8)}`),
    async teardown(): Promise<void> {
      await client.close();
      await container.stop();
    },
  };
}
