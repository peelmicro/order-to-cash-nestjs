// Shared Testcontainers fixture for the notifications integration specs
// (notifications_service re-review, N1/N2/N7): one disposable
// `otc_notifications`-shaped MySQL database, migrated from empty. Same
// shape apps/fulfillment's own fulfillment-test-fixture.ts establishes.
// NOT itself a `*.spec.ts` file, so neither vitest config picks it up as a
// suite.
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql, { type Pool } from 'mysql2/promise';
import { runNotificationsMigrations } from '../migrator';
import * as schema from '../schema';
import type { NotificationsDb } from '../client';
import type { NotificationsDbConfig } from '../db-config';

export const MYSQL_IMAGE = 'mysql:8.4.11';

export interface NotificationsTestFixture {
  container: StartedMySqlContainer;
  pool: Pool;
  db: NotificationsDb;
  config: NotificationsDbConfig;
  teardown(): Promise<void>;
}

export async function startNotificationsTestFixture(): Promise<NotificationsTestFixture> {
  const container = await new MySqlContainer(MYSQL_IMAGE)
    .withDatabase('otc_notifications')
    .withUsername('otc_app')
    .withUserPassword('otc_app_test_password')
    .withRootPassword('otc_root_test_password')
    .start();

  const config: NotificationsDbConfig = {
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getUserPassword(),
    database: container.getDatabase(),
  };

  await runNotificationsMigrations(config);

  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    timezone: 'Z',
  });
  const db = drizzle(pool, { schema, mode: 'default' });

  return {
    container,
    pool,
    db,
    config,
    async teardown(): Promise<void> {
      await pool.end();
      await container.stop();
    },
  };
}
