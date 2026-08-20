// OI7 — the producer is configured so a client-internal retry can neither
// reorder nor duplicate a partition's records. Unit level: asserted on the
// constructed producer config and the send-time acks, via a plain fake
// `KafkaClientLike` — never a mocked broker.
import { describe, expect, it, vi } from 'vitest';
import type { PublishableFact } from '../../application/ports/fact-publisher.port';
import {
  KAFKA_PRODUCER_CONFIG,
  KAFKA_SEND_ACKS,
  KafkaFactPublisher,
  type KafkaClientLike,
  type KafkaProducerLike,
  type KafkaSendRecord,
} from './kafka-fact-publisher';

function fakeProducer(): KafkaProducerLike & { sent: KafkaSendRecord[] } {
  const sent: KafkaSendRecord[] = [];
  return {
    sent,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async (record: KafkaSendRecord) => {
      sent.push(record);
      return [];
    }),
  };
}

function fact(overrides: Partial<PublishableFact> = {}): PublishableFact {
  return {
    key: 'order-1',
    envelope: {
      eventId: 'e1',
      eventType: 'order.placed.v1',
      aggregateId: 'order-1',
      correlationId: 'order-1',
      causationId: 'c1',
      occurredAt: '2026-08-20T10:00:00.000Z',
      payload: { orderReference: 'ORD-000001' },
    },
    headers: { 'x-event-type': 'order.placed.v1', 'content-type': 'application/json' },
    ...overrides,
  };
}

describe('KafkaFactPublisher — OI7: configures the producer so an internal retry can neither reorder nor duplicate a partition\'s records', () => {
  it('configures the producer so an internal retry can neither reorder nor duplicate a partition\'s records', async () => {
    const producer = fakeProducer();
    let capturedConfig: unknown;
    const client: KafkaClientLike = {
      producer: (config) => {
        capturedConfig = config;
        return producer;
      },
    };

    const publisher = new KafkaFactPublisher(client);
    await publisher.publish([fact()]);

    // idempotent: true is the switch; maxInFlightRequests: 1 removes the
    // last window in which a client-internal retry could reorder a
    // partition even under an idempotent producer.
    expect(capturedConfig).toEqual({ idempotent: true, maxInFlightRequests: 1 });
    expect(KAFKA_PRODUCER_CONFIG).toEqual({ idempotent: true, maxInFlightRequests: 1 });

    // acks: -1 (ISR-wide acknowledgement) is idempotent's own required
    // level — sent explicitly rather than left to a default.
    expect(KAFKA_SEND_ACKS).toBe(-1);
    expect(producer.sent[0]?.acks).toBe(-1);
  });

  it('keys every message by the fact\'s partition key and mirrors eventType/content-type headers', async () => {
    const producer = fakeProducer();
    const client: KafkaClientLike = { producer: () => producer };
    const publisher = new KafkaFactPublisher(client);

    await publisher.publish([fact({ key: 'order-42' })]);

    expect(producer.sent[0]?.messages[0]?.key).toBe('order-42');
    expect(producer.sent[0]?.messages[0]?.headers['x-event-type']).toBe('order.placed.v1');
    expect(producer.sent[0]?.messages[0]?.headers['content-type']).toBe('application/json');
  });

  it('publishes to the one Orders fact topic (design.md §5.3 — topic-per-service)', async () => {
    const producer = fakeProducer();
    const client: KafkaClientLike = { producer: () => producer };
    const publisher = new KafkaFactPublisher(client);

    await publisher.publish([fact()]);

    expect(producer.sent[0]?.topic).toBe('otc.orders.facts.v1');
  });

  it('never calls send for an empty batch', async () => {
    const producer = fakeProducer();
    const client: KafkaClientLike = { producer: () => producer };
    const publisher = new KafkaFactPublisher(client);

    await publisher.publish([]);

    expect(producer.send).not.toHaveBeenCalled();
  });

  it('connects at most once across repeated publish calls', async () => {
    const producer = fakeProducer();
    const client: KafkaClientLike = { producer: () => producer };
    const publisher = new KafkaFactPublisher(client);

    await publisher.publish([fact()]);
    await publisher.publish([fact()]);

    expect(producer.connect).toHaveBeenCalledTimes(1);
  });
});
