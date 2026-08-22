// BC16 — the relay's poll/claim/publish/stamp cycle against real MySQL
// (Testcontainers, mysql:8.4.11) AND real Kafka (Testcontainers,
// apache/kafka:4.3.1, 6-partition topic). Proves the facts of a REAL credit
// hold transaction leave Billing's own outbox and land on
// `otc.billing.facts.v1`, keyed by `correlationId`, stamped `publishedAt`
// only after the broker acknowledges.
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import { Kafka, type Consumer } from 'kafkajs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { DrizzleBuyerCreditRepository } from '../persistence/buyer-credit.repository';
import * as billingSchema from '../persistence/schema/index';
import { startBillingTestFixture, type BillingTestFixture } from '../persistence/test-support/billing-test-fixture';
import { createKafkaClient } from './create-kafka-client';
import { KafkaFactPublisher } from './kafka-fact-publisher';
import { BILLING_FACTS_TOPIC } from './kafka.config';
import { OutboxRelay } from './outbox-relay';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from './test-support/kafka-test-fixture';

const fixedClock = { now: () => new Date('2026-08-21T10:00:00.000Z') };
const CURRENCY = 'EUR';

describe('outbox-relay — BC16 (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1)', () => {
  let mysqlFixture: BillingTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let realPublisher: KafkaFactPublisher;
  const consumers: Consumer[] = [];

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture] = await Promise.all([startBillingTestFixture(), startKafkaTestFixture()]);
    await createTopic(kafkaFixture.brokers, BILLING_FACTS_TOPIC);
    realPublisher = new KafkaFactPublisher(createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-billing-test' }));
  }, 300_000);

  afterEach(async () => {
    for (const consumer of consumers.splice(0)) {
      await consumer.disconnect();
    }
  });

  afterAll(async () => {
    await realPublisher?.disconnect();
    await mysqlFixture?.teardown();
    await kafkaFixture?.teardown();
  }, 120_000);

  async function consumeForKey(key: string, groupId: string): Promise<{ key: string; value: string }[]> {
    const kafka = new Kafka({ clientId: 'otc-billing-test-consumer', brokers: [...kafkaFixture.brokers] });
    const consumer = kafka.consumer({ groupId });
    consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: BILLING_FACTS_TOPIC, fromBeginning: true });

    const received: { key: string; value: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`consumeForKey: timed out waiting for a message keyed ${key}`)), 30_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            const messageKey = message.key?.toString() ?? '';
            if (messageKey !== key) {
              return;
            }
            received.push({ key: messageKey, value: message.value?.toString() ?? '' });
            clearTimeout(timeout);
            resolve();
          },
        })
        .catch(reject);
    });
    return received;
  }

  it('publishes the facts of a credit hold transaction to otc.billing.facts.v1 keyed by correlationId and stamps publishedAt only after acknowledgement', async () => {
    const repository = new DrizzleBuyerCreditRepository(mysqlFixture.db, fixedClock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const creditId = randomUUID();
    const now = fixedClock.now();
    await mysqlFixture.db.insert(billingSchema.credits).values({
      id: creditId,
      code: 'CR-900001',
      retailerCode: 'RET-BC16',
      companyCode: 'COM-BC16',
      creditLimit: 100_000,
      currencyCode: CURRENCY,
      createdAt: now,
      updatedAt: now,
    });
    const orderReference = OrderNumber.fromSequence(1);
    const correlationId = UniqueId.generate();

    await unitOfWork.execute(async (tx) => {
      const credit = await repository.lockForOrder(tx, 'RET-BC16', 'COM-BC16', orderReference);
      credit!.approveHold(
        { orderReference, amount: Money.of(10_000, CURRENCY), correlationId },
        { occurredAt: fixedClock.now(), causationId: UniqueId.generate() },
        () => UniqueId.generate(),
      );
      await repository.save(credit!, tx);
    });

    const [rowBeforePublish] = await mysqlFixture.db
      .select()
      .from(billingSchema.outbox)
      .where(eq(billingSchema.outbox.aggregateId, creditId));
    expect(rowBeforePublish?.publishedAt).toBeNull();
    expect(rowBeforePublish?.correlationId).toBe(correlationId.value);

    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: realPublisher,
      clock: fixedClock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });
    const result = await relay.runOnce();
    expect(result.published).toBe(1);

    const [rowAfterPublish] = await mysqlFixture.db
      .select()
      .from(billingSchema.outbox)
      .where(eq(billingSchema.outbox.aggregateId, creditId));
    expect(rowAfterPublish?.publishedAt).not.toBeNull();

    const received = await consumeForKey(correlationId.value, `bc16-${UniqueId.generate().value}`);
    expect(received).toHaveLength(1);
    const envelope = JSON.parse(received[0]!.value) as { eventType: string; correlationId: string; eventId: string };
    expect(envelope.eventType).toBe('credit.approved.v1');
    expect(envelope.correlationId).toBe(correlationId.value);
    expect(envelope.eventId).toBe(rowAfterPublish!.eventId);
  }, 60_000);
});
