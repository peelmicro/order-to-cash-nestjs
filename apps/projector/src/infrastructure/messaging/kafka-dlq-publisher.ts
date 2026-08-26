// The `DlqPublisher` adapter (OR1) — same shape as
// apps/orders/src/infrastructure/messaging/kafka-dlq-publisher.ts, but
// SELF-CONTAINED rather than importing `KAFKA_PRODUCER_CONFIG`/
// `KAFKA_SEND_ACKS`/`KafkaClientLike`/`KafkaProducerLike` from an
// `outbox/kafka-fact-publisher.ts` sibling: this service has no outbox (it
// consumes only, projector-facts.controller.ts's header), so there is no
// existing producer-config module to reuse. Not part of OI12's
// byte-identical check — only `fact-retry-dispatcher.ts` itself is the
// second canonical pair (design.md §4.1: "no second `.repository.ts`
// sibling — it has no store of its own"); this adapter is free to differ
// per service the way `kafka.config.ts` already does.
//
// Targets `<sourceTopic>.dlq` with `asyncapi.yaml`'s `DeadLetterHeaders` —
// same header set the canonical publishes, so a redrive tool works
// identically against every service's dead-letter topic.
import type { Envelope } from '@otc/contracts';
import type { DlqPublishMeta, DlqPublisher } from './fact-retry-dispatcher';
import { injectIntoStringHeaders } from '../observability/trace-context';

/** Mandatory (mirrors the outbox relay's own producer config across the codebase): a client-internal retry can neither reorder a partition's records nor create a broker-side duplicate the broker already accepted. */
const KAFKA_PRODUCER_CONFIG = {
  idempotent: true,
  maxInFlightRequests: 1,
} as const;

const KAFKA_SEND_ACKS = -1;

export interface KafkaMessage {
  readonly key: string;
  readonly value: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface KafkaSendRecord {
  readonly topic: string;
  readonly messages: KafkaMessage[];
  readonly acks: number;
}

export interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: KafkaSendRecord): Promise<unknown>;
}

export interface KafkaClientLike {
  producer(config: typeof KAFKA_PRODUCER_CONFIG): KafkaProducerLike;
}

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
    // OR4/R57 (design.md §4.3) — injects the caller's active trace context
    // (the fact-consume span `projector-facts.controller.ts`'s `route`
    // wraps `FactRetryDispatcher.dispatch` in) into the DLQ message's
    // headers, so a dead-lettered fact stays on the same trace as the
    // retries that preceded it, never a fresh one.
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
