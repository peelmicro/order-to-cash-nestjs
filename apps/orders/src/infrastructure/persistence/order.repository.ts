// The Drizzle adapter for `OrderRepository` (design.md §4.3) — lands in
// THIS feature, bounded to `save`/`findById`/`findByReference` and the row
// <-> aggregate mapping. No order-number allocation, no NATS, no command
// handler: those stay in feature 15 (`orders_acceptance`).
import { eq, inArray, sql } from 'drizzle-orm';
import type { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { Clock } from '../../application/ports/clock.port';
import type { OrderRepository } from '../../application/ports/order-repository.port';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import type { Order } from '../../domain/order';
import { OutboxRecorder } from '../outbox/outbox-recorder';
import { asDrizzleTx, type OrdersTx } from './drizzle-unit-of-work';
import type { OrdersDb } from './client';
import {
  type OrderItemRowWithCode,
  type OrderRowWithCodes,
  reconstituteOrder,
  toOrderItemsTableRows,
  toOrdersTableRow,
} from './order.mapper';
import { companies, currencies, orderItems, orders, products, retailers } from './schema';

type Queryable = OrdersDb | OrdersTx;

export class DrizzleOrderRepository implements OrderRepository {
  constructor(
    private readonly db: OrdersDb,
    private readonly clock: Clock,
    private readonly outboxRecorder: OutboxRecorder = new OutboxRecorder(clock),
  ) {}

  async findById(id: UniqueId, tx?: TransactionContext): Promise<Order | null> {
    return this.findOne(this.resolveQueryable(tx), eq(orders.id, id.value));
  }

  async findByReference(reference: OrderNumber, tx?: TransactionContext): Promise<Order | null> {
    return this.findOne(this.resolveQueryable(tx), eq(orders.orderReference, reference.value));
  }

  /**
   * Persists the `orders` row and its `order_items`, then hands
   * `order.pullDomainEvents()` to the `OutboxRecorder` inside the SAME
   * `tx` (R13). `tx` is required — never opens a transaction of its own.
   */
  async save(order: Order, tx: TransactionContext): Promise<void> {
    const db = asDrizzleTx(tx);
    const now = this.clock.now();

    const [currencyRow] = await db
      .select({ id: currencies.id })
      .from(currencies)
      .where(eq(currencies.code, order.currency))
      .limit(1);
    if (!currencyRow) {
      throw new Error(`DrizzleOrderRepository.save: unknown currency code "${order.currency}"`);
    }

    const [retailerRow] = await db
      .select({ id: retailers.id })
      .from(retailers)
      .where(eq(retailers.code, order.retailerCode))
      .limit(1);
    if (!retailerRow) {
      throw new Error(`DrizzleOrderRepository.save: unknown retailer code "${order.retailerCode}"`);
    }

    const [companyRow] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.code, order.companyCode))
      .limit(1);
    if (!companyRow) {
      throw new Error(`DrizzleOrderRepository.save: unknown company code "${order.companyCode}"`);
    }

    const productCodes = [...new Set(order.lines.map((line) => line.productCode))];
    const productRows =
      productCodes.length > 0
        ? await db
            .select({ id: products.id, code: products.code })
            .from(products)
            .where(inArray(products.code, productCodes))
        : [];
    const productIdByCode = new Map(productRows.map((row) => [row.code, row.id]));

    const orderRow = toOrdersTableRow(
      order,
      { currencyId: currencyRow.id, retailerId: retailerRow.id, companyId: companyRow.id },
      { createdAt: now, updatedAt: now },
    );

    await db
      .insert(orders)
      .values(orderRow)
      .onDuplicateKeyUpdate({
        set: {
          status: orderRow.status,
          cancellationReason: orderRow.cancellationReason,
          notes: orderRow.notes,
          updatedAt: orderRow.updatedAt,
        },
      });

    const itemRows = toOrderItemsTableRows(order, productIdByCode, { createdAt: now, updatedAt: now });
    if (itemRows.length > 0) {
      await db
        .insert(orderItems)
        .values(itemRows)
        .onDuplicateKeyUpdate({
          // Multi-row upsert: MySQL's VALUES(col) refers to the value THIS
          // row's INSERT clause carried, not the pre-existing column value
          // (the same pattern apps/seed's writers already use).
          set: {
            description: sql`VALUES(${orderItems.description})`,
            price: sql`VALUES(${orderItems.price})`,
            quantity: sql`VALUES(${orderItems.quantity})`,
            discount: sql`VALUES(${orderItems.discount})`,
            updatedAt: sql`VALUES(${orderItems.updatedAt})`,
          },
        });
    }

    // The repository — not the handler — drains the aggregate (design.md
    // §4.4): a handler that had to remember a second call could forget it,
    // which is exactly the dual-write R13 exists to prevent.
    const events = order.pullDomainEvents();
    await this.outboxRecorder.record(tx, events);
  }

  private resolveQueryable(tx?: TransactionContext): Queryable {
    return tx ? asDrizzleTx(tx) : this.db;
  }

  private async findOne(db: Queryable, condition: ReturnType<typeof eq>): Promise<Order | null> {
    const [row] = await db
      .select({
        id: orders.id,
        orderReference: orders.orderReference,
        orderDate: orders.orderDate,
        buyerGln: retailers.gln,
        retailerCode: retailers.code,
        supplierGln: companies.gln,
        companyCode: companies.code,
        currencyCode: currencies.code,
        status: orders.status,
        cancellationReason: orders.cancellationReason,
        notes: orders.notes,
      })
      .from(orders)
      .innerJoin(retailers, eq(orders.retailerId, retailers.id))
      .innerJoin(companies, eq(orders.companyId, companies.id))
      .innerJoin(currencies, eq(orders.currencyId, currencies.id))
      .where(condition)
      .limit(1);

    if (!row) {
      return null;
    }

    const itemRows = await db
      .select({
        id: orderItems.id,
        productCode: products.code,
        description: orderItems.description,
        price: orderItems.price,
        quantity: orderItems.quantity,
        discount: orderItems.discount,
      })
      .from(orderItems)
      .innerJoin(products, eq(orderItems.productId, products.id))
      .where(eq(orderItems.orderId, row.id));

    return reconstituteOrder(row as OrderRowWithCodes, itemRows as OrderItemRowWithCode[]);
  }
}
