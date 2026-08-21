// Wraps the real `nats` package's `connect()` — the only file in this
// feature that imports `nats` for its VALUE (not just its types) outside a
// test, mirroring `create-kafka-client.ts`'s role for kafkajs.
import { connect, type NatsConnection } from 'nats';
import type { NatsConfig } from './nats.config';

export function createNatsConnection(config: NatsConfig): Promise<NatsConnection> {
  return connect({ servers: [...config.servers] });
}
