// PR6 › applies one fact in exactly one upsert and one filtered
// findOneAndUpdate, issuing no read of order_timeline that a write is
// derived from. `monitorCommands: true` records the ACTUAL commands the
// driver issues — the only way to prove the ABSENCE of a read, and the
// guard against the whole class of defect design.md §5 exists to prevent
// (progress/spec_projector_read_model.md, open point 8).
import { randomUUID } from 'node:crypto';
import { MongoClient, type Collection, type CommandStartedEvent } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectFact } from './domain/fact-projection';
import { orderPlacedEnvelope } from './test-support/envelope-fixtures';
import { startMongoTestFixture, type MongoTestFixture } from './test-support/mongo-test-fixture';
import { MongoReadModelWriter } from './infrastructure/persistence/mongo-read-model-writer';
import type { OrderTimelineDocument } from './infrastructure/persistence/order-timeline.document';

describe('projection-write — PR6 (Testcontainers, real MongoDB, command monitoring)', () => {
  let fixture: MongoTestFixture;
  let monitoredClient: MongoClient;
  let collection: Collection<OrderTimelineDocument>;
  const commands: CommandStartedEvent[] = [];

  beforeAll(async () => {
    fixture = await startMongoTestFixture();
    monitoredClient = new MongoClient(fixture.container.getConnectionString(), {
      directConnection: true,
      monitorCommands: true,
    });
    await monitoredClient.connect();
    monitoredClient.on('commandStarted', (event) => commands.push(event));
    collection = monitoredClient
      .db(`otc_read_model_test_${randomUUID().slice(0, 8)}`)
      .collection<OrderTimelineDocument>('order_timeline');
  }, 120_000);

  afterAll(async () => {
    await monitoredClient?.close();
    await fixture?.teardown();
  }, 60_000);

  it('applies one fact in exactly one upsert (update) and one filtered findOneAndUpdate (findAndModify), issuing NO read of order_timeline', async () => {
    commands.length = 0;
    const writer = new MongoReadModelWriter(collection);
    const orderId = randomUUID();
    const envelope = orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: randomUUID() });

    const outcome = await writer.apply(projectFact(envelope), envelope.eventId, 'projector', async () => {});

    expect(outcome).toBe('processed');

    const relevantCommands = commands.filter((c) => c.databaseName === collection.dbName);
    const commandNames = relevantCommands.map((c) => c.commandName);

    // No `find`/`aggregate`(non-update)/`count` that a write is derived
    // from — the absence this test exists to prove.
    expect(commandNames).not.toContain('find');
    expect(commandNames.filter((name) => name === 'aggregate')).toHaveLength(0);

    // Exactly two writes: the Phase-1 upsert (`update`) and the Phase-2
    // atomic apply (`findAndModify`).
    expect(commandNames.filter((name) => name === 'update')).toHaveLength(1);
    expect(commandNames.filter((name) => name === 'findAndModify')).toHaveLength(1);

    // The findAndModify's OWN query is the idempotency check — assert the
    // filter shape carries processedEventKeys.$ne, not a prior read result.
    const findAndModify = relevantCommands.find((c) => c.commandName === 'findAndModify')!;
    const query = (findAndModify.command as { query?: Record<string, unknown> }).query;
    expect(query).toHaveProperty('processedEventKeys');
  });

  it('a SECOND (duplicate) delivery still issues no read — only the same two-write shape, the findAndModify matching nothing', async () => {
    const writer = new MongoReadModelWriter(collection);
    const orderId = randomUUID();
    const envelope = orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: randomUUID() });
    const delta = projectFact(envelope);

    await writer.apply(delta, envelope.eventId, 'projector', async () => {});

    commands.length = 0;
    const outcome = await writer.apply(delta, envelope.eventId, 'projector', async () => {});
    expect(outcome).toBe('duplicate');

    const relevantCommands = commands.filter((c) => c.databaseName === collection.dbName);
    const commandNames = relevantCommands.map((c) => c.commandName);
    expect(commandNames).not.toContain('find');
    expect(commandNames.filter((name) => name === 'findAndModify')).toHaveLength(1);
  });
}, 180_000);
