// CLI entry point for `pnpm --filter @otc/billing db:migrate` (and the root
// convenience alias `pnpm db:migrate:billing`). Applies the committed
// migrations under ../../../drizzle/ to the database described by the
// environment (see db-config.ts / .env.example).
import { loadBillingDbConfig } from './db-config';
import { runBillingMigrations } from './migrator';

async function main(): Promise<void> {
  const config = loadBillingDbConfig();
  await runBillingMigrations(config);
  console.log(`[billing] migrations applied against ${config.host}:${config.port}/${config.database}`);
}

main().catch((error: unknown) => {
  console.error('[billing] migration failed:', error);
  process.exitCode = 1;
});
