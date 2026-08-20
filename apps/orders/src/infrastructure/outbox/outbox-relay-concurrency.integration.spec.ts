// OI4, OI5 — the relay is safe under concurrent instances (disjoint claims,
// no double publish) and self-heals from a crashed instance without a
// lease wait. Real MySQL only (Testcontainers, mysql:8.4.11) — the point
// here is the SKIP LOCKED claim, not the broker, so a fake publisher.
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/mysql2';
import { isNull } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FactPublisher, PublishableFact } from '../../application/ports/fact-publisher.port';
import * as ordersSchema from '../persistence/schema/index';
import type { OrdersDb } from '../persistence/client';
import {
  startOrdersTestFixture,
  type OrdersTestFixture,
} from '../persistence/test-support/orders-test-fixture';
import { FakeClock } from '../persistence/test-support/fake-clock';
import { OutboxRelay } from './outbox-relay';

class RecordingFactPublisher implements FactPublisher {
  readonly publishedKeys: string[] = [];

  async publish(facts: readonly PublishableFact[]): Promise<void> {
    for (const fact of facts) {
      this.publishedKeys.push(fact.envelope.eventId);
    }
  }
}

/** Inserts `n` unpublished outbox rows for `n` distinct synthetic orders, bypassing the aggregate — the point of this file is the claim, not the aggregate. */
async function insertUnpublishedRows(db: OrdersDb, n: number): Promise<string[]> {
  const now = new Date('2026-08-20T16:00:00.000Z');
  const eventIds: string[] = [];
  const rows = Array.from({ length: n }, () => {
    const aggregateId = randomUUID();
    const eventId = randomUUID();
    eventIds.push(eventId);
    return {
      id: randomUUID(),
      eventId,
      eventType: 'order.placed.v1',
      aggregateId,
      correlationId: aggregateId,
      causationId: randomUUID(),
      payload: { orderReference: `ORD-${eventId.slice(0, 6)}` },
      occurredAt: now,
      publishedAt: null,
      createdAt: now,
    };
  });
  await db.insert(ordersSchema.outbox).values(rows);
  return eventIds;
}

describe('outbox-relay-concurrency — OI4, OI5 (Testcontainers, mysql:8.4.11)', () => {
  let fixture: OrdersTestFixture;

  beforeAll(async () => {
    fixture = await startOrdersTestFixture();
  }, 120_000);

  beforeEach(async () => {
    // Isolate each test from the others' rows.
    await fixture.db.delete(ordersSchema.outbox);
  });

  afterAll(async () => {
    await fixture?.teardown();
  });

  it('grants disjoint batches to two concurrent relay instances and publishes every record exactly once', async () => {
    const totalRows = 40;
    const batchSize = 5;
    const eventIds = await insertUnpublishedRows(fixture.db, totalRows);

    // Two relay instances on SEPARATE connections against the one MySQL
    // container.
    const poolA = mysql.createPool({
      host: fixture.container.getHost(),
      port: fixture.container.getPort(),
      user: fixture.container.getUsername(),
      password: fixture.container.getUserPassword(),
      database: fixture.container.getDatabase(),
      timezone: 'Z',
    });
    const poolB = mysql.createPool({
      host: fixture.container.getHost(),
      port: fixture.container.getPort(),
      user: fixture.container.getUsername(),
      password: fixture.container.getUserPassword(),
      database: fixture.container.getDatabase(),
      timezone: 'Z',
    });
    const dbA = drizzle(poolA, { schema: ordersSchema, mode: 'default' });
    const dbB = drizzle(poolB, { schema: ordersSchema, mode: 'default' });

    const publisherA = new RecordingFactPublisher();
    const publisherB = new RecordingFactPublisher();
    const clock = new FakeClock(new Date('2026-08-20T16:00:00.000Z'));
    const relayA = new OutboxRelay({
      db: dbA,
      publisher: publisherA,
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize, publishTimeoutMs: 5000 },
    });
    const relayB = new OutboxRelay({
      db: dbB,
      publisher: publisherB,
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize, publishTimeoutMs: 5000 },
    });

    try {
      // Drain concurrently: repeated concurrent poll rounds until both
      // instances report nothing left to claim.
      for (let round = 0; round < 40; round++) {
        const [resultA, resultB] = await Promise.all([relayA.runOnce(), relayB.runOnce()]);
        if (resultA.claimed === 0 && resultB.claimed === 0) {
          break;
        }
      }
    } finally {
      await poolA.end();
      await poolB.end();
    }

    // Every record published exactly once: the union of what each
    // instance published is every row, and the intersection is empty.
    const setA = new Set(publisherA.publishedKeys);
    const setB = new Set(publisherB.publishedKeys);
    expect(setA.size).toBe(publisherA.publishedKeys.length); // A never published its own key twice
    expect(setB.size).toBe(publisherB.publishedKeys.length);
    const intersection = [...setA].filter((key) => setB.has(key));
    expect(intersection).toEqual([]);

    const union = new Set([...setA, ...setB]);
    expect(union.size).toBe(totalRows);
    expect([...union].sort()).toEqual([...eventIds].sort());

    const stillUnpublished = await fixture.db.select().from(ordersSchema.outbox).where(isNull(ordersSchema.outbox.publishedAt));
    expect(stillUnpublished).toHaveLength(0);
  }, 60_000);

  it('returns records claimed by a relay that died before stamping to the next poll without a lease wait', async () => {
    const eventIds = await insertUnpublishedRows(fixture.db, 5);

    // The "dying" relay: a raw connection claims the batch with the SAME
    // predicate the relay uses, then is DESTROYED — after claim, before
    // stamp — never committing and never rolling back cleanly.
    const dyingConnection = await mysql.createConnection({
      host: fixture.container.getHost(),
      port: fixture.container.getPort(),
      user: fixture.container.getUsername(),
      password: fixture.container.getUserPassword(),
      database: fixture.container.getDatabase(),
      timezone: 'Z',
    });
    await dyingConnection.beginTransaction();
    const [claimedRows] = await dyingConnection.query<mysql.RowDataPacket[]>(
      `SELECT id, event_id FROM outbox WHERE published_at IS NULL ORDER BY seq ASC LIMIT 5 FOR UPDATE SKIP LOCKED`,
    );
    expect(claimedRows).toHaveLength(5);
    dyingConnection.destroy(); // no rollback(), no commit() — the simulated crash.

    // A second instance, no sleep, no sweeper — its very next poll must
    // claim exactly these records.
    const publisher = new RecordingFactPublisher();
    const relay = new OutboxRelay({
      db: fixture.db,
      publisher,
      clock: new FakeClock(new Date('2026-08-20T16:00:00.000Z')),
      config: { enabled: true, pollIntervalMs: 0, batchSize: 5, publishTimeoutMs: 5000 },
    });
    const result = await relay.runOnce();

    expect(result.claimed).toBe(5);
    expect(result.published).toBe(5);
    expect(publisher.publishedKeys.sort()).toEqual([...eventIds].sort());

    const remaining = await fixture.db.select().from(ordersSchema.outbox).where(isNull(ordersSchema.outbox.publishedAt));
    expect(remaining).toHaveLength(0);
  }, 60_000);
});
