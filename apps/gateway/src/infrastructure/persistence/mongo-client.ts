// Wraps the real `mongodb` package's `MongoClient` — the only file besides
// `mongo-order-read-model.adapter.ts` that imports `mongodb` for its
// VALUE, mirroring `apps/projector`'s own `mongo-client.ts`. READ-ONLY in
// intent (this service never writes `order_timeline` — R54), though
// nothing at the driver level enforces that. What DOES enforce R54 (no
// write-database client of any kind, MySQL or otherwise) is
// `no-write-database-client.spec.ts` (Group B): (1) `package.json` carries
// no `mysql2`/`drizzle-orm` dependency, and (2) neither package — nor any
// subpath of either (`mysql2/promise`, `drizzle-orm/mysql2`, ...) —
// resolves from this package via Node's own module resolution, proven by
// executing `require.resolve()` against it, not by scanning source text
// for an import statement (review finding F2 — a substring check on
// `'mysql2'` alone does not catch `'mysql2/promise'`, the exact form
// `apps/billing/src/infrastructure/persistence/client.ts` uses).
import { MongoClient, type Collection, type Db } from 'mongodb';
import { mongoConnectionUri, type MongoConfig } from './mongo.config';
import type { OrderTimelineDocumentLike } from '../../domain/projection/order-read-model-mapper';

export const ORDER_TIMELINE_COLLECTION = 'order_timeline';

export interface MongoHandle {
  readonly client: MongoClient;
  readonly db: Db;
}

export async function connectMongo(config: MongoConfig): Promise<MongoHandle> {
  const client = new MongoClient(mongoConnectionUri(config));
  await client.connect();
  return { client, db: client.db(config.database) };
}

export function orderTimelineCollection(db: Db): Collection<OrderTimelineDocumentLike> {
  return db.collection<OrderTimelineDocumentLike>(ORDER_TIMELINE_COLLECTION);
}
