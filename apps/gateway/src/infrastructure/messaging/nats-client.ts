// Wraps the real `nats` package's `connect()` — the only file besides
// `nats-rpc-client.adapter.ts` and `nats-stream-signal.adapter.ts` that
// imports `nats` for its value, mirroring
// apps/orders/src/infrastructure/messaging/nats-client.ts's role.
import { connect, type NatsConnection } from 'nats';
import type { NatsConfig } from './nats.config';

export function createNatsConnection(config: NatsConfig): Promise<NatsConnection> {
  return connect({ servers: [...config.servers] });
}
