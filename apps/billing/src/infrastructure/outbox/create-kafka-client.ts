// COPY OF — apps/orders/src/infrastructure/outbox/create-kafka-client.ts
// Wraps the real kafkajs `Kafka` client as the narrow `KafkaClientLike`
// surface `KafkaFactPublisher` depends on. The only file in this feature
// that imports `kafkajs` for its VALUE (not just its types) outside a test.
//
// D8 (review_orders_acceptance.md): the `test:integration` run prints
// `TimeoutNegativeWarning: <huge negative number> ... Timeout duration was
// set to 1.` a couple of times. Traced to kafkajs@2.2.4 itself, not this
// feature's code: `RequestQueue.scheduleCheckPendingRequests()`
// (node_modules/kafkajs/src/network/requestQueue/index.js) computes
// `scheduleAt = this.throttledUntil - Date.now()` and only clamps it to a
// safe positive fallback when `this.pending.length > 0`; called with an
// empty pending queue and the never-throttled default `throttledUntil = 0`
// (true whenever no broker has issued a throttle), `scheduleAt` stays
// `0 - Date.now()` — the exact magnitude/sign of the observed warning.
// Node clamps a negative `setTimeout` duration to 1ms itself, so this is
// cosmetic (a scary log line), not a functional bug: no request is ever
// scheduled early or dropped. kafkajs 2.2.4 is the latest stable release
// (2.3.0 is beta-only as of this writing) so there is no drop-in upstream
// fix to take; not something to patch in a vendored dependency from here.
import { Kafka } from 'kafkajs';
import type { KafkaClientLike } from './kafka-fact-publisher';
import type { KafkaConfig } from './kafka.config';

export function createKafkaClient(config: KafkaConfig): KafkaClientLike {
  return new Kafka({ clientId: config.clientId, brokers: [...config.brokers] });
}
