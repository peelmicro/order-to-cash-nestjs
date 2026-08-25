// Connection configuration for the outbound NATS connection this service
// PUBLISHES the update signal on (design.md §7, PR17) — copied shape from
// apps/orders/src/infrastructure/messaging/nats.config.ts. Unlike Orders,
// this service never issues an RPC call on this connection — publish only,
// fire-and-forget, no reply subject, no responder (design.md §7.1's
// decision).
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
