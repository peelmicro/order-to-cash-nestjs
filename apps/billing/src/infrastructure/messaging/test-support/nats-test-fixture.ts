// COPY OF — apps/orders/src/infrastructure/messaging/test-support/nats-test-fixture.ts
// Shared Testcontainers fixture for the orders_acceptance integration
// specs — real NATS, `nats:2.14.5-alpine`, the SAME pinned tag
// `docker-compose.infra.yml` uses, core-only (no JetStream — this feature
// never calls `.withJetStream()`, mirroring the compose service's own
// `-p 4222 -m 8222` command with no JetStream flag).
//
// The "two-daemon quirk" noted in README.md ("if you run more than one
// Docker daemon... the integration tests can therefore run against a
// different daemon than your compose stack") is environmental — this
// fixture starts its OWN disposable container via Testcontainers, entirely
// independent of whatever `docker-compose.infra.yml` has running.
import { NatsContainer, type StartedNatsContainer } from '@testcontainers/nats';
import { connect, type NatsConnection } from 'nats';

export const NATS_IMAGE = 'nats:2.14.5-alpine';

export interface NatsTestFixture {
  readonly container: StartedNatsContainer;
  readonly servers: string;
  connect(): Promise<NatsConnection>;
  teardown(): Promise<void>;
}

export async function startNatsTestFixture(): Promise<NatsTestFixture> {
  const container = await new NatsContainer(NATS_IMAGE).start();
  const options = container.getConnectionOptions();
  const servers = typeof options.servers === 'string' ? options.servers : options.servers![0]!;

  return {
    container,
    servers,
    connect: () => connect(options),
    async teardown(): Promise<void> {
      await container.stop();
    },
  };
}
