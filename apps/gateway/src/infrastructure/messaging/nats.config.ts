// Connection configuration for the outbound NATS RPC transport — same
// shape apps/orders/src/infrastructure/messaging/nats.config.ts and
// apps/projector's own copy establish.
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

/** Default per-call RPC deadline — every command/query handler's `RpcClient.call()` falls back to this unless it passes its own. */
export function loadRpcTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.GATEWAY_RPC_TIMEOUT_MS ?? 5000);
}
