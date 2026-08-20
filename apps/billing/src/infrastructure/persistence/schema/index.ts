// Barrel — the whole `otc_billing` Drizzle schema, in one place for
// `drizzle-kit generate` (drizzle.config.ts) and for the Drizzle client
// factory (../client.ts). Nothing under src/domain may import this module
// (see eslint.config.mjs § domain-purity — enforced, not just documented).
export * from './credits.schema';
export * from './credit-items.schema';
export * from './invoices.schema';
export * from './invoice-items.schema';
export * from './payments.schema';
export * from './outbox.schema';
export * from './processed-events.schema';
