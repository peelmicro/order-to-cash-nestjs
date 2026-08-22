// Shared Testcontainers fixture for the Billing integration specs
// (design.md §13): one disposable `otc_billing`-shaped MySQL database,
// migrated from empty. No reference-table seeding is needed — `credits`
// rows are the fixture's own root, no FK into another service's database
// (CLAUDE.md § Database per service). NOT itself a `*.spec.ts` file, so
// neither vitest config picks it up as a suite.
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql, { type Pool } from 'mysql2/promise';
import { runBillingMigrations } from '../migrator';
import * as schema from '../schema';
import type { BillingDb } from '../client';

export const MYSQL_IMAGE = 'mysql:8.4.11';

export interface BillingTestFixture {
  container: StartedMySqlContainer;
  pool: Pool;
  db: BillingDb;
  teardown(): Promise<void>;
}

export async function startBillingTestFixture(): Promise<BillingTestFixture> {
  const container = await new MySqlContainer(MYSQL_IMAGE)
    .withDatabase('otc_billing')
    .withUsername('otc_app')
    .withUserPassword('otc_app_test_password')
    .withRootPassword('otc_root_test_password')
    .start();

  await runBillingMigrations({
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getUserPassword(),
    database: container.getDatabase(),
  });

  const pool = mysql.createPool({
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getUserPassword(),
    database: container.getDatabase(),
    timezone: 'Z',
  });
  const db = drizzle(pool, { schema, mode: 'default' });

  return {
    container,
    pool,
    db,
    async teardown(): Promise<void> {
      await pool.end();
      await container.stop();
    },
  };
}
