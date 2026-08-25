// Wraps the real `nats` package's `connect()` — the only file in this
// service that imports `nats` for its VALUE (not just its types) outside a
// test, mirroring apps/orders/src/infrastructure/messaging/nats-client.ts's
// role. A plain `connect()`, no `ClientsModule`, no `ClientProxy` — for
// explicit control, as apps/orders established (design.md §8.1).
import { connect, type NatsConnection } from 'nats';
import type { NatsConfig } from './nats.config';

export function createNatsConnection(config: NatsConfig): Promise<NatsConnection> {
  return connect({ servers: [...config.servers] });
}
