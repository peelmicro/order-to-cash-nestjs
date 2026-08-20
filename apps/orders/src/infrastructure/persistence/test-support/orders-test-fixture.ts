// Shared Testcontainers fixture for the outbox_and_idempotency integration
// specs (D5-D8, E7-E11, F1-F2, G3-G6): one disposable `otc_orders`-shaped
// MySQL database, migrated from empty, seeded with the minimal reference
// rows (`currencies`, `retailers`, `companies`, `products`) an `Order.place`
// fixture needs to resolve against. NOT itself a `*.spec.ts` file, so
// neither vitest config picks it up as a suite.
import { randomUUID } from 'node:crypto';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql, { type Pool } from 'mysql2/promise';
import { runOrdersMigrations } from '../migrator';
import * as schema from '../schema';
import type { OrdersDb } from '../client';

export const MYSQL_IMAGE = 'mysql:8.4.11';

export const FIXTURE_CURRENCY = 'EUR';
export const FIXTURE_RETAILER_CODE = 'RET-0001';
export const FIXTURE_RETAILER_GLN = '5412345000013';
export const FIXTURE_COMPANY_CODE = 'COM-0001';
export const FIXTURE_COMPANY_GLN = '5412345000037';
export const FIXTURE_PRODUCT_CODE = 'PRD-0001';

export interface OrdersTestFixture {
  container: StartedMySqlContainer;
  pool: Pool;
  db: OrdersDb;
  teardown(): Promise<void>;
}

export async function startOrdersTestFixture(): Promise<OrdersTestFixture> {
  const container = await new MySqlContainer(MYSQL_IMAGE)
    .withDatabase('otc_orders')
    .withUsername('otc_app')
    .withUserPassword('otc_app_test_password')
    .withRootPassword('otc_root_test_password')
    .start();

  await runOrdersMigrations({
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

  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const currencyId = randomUUID();
  const retailerId = randomUUID();
  const companyId = randomUUID();
  const productId = randomUUID();

  await db.insert(schema.currencies).values({
    id: currencyId,
    code: FIXTURE_CURRENCY,
    isoNumber: '978',
    symbol: '€',
    decimalPoints: 2,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.retailers).values({
    id: retailerId,
    code: FIXTURE_RETAILER_CODE,
    name: 'Acme Retail',
    country: 'ES',
    vat: 'ESB12345678',
    gln: FIXTURE_RETAILER_GLN,
    currencyId,
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.companies).values({
    id: companyId,
    code: FIXTURE_COMPANY_CODE,
    name: 'Acme Supply Co',
    country: 'ES',
    vat: 'ESA87654321',
    gln: FIXTURE_COMPANY_GLN,
    currencyId,
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.products).values({
    id: productId,
    code: FIXTURE_PRODUCT_CODE,
    ean: '5901234123457',
    name: 'Widget',
    description: 'A widget for integration testing',
    price: 1_000,
    currencyId,
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
  });

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
