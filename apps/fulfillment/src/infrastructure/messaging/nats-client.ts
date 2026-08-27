// COPY OF — apps/orders/src/infrastructure/messaging/nats-client.ts
// Wraps the real `nats` package's `connect()`. Opened SOLELY for R60/OR6's
// RPC-transport readiness probe (design.md §4.6's table: Fulfillment has no
// outbound RPC call of its own in this feature — app.module.ts's own header
// comment — but readiness still needs a live `NatsConnection` to ping).
import { connect, type NatsConnection } from 'nats';
import type { NatsConfig } from './nats.config';

export function createNatsConnection(config: NatsConfig): Promise<NatsConnection> {
  return connect({ servers: [...config.servers] });
}
