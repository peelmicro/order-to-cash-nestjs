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
   * RI1/RI2's lookup (design.md §3.2) — same read shape as
   * `findById`/`findByReference` when called WITHOUT `tx` (RI2's fast
   * path, before any transaction opens). WITH `tx`, this is RI3's
   * re-read-the-winner path — a LOCKING read (`findOne`'s `forUpdate`),
   * required so the loser's re-read cannot miss a row its own INSERT's
   * duplicate-key error just proved exists (see `findOne`'s comment).
   */
  async findByRequestId(requestId: string, tx?: TransactionContext): Promise<Order | null> {
    return this.findOne(this.resolveQueryable(tx), eq(orders.requestId, requestId), tx !== undefined);
  }

  /**
   * Persists the `orders` row and its `order_items`, then hands
   * `order.pullDomainEvents()` to the `OutboxRecorder` inside the SAME
   * `tx` (R13). `tx` is required — never opens a transaction of its own.
   *
   * The `orders` row write forks on whether this `save` is a genuine
   * INSERT (a brand-new order — `order.placed.v1` is among the pulled
   * domain events, emitted only by `Order.place(...)`) or an UPDATE (a
   * saga-step transition — `SagaFactHandler` always `findById`s an
   * existing order first, so no creation event is pulled). The two paths
   * were folded into one `ON DUPLICATE KEY UPDATE` upsert before this
   * feature; that no longer works once `uq_orders_request_id` exists,
   * because MySQL's upsert catches a collision on ANY of the row's unique
   * keys and silently UPDATEs the matched row instead of raising —
   * exactly the wrong shape for RI3, which needs a genuine, catchable
   * duplicate-key error on a concurrent-first-request race. Events are
   * pulled BEFORE either write so `isNewOrder` can be read from them
   * without a second, destructive `pullDomainEvents()` call later.
   */
  async save(order: Order, tx: TransactionContext, requestId?: string): Promise<void> {
    const db = asDrizzleTx(tx);
    const now = this.clock.now();
    const events = order.pullDomainEvents();
    const isNewOrder = events.some((event) => event.eventType === 'order.placed.v1');

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
      requestId,
    );

    if (isNewOrder) {
      // A genuine INSERT — no `ON DUPLICATE KEY UPDATE`, so a collision on
      // ANY unique key (id, order_reference, request_id) throws rather
      // than silently overwriting an unrelated row. `PlaceOrderHandler`
      // is the one place that knows what an `uq_orders_request_id`
      // collision means (RI3); every other collision propagates as-is.
      await db.insert(orders).values(orderRow);
    } else {
      // An UPDATE of an already-persisted order — `request_id` is
      // immutable once set (never part of this SET clause) and the row is
      // located by its own primary key, so no unique-key collision is
      // possible here.
      await db
        .update(orders)
        .set({
          status: orderRow.status,
          cancellationReason: orderRow.cancellationReason,
          notes: orderRow.notes,
          updatedAt: orderRow.updatedAt,
        })
        .where(eq(orders.id, orderRow.id));
    }

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
    // which is exactly the dual-write R13 exists to prevent. `events` was
    // already pulled above (to decide the insert/update fork); draining is
    // a one-shot operation, so it is NOT called a second time here.
    await this.outboxRecorder.record(tx, events);
  }

  private resolveQueryable(tx?: TransactionContext): Queryable {
    return tx ? asDrizzleTx(tx) : this.db;
  }

  /**
   * `forUpdate`: a LOCKING (current) read rather than a plain snapshot
   * read. Required for RI3's re-read-the-winner path specifically:
   * MySQL's default REPEATABLE READ isolation takes its consistent
   * snapshot at a transaction's FIRST read, which can predate the
   * winner's commit even though the loser's own INSERT (a genuine
   * duplicate-key check, not a snapshot read) already saw the conflict —
   * so a plain `SELECT` inside the loser's transaction can miss a row
   * its own INSERT just proved exists. `FOR UPDATE` always reads the
   * latest committed version, closing that window. Every other caller
   * (`findById`/`findByReference`, and `findByRequestId`'s own
   * no-`tx` RI2 fast path) keeps the plain read — no other caller
   * re-reads inside the SAME transaction as a write that could have
   * lost a same-key race.
   */
  private async findOne(db: Queryable, condition: ReturnType<typeof eq>, forUpdate = false): Promise<Order | null> {
    const query = db
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
    const [row] = forUpdate ? await query.for('update') : await query;

    if (!row) {
      return null;
    }

    const itemsQuery = db
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
    // MySQL/InnoDB REPEATABLE READ fixes this transaction's consistent-read
    // snapshot at its FIRST read of any kind — including the earlier
    // duplicate-key-triggering INSERT and the locking `orders` read above
    // — so a PLAIN select here can still miss rows a `FOR UPDATE` sibling
    // query just proved committed (found live, RI3's own integration
    // test failed on exactly this before both queries were made locking).
    const itemRows = forUpdate ? await itemsQuery.for('update') : await itemsQuery;

    return reconstituteOrder(row as OrderRowWithCodes, itemRows as OrderItemRowWithCode[]);
  }
}
