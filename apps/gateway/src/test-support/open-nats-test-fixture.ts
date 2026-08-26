// Real NATS via Testcontainers, deliberately WITHOUT `@testcontainers/nats`'s
// `NatsContainer` — that package's constructor unconditionally sets `--user
// test --pass test` on the server (no opt-out), which is exactly why every
// OTHER real-`AppModule` harness in this repo (this service's own
// `gateway-app-test-harness.ts`, apps/orders', apps/billing's,
// apps/fulfillment's) never lets its `NATS_CONNECTION` provider go through
// the env-var-driven path at all — it OVERRIDES the provider directly with a
// connection object built from `nats.connect()` + the container's own
// `getConnectionOptions()`, entirely inside the test process.
//
// `stream-projector-e2e.integration.spec.ts` (feature 26, group E) cannot
// take that shortcut: half of its subjects is the REAL, unmodified
// `apps/projector` service, spawned as a genuine child process. That process
// opens its own outbound NATS connection purely from `NATS_URL`
// (`infrastructure/signal/nats.config.ts` / `nats-client.ts`, un-editable —
// out of this feature's scope) — a bare `connect({ servers })` with no way
// to inject credentials from outside the process's own environment. `nats`
// 2.29.3 never parses `user`/`pass` out of a `nats://user:pass@host:port`
// server URL either (verified by reading `nats-base-client/servers.js`:
// `ServerImpl` carries no `username`/`password` field at all), so even
// embedding them in `NATS_URL` would silently do nothing.
//
// The honest fix is to stand up the broker the way `docker-compose.infra.yml`
// actually runs it: `command: ["-p", "4222", "-m", "8222"]`, no auth flags at
// all (`docker-compose.infra.yml:189-204`) — core NATS, auth-free, which is
// MORE representative of the real deployment than the `test`/`test`-forced
// fixture every other integration spec in this service uses purely as a
// testing convenience. A `NatsTestFixture`-shaped object (same `connect()`/
// `teardown()` surface `gateway-app-test-harness.ts`'s `bootGatewayTestApp`
// already accepts) is returned so this fixture drops into that harness
// without any change to it, plus a bare `url` for handing to the spawned
// projector process's `NATS_URL`.
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { connect, type NatsConnection } from 'nats';

export const OPEN_NATS_IMAGE = 'nats:2.14.5-alpine';
const NATS_CLIENT_PORT = 4222;
const NATS_MONITOR_PORT = 8222;

export interface OpenNatsTestFixture {
  readonly container: StartedTestContainer;
  /** `host:port`, no scheme — what `nats.connect({ servers })` wants. */
  readonly servers: string;
  /** `nats://host:port` — what the spawned projector's `NATS_URL` env var wants. */
  readonly url: string;
  connect(): Promise<NatsConnection>;
  teardown(): Promise<void>;
}

export async function startOpenNatsTestFixture(): Promise<OpenNatsTestFixture> {
  const container = await new GenericContainer(OPEN_NATS_IMAGE)
    .withExposedPorts(NATS_CLIENT_PORT, NATS_MONITOR_PORT)
    .withCommand(['-p', String(NATS_CLIENT_PORT), '-m', String(NATS_MONITOR_PORT)])
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(NATS_CLIENT_PORT);
  const servers = `${host}:${port}`;

  return {
    container,
    servers,
    url: `nats://${servers}`,
    connect: () => connect({ servers: [servers] }),
    async teardown(): Promise<void> {
      await container.stop();
    },
  };
}
