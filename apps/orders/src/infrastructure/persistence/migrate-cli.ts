// CLI entry point for `pnpm --filter @otc/orders db:migrate` (and the root
// convenience alias `pnpm db:migrate:orders`). Applies the committed
// migrations under ../../../drizzle/ to the database described by the
// environment (see db-config.ts / .env.example).
import { loadOrdersDbConfig } from './db-config';
import { runOrdersMigrations } from './migrator';

async function main(): Promise<void> {
  const config = loadOrdersDbConfig();
  await runOrdersMigrations(config);
  console.log(`[orders] migrations applied against ${config.host}:${config.port}/${config.database}`);
}

main().catch((error: unknown) => {
  console.error('[orders] migration failed:', error);
  process.exitCode = 1;
});
