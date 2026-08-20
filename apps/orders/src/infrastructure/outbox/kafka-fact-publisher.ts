// The relay's kafkajs producer adapter (design.md §5.3). kafkajs directly,
// not `@nestjs/microservices` `ClientKafka`: the relay needs explicit
// control of the partition key, the idempotent-producer flags and the
// acknowledgement point, all of which `ClientKafka` abstracts away.
//
// `KafkaClientLike`/`KafkaProducerLike` are the minimal structural surface
// this adapter needs from kafkajs's `Kafka`/`Producer` — narrow on purpose,
// so `kafka-fact-publisher.spec.ts` (OI7) can assert on the constructed
// producer config with a plain fake, never a mocked broker.
import type { FactPublisher, PublishableFact } from '../../application/ports/fact-publisher.port';
import { ORDERS_FACTS_TOPIC } from './kafka.config';

/**
 * Mandatory (OI7): a client-internal retry can neither reorder a
 * partition's records nor create a broker-side duplicate of a record the
 * broker already accepted. `idempotent: true` is the switch; the send-time
 * `acks: -1` below is idempotent's own required acknowledgement level, made
 * explicit rather than left to a default so a test can see it.
 */
export const KAFKA_PRODUCER_CONFIG = {
  idempotent: true,
  maxInFlightRequests: 1,
} as const;

export const KAFKA_SEND_ACKS = -1;

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

export class KafkaFactPublisher implements FactPublisher {
  private readonly producer: KafkaProducerLike;
  private connected = false;

  constructor(client: KafkaClientLike, private readonly topic: string = ORDERS_FACTS_TOPIC) {
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

  /** Resolves only when the broker has acknowledged every fact (R14); one topic per service (design.md §5.3), so one cycle is a single producer.send. */
  async publish(facts: readonly PublishableFact[]): Promise<void> {
    if (facts.length === 0) {
      return;
    }
    await this.connect();
    await this.producer.send({
      topic: this.topic,
      acks: KAFKA_SEND_ACKS,
      messages: facts.map((fact) => ({
        key: fact.key,
        value: JSON.stringify(fact.envelope),
        headers: fact.headers,
      })),
    });
  }
}
