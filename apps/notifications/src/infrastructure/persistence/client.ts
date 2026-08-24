// The Drizzle client factory for `otc_notifications`. Infrastructure-layer
// only — nothing under src/domain may import mysql2/drizzle-orm directly.
import mysql, { type Pool } from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import type { NotificationsDbConfig } from './db-config';
import * as schema from './schema';

export type NotificationsDb = MySql2Database<typeof schema>;

export function createNotificationsPool(config: NotificationsDbConfig): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    // CLAUDE.md "Dates: UTC everywhere" — without this mysql2 converts
    // DATETIME columns using the Node process's local timezone instead of
    // treating them as the UTC instants they are.
    timezone: 'Z',
  });
}

export function createNotificationsDb(pool: Pool): NotificationsDb {
  return drizzle(pool, { schema, mode: 'default' });
}
