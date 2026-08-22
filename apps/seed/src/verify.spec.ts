// BC19 — `verifyCounts` (verify.ts's pure section-1 extraction) driven
// against fake count sources, no Docker: a database whose saga-derived
// tables have grown beyond the fixtures still passes; one missing a
// reference row still fails, naming it (N3, design.md §10.2).
import { describe, expect, it } from 'vitest';
import { CURRENCIES } from './data/currencies.data';
import { PRODUCTS } from './data/products.data';
import { RETAILERS } from './data/retailers.data';
import { COMPANIES } from './data/companies.data';
import { CREDITS } from './data/credits.data';
import { STOCK } from './data/stock.data';
import { SAGAS, COMPLETED_SAGAS } from './data/sagas.data';
import { SeedVerificationError, verifyCounts, type VerificationSummary } from './verify';

const orderItemsExpected = SAGAS.reduce((sum, saga) => sum + saga.lines.length, 0);
const ordersOutboxExpected = SAGAS.reduce((sum, saga) => sum + saga.ordersOutbox.length, 0);
const reservationsExpected = SAGAS.reduce((sum, saga) => sum + saga.reservations.length, 0);
const despatchItemsExpected = COMPLETED_SAGAS.reduce((sum, saga) => sum + (saga.despatch?.items.length ?? 0), 0);
const fulfillmentOutboxExpected = SAGAS.reduce((sum, saga) => sum + saga.fulfillmentOutbox.length, 0);
const creditItemsExpected = SAGAS.reduce((sum, saga) => sum + saga.creditLedgerEntries.length, 0);
const invoiceItemsExpected = COMPLETED_SAGAS.reduce((sum, saga) => sum + (saga.invoice?.items.length ?? 0), 0);
const billingOutboxExpected = SAGAS.reduce((sum, saga) => sum + saga.billingOutbox.length, 0);

/** A summary that matches the seed's own fixtures exactly — the freshly-seeded, no-live-traffic baseline. */
function freshlySeededSummary(): VerificationSummary {
  return {
    orders: {
      currencies: CURRENCIES.length,
      products: PRODUCTS.length,
      retailers: RETAILERS.length,
      companies: COMPANIES.length,
      orders: SAGAS.length,
      orderItems: orderItemsExpected,
      outbox: ordersOutboxExpected,
    },
    fulfillment: {
      stock: STOCK.length,
      reservations: reservationsExpected,
      despatches: COMPLETED_SAGAS.length,
      despatchItems: despatchItemsExpected,
      outbox: fulfillmentOutboxExpected,
    },
    billing: {
      credits: CREDITS.length,
      creditItems: creditItemsExpected,
      invoices: COMPLETED_SAGAS.length,
      invoiceItems: invoiceItemsExpected,
      payments: COMPLETED_SAGAS.length,
      outbox: billingOutboxExpected,
    },
    mongoOrderTimelines: SAGAS.length,
  };
}

describe('verifyCounts — BC19', () => {
  it('accepts a freshly-seeded database whose counts match the fixtures exactly', () => {
    expect(() => verifyCounts(freshlySeededSummary())).not.toThrow();
  });

  it('accepts a database whose saga-derived tables have grown beyond the fixtures while still rejecting a missing reference row', () => {
    const grown = freshlySeededSummary();
    // Live traffic since the seed ran: more orders, more ledger entries,
    // more outbox rows, more of everything saga-derived — all growth, no
    // shrinkage.
    grown.orders.orders += 5;
    grown.orders.orderItems += 12;
    grown.orders.outbox += 20;
    grown.fulfillment.reservations += 8;
    grown.fulfillment.despatches += 2;
    grown.fulfillment.outbox += 15;
    grown.billing.creditItems += 6;
    grown.billing.outbox += 9;
    grown.mongoOrderTimelines += 5;

    expect(() => verifyCounts(grown)).not.toThrow();

    // Now knock out ONE reference-data row — a table live traffic can
    // never grow, so this must still fail, and name which kind of
    // assertion failed.
    const missingReferenceRow = { ...grown, orders: { ...grown.orders, currencies: CURRENCIES.length - 1 } };
    expect(() => verifyCounts(missingReferenceRow)).toThrow(SeedVerificationError);
    expect(() => verifyCounts(missingReferenceRow)).toThrow(/expected exactly/);
  });

  it('rejects a database whose saga-derived tables have NOT grown to the fixtures\' own floor, naming the lower-bound failure', () => {
    const short = freshlySeededSummary();
    short.orders.orders -= 1;

    expect(() => verifyCounts(short)).toThrow(SeedVerificationError);
    expect(() => verifyCounts(short)).toThrow(/expected at least/);
  });

  it('rejects a database whose credits count has grown beyond the fixtures — credits is reference data (BC3), never saga-grown', () => {
    const extraCredit = freshlySeededSummary();
    extraCredit.billing.credits += 1;

    expect(() => verifyCounts(extraCredit)).toThrow(SeedVerificationError);
    expect(() => verifyCounts(extraCredit)).toThrow(/billing\.credits/);
  });

  it('names the table when a reference-data count is short (exact assertion message shape)', () => {
    const missingCompany = freshlySeededSummary();
    missingCompany.orders.companies -= 1;

    expect(() => verifyCounts(missingCompany)).toThrow(/orders\.companies: expected exactly \d+, got \d+/);
  });
});
