// drizzle-kit config for `otc_fulfillment`. Used ONLY for `drizzle-kit
// generate` (committed SQL migrations under ./drizzle/, the source of truth
// for the DB shape) — never `drizzle-kit push` from a script; see the schema
// files' header comments and progress/impl_db_orders.md for why.
// `dbCredentials` is still supplied because drizzle-kit needs a live
// connection to diff the current schema against the last migration snapshot
// when generating. The `db:generate` script (package.json) runs this through
// `dotenv -e ../../.env --`, which populates process.env before drizzle-kit
// loads this file — no dotenv import needed here.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'mysql',
  schema: './src/infrastructure/persistence/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    host: process.env.FULFILLMENT_DB_HOST ?? 'localhost',
    port: Number(process.env.MYSQL_HOST_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'otc_app',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DB_FULFILLMENT ?? 'otc_fulfillment',
  },
});
