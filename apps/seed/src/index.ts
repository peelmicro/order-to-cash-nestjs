// apps/seed — the deterministic, idempotent one-shot seed job
// (feature_list.json #12). Runs the three services' committed migrations
// (so a cold compose stack works), seeds master data + the fabricated saga
// history across the three MySQL databases and the MongoDB read model, then
// verifies itself and exits non-zero on any mismatch (verify.ts).
//
// Usage: `pnpm seed` (root) — runs against the compose stack via
// `dotenv -e ../../.env --`, same pattern as every other app's CLI scripts.
import {
  migrateOrders,
  openOrdersDb,
  seedOrdersMasterData,
  seedOrdersSagas,
} from './writers/orders-db.writer';
import {
  migrateFulfillment,
  openFulfillmentDb,
  seedFulfillmentSagas,
  seedFulfillmentStock,
} from './writers/fulfillment-db.writer';
import {
  migrateBilling,
  openBillingDb,
  seedBillingCredits,
  seedBillingSagas,
} from './writers/billing-db.writer';
import { openMongo, seedMongoTimelines } from './writers/mongo.writer';
import { verifySeed } from './verify';

async function main(): Promise<void> {
  console.log('[seed] applying migrations (orders, fulfillment, billing)…');
  await Promise.all([migrateOrders(), migrateFulfillment(), migrateBilling()]);

  const ordersHandle = await openOrdersDb();
  const fulfillmentHandle = await openFulfillmentDb();
  const billingHandle = await openBillingDb();
  const mongoHandle = await openMongo();

  try {
    console.log(
      '[seed] writing master data (currencies, products, retailers, companies, stock, credits)…',
    );
    await seedOrdersMasterData(ordersHandle.db);
    await seedFulfillmentStock(fulfillmentHandle.db);
    await seedBillingCredits(billingHandle.db);

    console.log('[seed] writing sample saga history (5 completed + 1 cancelled)…');
    await seedOrdersSagas(ordersHandle.db);
    await seedFulfillmentSagas(fulfillmentHandle.db);
    await seedBillingSagas(billingHandle.db);
    await seedMongoTimelines(mongoHandle.db);

    console.log('[seed] verifying…');
    const summary = await verifySeed({
      ordersDb: ordersHandle.db,
      fulfillmentDb: fulfillmentHandle.db,
      billingDb: billingHandle.db,
      mongoDb: mongoHandle.db,
    });

    console.log('[seed] OK — self-verification summary:');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await ordersHandle.pool.end();
    await fulfillmentHandle.pool.end();
    await billingHandle.pool.end();
    await mongoHandle.client.close();
  }
}

main()
  .then(() => {
    console.log('[seed] done.');
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error('[seed] FAILED:', error);
    process.exitCode = 1;
  });
