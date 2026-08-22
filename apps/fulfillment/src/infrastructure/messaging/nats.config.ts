// COPY OF — apps/orders/src/infrastructure/messaging/nats.config.ts
// Connection configuration for the NATS RPC transport (see .env.example §
// NATS), read from the process environment — the same shape `db-config.ts`
// / `kafka.config.ts` already established.
export interface NatsConfig {
  readonly servers: readonly string[];
}

export function loadNatsConfig(env: NodeJS.ProcessEnv = process.env): NatsConfig {
  const servers = (env.NATS_URL ?? 'nats://localhost:4222')
    .split(',')
    .map((server) => server.trim())
    .filter((server) => server.length > 0);

  return { servers };
}
