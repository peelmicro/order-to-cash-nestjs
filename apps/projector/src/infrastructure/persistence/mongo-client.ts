// Wraps the real `mongodb` package's `MongoClient` — the only file in this
// service (besides mongo-read-model-writer.ts) that imports `mongodb` for
// its VALUE, mirroring `nats-client.ts`'s role for the `nats` package.
import { MongoClient, type Collection, type Db } from 'mongodb';
import { ORDER_TIMELINE_COLLECTION } from './read-model-indexes';
import { mongoConnectionUri, type MongoConfig } from './mongo.config';
import type { OrderTimelineDocument } from './order-timeline.document';

export interface MongoHandle {
  readonly client: MongoClient;
  readonly db: Db;
}

export async function connectMongo(config: MongoConfig): Promise<MongoHandle> {
  const client = new MongoClient(mongoConnectionUri(config));
  await client.connect();
  return { client, db: client.db(config.database) };
}

export function orderTimelineCollection(db: Db): Collection<OrderTimelineDocument> {
  return db.collection<OrderTimelineDocument>(ORDER_TIMELINE_COLLECTION);
}
