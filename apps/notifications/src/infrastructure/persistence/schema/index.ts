// Barrel — the whole `otc_notifications` Drizzle schema, in one place for
// `drizzle-kit generate` (drizzle.config.ts) and for the Drizzle client
// factory (../client.ts). Nothing under src/domain may import this module
// (domain purity — enforced by ESLint, not just documented). Exactly one
// table: this service owns no aggregate.
export * from './processed-events.schema';
