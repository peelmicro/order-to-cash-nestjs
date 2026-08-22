// COPY OF — apps/orders/src/infrastructure/messaging/nats.config.ts
// Connection configuration for the NATS RPC transport (see .env.example §
// NATS), read from the process environment — the same shape `db-config.ts`
// / `kafka.config.ts` already established. `NATS_URL` mirrors
// `KAFKA_BROKERS`'s "host access from outside a container" convention.
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

/** How long the outbound `fulfillment.stock.check` RPC call waits for a reply before it is treated as a timeout (`StockCheckTimeoutError`) — explicit per-call budget, never a hang (saga.md §1). */
export function loadStockCheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.STOCK_CHECK_TIMEOUT_MS ?? 5000);
}
