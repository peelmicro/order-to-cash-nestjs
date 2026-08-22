// COPY OF — apps/orders/src/infrastructure/outbox/outbox-relay.config.ts
// Configuration for the outbox relay (design.md §8), read from the process
// environment (see .env.example § Outbox relay). Plain parts, explicit
// defaults, no DATABASE_URL-style interpolation — the same shape
// `db-config.ts` already established.
export interface OutboxRelayConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly publishTimeoutMs: number;
}

export function loadOutboxRelayConfig(env: NodeJS.ProcessEnv = process.env): OutboxRelayConfig {
  return {
    enabled: (env.OUTBOX_RELAY_ENABLED ?? 'true') !== 'false',
    pollIntervalMs: Number(env.OUTBOX_POLL_INTERVAL_MS ?? 250),
    batchSize: Number(env.OUTBOX_BATCH_SIZE ?? 100),
    publishTimeoutMs: Number(env.OUTBOX_PUBLISH_TIMEOUT_MS ?? 5000),
  };
}
