// Barrel — the whole `otc_fulfillment` Drizzle schema, in one place for
// `drizzle-kit generate` (drizzle.config.ts) and for the Drizzle client
// factory (../client.ts). Nothing under src/domain may import this module
// (see eslint.config.mjs § domain-purity — enforced, not just documented).
export * from './stock.schema';
export * from './reservations.schema';
export * from './despatches.schema';
export * from './despatch-items.schema';
export * from './despatch-number-sequences.schema';
export * from './outbox.schema';
export * from './processed-events.schema';
