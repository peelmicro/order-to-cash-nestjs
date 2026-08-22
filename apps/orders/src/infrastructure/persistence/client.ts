// The Drizzle client factory for `otc_orders`. Infrastructure-layer only —
// nothing under src/domain may import mysql2/drizzle-orm directly (see
// eslint.config.mjs § domain-purity); repositories that DO belong to
// infrastructure use this factory rather than opening their own pool.
import mysql, { type Pool } from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import type { OrdersDbConfig } from './db-config';
import * as schema from './schema';

export type OrdersDb = MySql2Database<typeof schema>;
// design.md §9.2 (billing_credit) — the service-neutral alias the canonical
// outbox-relay family imports instead of `OrdersDb` directly, so the same
// file text resolves to the right concrete type in every write model.
export type WriteModelDb = OrdersDb;

export function createOrdersPool(config: OrdersDbConfig): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    // CLAUDE.md "Dates: UTC everywhere" — without this mysql2 converts
    // DATETIME columns using the Node process's local timezone instead of
    // treating them as the UTC instants the domain stamps.
    timezone: 'Z',
  });
}

export function createOrdersDb(pool: Pool): OrdersDb {
  return drizzle(pool, { schema, mode: 'default' });
}
