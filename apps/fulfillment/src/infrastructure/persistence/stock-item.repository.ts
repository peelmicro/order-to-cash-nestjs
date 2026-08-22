// The Drizzle adapter for `StockItemRepository` (design.md §4.3, §4.4, §7).
// `lockForOrder`/`lockByIdsForOrder`/`lockByProductCodes` are the ONLY
// places this service takes `FOR UPDATE` — always one statement, ordered by
// `(company_code, product_code)` (or by id list resolved to that same
// order), never `SKIP LOCKED` here: a contender must WAIT, not skip
// (design.md §4.3).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { UniqueId, type OrderNumber } from '@otc/shared-kernel';
import type { Clock } from '../../application/ports/clock.port';
import type { StockItemRepository } from '../../application/ports/stock-item-repository.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import type { StockItem } from '../../domain/stock-item';
import { OutboxRecorder } from '../outbox/outbox-recorder';
import { asDrizzleTx } from './drizzle-unit-of-work';
import type { FulfillmentDb } from './client';
import { reconstituteStockItem, toReservationTableRows, toStockTableRow, type ReservationRow, type StockRow } from './stock-item.mapper';
import { reservations, stock } from './schema';

export class DrizzleStockItemRepository implements StockItemRepository {
  constructor(
    private readonly db: FulfillmentDb,
    private readonly clock: Clock,
    private readonly outboxRecorder: OutboxRecorder = new OutboxRecorder(clock),
  ) {}

  /**
   * Step 1 of §4.3: one `FOR UPDATE` statement, `ORDER BY (company_code,
   * product_code)`, over the distinct product codes of the request. Then
   * step 2: the order's existing reservations, `FOR UPDATE`, loaded ONLY
   * for the stock rows just locked (design.md §3.1 — the aggregate holds
   * only the order's own reservations). Unknown product codes are simply
   * absent from the returned `Map`.
   */
  async lockForOrder(
    tx: TransactionContext,
    companyCode: string,
    productCodes: readonly string[],
    orderReference: OrderNumber,
  ): Promise<ReadonlyMap<string, StockItem>> {
    const db = asDrizzleTx(tx);
    if (productCodes.length === 0) {
      return new Map();
    }

    const stockRows = await db
      .select()
      .from(stock)
      .where(and(eq(stock.companyCode, companyCode), inArray(stock.productCode, [...productCodes])))
      .orderBy(stock.companyCode, stock.productCode)
      .for('update');

    if (stockRows.length === 0) {
      return new Map();
    }

    const stockIds = stockRows.map((row) => row.id);
    const reservationRows = await db
      .select()
      .from(reservations)
      .where(and(inArray(reservations.stockId, stockIds), eq(reservations.orderReference, orderReference.value)))
      .for('update');

    return this.toItemMap(stockRows, reservationRows);
  }

  /** Non-locking pre-read for release (design.md §4.4 step 0) — the distinct stock ids the order's reservations point at. */
  async stockIdsOfOrder(orderReference: OrderNumber): Promise<readonly UniqueId[]> {
    const rows = await this.db
      .selectDistinct({ stockId: reservations.stockId })
      .from(reservations)
      .where(eq(reservations.orderReference, orderReference.value));
    return rows.map((row) => UniqueId.from(row.stockId));
  }

  /** `FOR UPDATE` by id list, index-ordered (design.md §4.4 step 1), loading the order's reservations. */
  async lockByIdsForOrder(tx: TransactionContext, ids: readonly UniqueId[], orderReference: OrderNumber): Promise<readonly StockItem[]> {
    const db = asDrizzleTx(tx);
    if (ids.length === 0) {
      return [];
    }
    const idValues = ids.map((id) => id.value);

    const stockRows = await db
      .select()
      .from(stock)
      .where(inArray(stock.id, idValues))
      .orderBy(stock.companyCode, stock.productCode)
      .for('update');

    const reservationRows = await db
      .select()
      .from(reservations)
      .where(and(inArray(reservations.stockId, idValues), eq(reservations.orderReference, orderReference.value)))
      .for('update');

    return [...this.toItemMap(stockRows, reservationRows).values()];
  }

  /** `FOR UPDATE`, one statement, index-ordered — the replenish flow's lock (no order to scope reservations by, so none are loaded). */
  async lockByProductCodes(
    tx: TransactionContext,
    companyCode: string,
    productCodes: readonly string[],
  ): Promise<ReadonlyMap<string, StockItem>> {
    const db = asDrizzleTx(tx);
    if (productCodes.length === 0) {
      return new Map();
    }

    const stockRows = await db
      .select()
      .from(stock)
      .where(and(eq(stock.companyCode, companyCode), inArray(stock.productCode, [...productCodes])))
      .orderBy(stock.companyCode, stock.productCode)
      .for('update');

    return this.toItemMap(stockRows, []);
  }

  /** Upserts each item's row and its loaded reservations, then drains EVERY item's `pullDomainEvents()` into the outbox, all inside `tx` (R13). `tx` required — never opens its own. */
  async saveAll(items: readonly StockItem[], tx: TransactionContext): Promise<void> {
    const db = asDrizzleTx(tx);
    const now = this.clock.now();

    for (const item of items) {
      const stockRow = toStockTableRow(item, { createdAt: now, updatedAt: now });
      await db
        .insert(stock)
        .values(stockRow)
        .onDuplicateKeyUpdate({
          set: {
            units: stockRow.units,
            reservedUnits: stockRow.reservedUnits,
            lowStockThreshold: stockRow.lowStockThreshold,
            updatedAt: stockRow.updatedAt,
          },
        });

      const reservationRows = toReservationTableRows(item, { createdAt: now, updatedAt: now });
      if (reservationRows.length > 0) {
        await db
          .insert(reservations)
          .values(reservationRows)
          .onDuplicateKeyUpdate({
            // Multi-row upsert: MySQL's VALUES(col) refers to the value THIS
            // row's INSERT clause carried, not the pre-existing column value
            // (the same pattern apps/orders/.../order.repository.ts uses).
            set: {
              status: sql`VALUES(${reservations.status})`,
              units: sql`VALUES(${reservations.units})`,
              updatedAt: sql`VALUES(${reservations.updatedAt})`,
            },
          });
      }
    }

    const events = items.flatMap((item) => item.pullDomainEvents());
    await this.outboxRecorder.record(tx, events);
  }

  private toItemMap(stockRows: readonly StockRow[], reservationRows: readonly ReservationRow[]): Map<string, StockItem> {
    const reservationsByStockId = new Map<string, ReservationRow[]>();
    for (const row of reservationRows) {
      const bucket = reservationsByStockId.get(row.stockId);
      if (bucket) {
        bucket.push(row);
      } else {
        reservationsByStockId.set(row.stockId, [row]);
      }
    }

    const result = new Map<string, StockItem>();
    for (const row of stockRows) {
      result.set(row.productCode, reconstituteStockItem(row, reservationsByStockId.get(row.id) ?? []));
    }
    return result;
  }
}
