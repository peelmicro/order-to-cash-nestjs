// Writes the Billing DB (`otc_billing`): a credit limit for every retailer
// plus, per seeded saga, the append-only `credit_items` ledger (hold ->
// consume -> release for completed orders; nothing at all for the cancelled
// one — invariant B1, "a hold that would break the limit is not recorded"),
// the `invoices`/`invoice_items`/`payments` for completed orders, and the
// already-published `outbox` rows. Reuses the real `@otc/billing` Drizzle
// client/schema/migrator.
import { sql } from 'drizzle-orm';
import type mysql from 'mysql2/promise';
import {
  createBillingDb,
  createBillingPool,
  type BillingDb,
} from '../../../billing/src/infrastructure/persistence/client';
import {
  loadBillingDbConfig,
  type BillingDbConfig,
} from '../../../billing/src/infrastructure/persistence/db-config';
import { runBillingMigrations } from '../../../billing/src/infrastructure/persistence/migrator';
import * as schema from '../../../billing/src/infrastructure/persistence/schema';
import type { CreditItemTypeRow } from '../../../billing/src/infrastructure/persistence/schema';
import { CREDITS } from '../data/credits.data';
import { SAGAS, type OrderSagaFixture } from '../data/sagas.data';
import { MASTER_DATA_TIMESTAMP } from '../data/constants';
import { deterministicId } from '../deterministic';

export interface BillingDbHandle {
  pool: mysql.Pool;
  db: BillingDb;
}

export async function openBillingDb(
  config: BillingDbConfig = loadBillingDbConfig(),
): Promise<BillingDbHandle> {
  const pool = createBillingPool(config);
  return { pool, db: createBillingDb(pool) };
}

export async function migrateBilling(
  config: BillingDbConfig = loadBillingDbConfig(),
): Promise<void> {
  await runBillingMigrations(config);
}

export async function seedBillingCredits(db: BillingDb): Promise<void> {
  const ts = MASTER_DATA_TIMESTAMP;
  await db
    .insert(schema.credits)
    .values(
      CREDITS.map((credit) => ({
        id: credit.id,
        code: credit.code,
        retailerCode: credit.retailerCode,
        companyCode: credit.companyCode,
        creditLimit: credit.creditLimit,
        currencyCode: credit.currencyCode,
        createdAt: ts,
        updatedAt: ts,
      })),
    )
    .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.credits.updatedAt})` } });
}

export async function seedBillingSagas(
  db: BillingDb,
  sagas: readonly OrderSagaFixture[] = SAGAS,
): Promise<void> {
  for (const saga of sagas) {
    if (saga.creditLedgerEntries.length > 0) {
      await db
        .insert(schema.creditItems)
        .values(
          saga.creditLedgerEntries.map((entry) => ({
            id: entry.id,
            creditId: entry.creditId,
            orderReference: entry.orderReference,
            amount: entry.amount,
            type: entry.type as CreditItemTypeRow,
            creditDate: entry.creditDate,
            createdAt: entry.creditDate,
            updatedAt: entry.creditDate,
          })),
        )
        .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.creditItems.updatedAt})` } });
    }

    if (saga.invoice) {
      const invoice = saga.invoice;
      await db
        .insert(schema.invoices)
        .values({
          id: invoice.id,
          invoiceReference: invoice.invoiceReference,
          invoiceDate: invoice.invoiceDate,
          companyCode: saga.companyCode,
          retailerCode: saga.retailerCode,
          orderReference: saga.orderReference,
          amount: invoice.amount,
          discount: invoice.discount,
          totalAmount: invoice.totalAmount,
          currencyCode: saga.currency,
          status: invoice.status,
          paidAt: invoice.paidAt,
          createdAt: invoice.invoiceDate,
          updatedAt: invoice.paidAt,
        })
        .onDuplicateKeyUpdate({ set: { updatedAt: sql`VALUES(${schema.invoices.updatedAt})` } });

      await db
        .insert(schema.invoiceItems)
        .values(
          invoice.items.map((item) => ({
            id: deterministicId(`order:${saga.sequence}:invoice-item:${item.productCode}`),
            invoiceId: invoice.id,
            productCode: item.productCode,
            units: item.units,
            price: item.price,
            createdAt: invoice.invoiceDate,
            updatedAt: invoice.invoiceDate,
          })),
        )
        .onDuplicateKeyUpdate({
          set: { updatedAt: sql`VALUES(${schema.invoiceItems.updatedAt})` },
        });

      await db
        .insert(schema.payments)
        .values({
          id: invoice.payment.id,
          paymentReference: invoice.payment.paymentReference,
          invoiceId: invoice.id,
          amount: invoice.payment.amount,
          currencyCode: saga.currency,
          valueDate: invoice.payment.valueDate,
          source: invoice.payment.source,
          createdAt: invoice.payment.valueDate,
        })
        .onDuplicateKeyUpdate({ set: { valueDate: sql`VALUES(${schema.payments.valueDate})` } });
    }

    if (saga.billingOutbox.length > 0) {
      await db
        .insert(schema.outbox)
        .values(
          saga.billingOutbox.map((row) => ({
            id: row.id,
            eventId: row.eventId,
            eventType: row.eventType,
            aggregateId: row.aggregateId,
            correlationId: row.correlationId,
            payload: row.payload,
            occurredAt: row.occurredAt,
            publishedAt: row.publishedAt,
            createdAt: row.occurredAt,
          })),
        )
        .onDuplicateKeyUpdate({ set: { publishedAt: sql`VALUES(${schema.outbox.publishedAt})` } });
    }
  }
}

export async function countBillingRows(db: BillingDb): Promise<{
  credits: number;
  creditItems: number;
  invoices: number;
  invoiceItems: number;
  payments: number;
  outbox: number;
}> {
  const [credits, creditItems, invoices, invoiceItems, payments, outbox] = await Promise.all([
    db.select().from(schema.credits),
    db.select().from(schema.creditItems),
    db.select().from(schema.invoices),
    db.select().from(schema.invoiceItems),
    db.select().from(schema.payments),
    db.select().from(schema.outbox),
  ]);
  return {
    credits: credits.length,
    creditItems: creditItems.length,
    invoices: invoices.length,
    invoiceItems: invoiceItems.length,
    payments: payments.length,
    outbox: outbox.length,
  };
}
