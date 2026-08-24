// CLI entry point for `pnpm --filter @otc/notifications db:migrate` (and
// the root convenience alias `pnpm db:migrate:notifications`). Applies the
// committed migrations under ../../../drizzle/ to the database described by
// the environment (see db-config.ts / .env.example).
import { loadNotificationsDbConfig } from './db-config';
import { runNotificationsMigrations } from './migrator';

async function main(): Promise<void> {
  const config = loadNotificationsDbConfig();
  await runNotificationsMigrations(config);
  console.log(`[notifications] migrations applied against ${config.host}:${config.port}/${config.database}`);
}

main().catch((error: unknown) => {
  console.error('[notifications] migration failed:', error);
  process.exitCode = 1;
});
