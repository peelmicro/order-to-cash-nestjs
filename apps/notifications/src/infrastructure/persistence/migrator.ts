// The migration runner — the single place that knows how to apply the
// committed SQL migrations under ../../../drizzle/ to a database. Used both
// by the `db:migrate` CLI script (migrate-cli.ts, against the compose
// MySQL) and by the Testcontainers integration tests (against a disposable
// MySQL), so "migrations run from empty" is proven the same way in both
// places — never `drizzle-kit push`, which is not a committed, reviewable
// artifact (same pattern as apps/orders/apps/fulfillment).
import path from 'node:path';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import type { NotificationsDbConfig } from './db-config';

export const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../../drizzle');

export async function runNotificationsMigrations(config: NotificationsDbConfig): Promise<void> {
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    multipleStatements: true,
    // See client.ts — UTC everywhere, no local-timezone drift.
    timezone: 'Z',
  });
  try {
    const db = drizzle(connection, { mode: 'default' });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await connection.end();
  }
}
