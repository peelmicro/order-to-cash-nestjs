// The AUTH-ENABLED, STANDALONE MongoDB fixture — `mongo.config.ts`'s
// `mongoConnectionUri` ALWAYS embeds a username/password (never
// `directConnection: true`, a test-only affordance), so the harness that
// boots the REAL `AppModule` needs a container that matches. Copied shape
// from apps/projector/src/test-support/mongo-test-fixture.ts's own
// `startAuthenticatedMongoTestFixture` — see that file's header for the
// full "why not @testcontainers/mongodb's MongoDBContainer" rationale
// (it always adds `--replSet rs0`, which the real `otc-mongodb` compose
// service is not).
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export const MONGO_IMAGE = 'mongo:8.3.8';
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
    .withEnvironment({ MONGO_INITDB_ROOT_USERNAME: MONGO_TEST_USERNAME, MONGO_INITDB_ROOT_PASSWORD: MONGO_TEST_PASSWORD })
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(MONGO_CONTAINER_PORT);
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
