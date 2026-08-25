// Shared Testcontainers fixture — real NATS, `nats:2.14.5-alpine`, the SAME
// pinned tag `docker-compose.infra.yml` uses, core-only (no JetStream — the
// update signal is deliberately at-most-once, design.md §7.1). Copied shape
// from apps/orders/src/infrastructure/messaging/test-support/nats-test-fixture.ts.
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
