// Connection configuration for the `otc_fulfillment` database, read from the
// process environment (see .env.example § MySQL / FULFILLMENT_DB_HOST). Kept
// as plain parts rather than a single DATABASE_URL because dotenv (no
// dotenv-expand) does not interpolate one env var inside another, and the
// individual MYSQL_* vars are already the single source of truth shared
// with docker-compose.infra.yml / infra/mysql/init (same pattern as
// apps/orders — see progress/impl_db_orders.md Decisions §4).
export interface FulfillmentDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function loadFulfillmentDbConfig(env: NodeJS.ProcessEnv = process.env): FulfillmentDbConfig {
  return {
    host: env.FULFILLMENT_DB_HOST ?? 'localhost',
    port: Number(env.MYSQL_HOST_PORT ?? 3306),
    user: env.MYSQL_USER ?? 'otc_app',
    password: env.MYSQL_PASSWORD ?? '',
    database: env.MYSQL_DB_FULFILLMENT ?? 'otc_fulfillment',
  };
}
