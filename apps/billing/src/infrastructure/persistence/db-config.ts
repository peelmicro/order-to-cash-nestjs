// Connection configuration for the `otc_billing` database, read from the
// process environment (see .env.example § MySQL / BILLING_DB_HOST). Kept as
// plain parts rather than a single DATABASE_URL because dotenv (no
// dotenv-expand) does not interpolate one env var inside another, and the
// individual MYSQL_* vars are already the single source of truth shared with
// docker-compose.infra.yml / infra/mysql/init (same pattern as
// apps/orders / apps/fulfillment — see progress/impl_db_orders.md
// Decisions §4).
export interface BillingDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function loadBillingDbConfig(env: NodeJS.ProcessEnv = process.env): BillingDbConfig {
  return {
    host: env.BILLING_DB_HOST ?? 'localhost',
    port: Number(env.MYSQL_HOST_PORT ?? 3306),
    user: env.MYSQL_USER ?? 'otc_app',
    password: env.MYSQL_PASSWORD ?? '',
    database: env.MYSQL_DB_BILLING ?? 'otc_billing',
  };
}
