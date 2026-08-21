// Barrel — the whole `otc_orders` Drizzle schema, in one place for
// `drizzle-kit generate` (drizzle.config.ts) and for the Drizzle client
// factory (../client.ts). Nothing under src/domain may import this module
// (see eslint.config.mjs § domain-purity — enforced, not just documented).
export * from './currencies.schema';
export * from './products.schema';
export * from './retailers.schema';
export * from './companies.schema';
export * from './orders.schema';
export * from './order-items.schema';
export * from './order-number-sequences.schema';
export * from './outbox.schema';
export * from './processed-events.schema';
