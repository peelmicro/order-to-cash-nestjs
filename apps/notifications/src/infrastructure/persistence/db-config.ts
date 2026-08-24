// Connection configuration for the `otc_notifications` database, read from
// the process environment (see .env.example § MySQL / NOTIFICATIONS_DB_HOST).
// Kept as plain parts rather than a single DATABASE_URL — same reasoning
// apps/fulfillment/src/infrastructure/persistence/db-config.ts states: the
// individual MYSQL_* vars are already the single source of truth shared
// with docker-compose.infra.yml / infra/mysql/init.
export interface NotificationsDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function loadNotificationsDbConfig(env: NodeJS.ProcessEnv = process.env): NotificationsDbConfig {
  return {
    host: env.NOTIFICATIONS_DB_HOST ?? 'localhost',
    port: Number(env.MYSQL_HOST_PORT ?? 3306),
    user: env.MYSQL_USER ?? 'otc_app',
    password: env.MYSQL_PASSWORD ?? '',
    database: env.MYSQL_DB_NOTIFICATIONS ?? 'otc_notifications',
  };
}
