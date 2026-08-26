// The `DlqPublisher` adapter (OR1, OR3) — reuses the SAME
// `KafkaClientLike`/`KafkaProducerLike` structural surface
// `kafka-fact-publisher.ts` already established for the relay's own
// producer (design.md §4.1: "reuses the existing Kafka publisher client
// each service already has"), targeting `<sourceTopic>.dlq` with
// `asyncapi.yaml`'s `DeadLetterHeaders`. One shared producer instance
// serves both `FactRetryDispatcher.dispatch`'s DLQ step (OR1) and
// `SagaCommandDispatcher.park(...)`'s DLQ step (OR3) — never a third
// variant (design.md §4.2, point 2: "via the same DlqPublisher §4.1
// defines — reused, not a third variant").
import type { Envelope } from '@otc/contracts';
import type { DlqPublishMeta, DlqPublisher } from './fact-retry-dispatcher.js';
import { KAFKA_PRODUCER_CONFIG, KAFKA_SEND_ACKS, type KafkaClientLike, type KafkaProducerLike } from '../outbox/kafka-fact-publisher.js';
import { injectIntoStringHeaders } from '../observability/trace-context.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class KafkaDlqPublisher implements DlqPublisher {
  private readonly producer: KafkaProducerLike;
  private connected = false;

  constructor(client: KafkaClientLike) {
    this.producer = client.producer(KAFKA_PRODUCER_CONFIG);
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
  }

  async publish(sourceTopic: string, envelope: Envelope, meta: DlqPublishMeta): Promise<void> {
    await this.connect();
    const headers: Record<string, string> = {
      'x-failed-consumer': meta.failedConsumer,
      'x-attempts': String(meta.attempts),
      'x-error': errorMessage(meta.error),
      'x-original-topic': sourceTopic,
      'x-first-failed-at': meta.firstFailedAt.toISOString(),
      'x-failed-at': meta.failedAt.toISOString(),
      'x-event-type': envelope.eventType,
    };
    // OR4/R57 (design.md §4.3) — injects the CALLER's active trace context
    // (the fact-consume span `saga-facts.controller.ts`'s `route` wraps
    // `FactRetryDispatcher.dispatch` in, or `SagaCommandDispatcher.park`'s
    // own context for OR3's saga-command dead-letter) into the DLQ
    // message's headers, so a dead-lettered fact/command stays on the same
    // trace as the retries that preceded it, never a fresh one.
    injectIntoStringHeaders(headers);
    await this.producer.send({
      topic: `${sourceTopic}.dlq`,
      acks: KAFKA_SEND_ACKS,
      messages: [
        {
          key: envelope.correlationId,
          // The UNMODIFIED original envelope (OR1) — a redrive is a
          // byte-for-byte republish.
          value: JSON.stringify(envelope),
          headers,
        },
      ],
    });
  }
}
