// COPY OF — apps/orders/src/infrastructure/outbox/outbox-relay.config.ts
// Configuration for the outbox relay (design.md §8, §12), read from the
// process environment (see .env.example § Outbox relay). Both services'
// relays read the same four `OUTBOX_*` values — a per-service override is
// not needed until one is tuned differently (design.md §12, open point).
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
