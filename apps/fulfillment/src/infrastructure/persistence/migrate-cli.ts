// CLI entry point for `pnpm --filter @otc/fulfillment db:migrate` (and the
// root convenience alias `pnpm db:migrate:fulfillment`). Applies the
// committed migrations under ../../../drizzle/ to the database described by
// the environment (see db-config.ts / .env.example).
import { loadFulfillmentDbConfig } from './db-config';
import { runFulfillmentMigrations } from './migrator';

async function main(): Promise<void> {
  const config = loadFulfillmentDbConfig();
  await runFulfillmentMigrations(config);
  console.log(`[fulfillment] migrations applied against ${config.host}:${config.port}/${config.database}`);
}

main().catch((error: unknown) => {
  console.error('[fulfillment] migration failed:', error);
  process.exitCode = 1;
});
