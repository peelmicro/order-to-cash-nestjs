// The place-order command handler (`orders_acceptance` "What to build" step
// 4) — saga.md §3.1 step 0: resolve reference data, call the synchronous
// stock check BEFORE persisting anything, and on success `Order.place(...)`
// + `save(order, tx)` inside one `UnitOfWork` so the aggregate row and the
// `order.placed.v1` outbox record commit together (R13). On a stock-check
// failure (business rejection OR transport failure/timeout) nothing is
// persisted and no fact is emitted — the `UnitOfWork` is never even opened.
//
// A plain class, not a NestJS `@Injectable()` — the same "no decorator
// needed to be DI-injected via a factory provider" shape `OutboxRelay` and
// the Drizzle adapters already use (app.module.ts wires it with
// `useFactory`).
import { Money, Quantity, UniqueId, type OrderNumber } from '@otc/shared-kernel';
import type { Clock } from './ports/clock.port';
import type { OrderNumberAllocator } from './ports/order-number-allocator.port';
import type {
  OrderReferenceData,
  OrderReferenceDataPort,
} from './ports/order-reference-data.port';
import type { OrderRepository } from './ports/order-repository.port';
import type { StockAvailabilityLine, StockAvailabilityPort } from './ports/stock-availability.port';
import type { UnitOfWork } from './ports/unit-of-work.port';
import { OrderDiscountNotSupportedError, ReferenceDataNotFoundError, StockUnavailableError } from './place-order.errors';
import { Order, type PlaceOrderLineInput } from '../domain/order';

export interface PlaceOrderLineCommand {
  readonly productCode: string;
  readonly quantity: number;
  /** Omitted -> the catalogue price is snapshotted (asyncapi.yaml `OrdersCreateRequestPayload.unitPrice`). */
  readonly unitPrice?: number;
  readonly lineDiscount?: number;
}

export interface PlaceOrderCommand {
  /** Accepted for wire-contract completeness (asyncapi.yaml's idempotency-key description); NOT resolved against a stored request — a repeated `requestId` places a second order today. Tracked as its own feature (`orders_idempotent_replay`, `feature_list.json` id 39) rather than folded in here, because closing the gap needs a persisted lookup column/index, not a local fix. Used only to seed `causationId` when it parses as a `UniqueId`. */
  readonly requestId?: string;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly currency: string;
  readonly lines: readonly PlaceOrderLineCommand[];
  readonly orderDiscount?: number;
  readonly notes?: string;
}

export interface PlaceOrderResult {
  readonly orderId: string;
  readonly orderReference: string;
  readonly status: 'placed';
  readonly currency: string;
  readonly initialAmount: number;
  readonly initialDiscount: number;
  readonly totalAmount: number;
  readonly orderDate: string;
}

export class PlaceOrderHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly orders: OrderRepository,
    private readonly orderNumbers: OrderNumberAllocator,
    private readonly referenceData: OrderReferenceDataPort,
    private readonly stockAvailability: StockAvailabilityPort,
    private readonly clock: Clock,
  ) {}

  async execute(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
    if (command.orderDiscount !== undefined && command.orderDiscount !== 0) {
      throw new OrderDiscountNotSupportedError(command.orderDiscount);
    }

    const productCodes = command.lines.map((line) => line.productCode);
    const referenceData = await this.referenceData.resolve({
      retailerCode: command.retailerCode,
      companyCode: command.companyCode,
      currency: command.currency,
      productCodes,
    });
    this.assertReferenceDataComplete(command, referenceData);

    const stockLines: StockAvailabilityLine[] = command.lines.map((line) => ({
      productCode: line.productCode,
      quantity: line.quantity,
    }));
    // The synchronous stock check — BEFORE anything is persisted (R31,
    // saga.md §3.1 step 0). A timeout/transport failure propagates as
    // `StockCheckTimeoutError`/`StockCheckTransportError` (application
    // ports/stock-availability.port.ts) and is caught by the presentation
    // layer's `rpc-error-mapper.ts` — this handler does not catch it itself,
    // so no `UnitOfWork` is ever opened on that path either.
    const stockResult = await this.stockAvailability.check(command.companyCode, stockLines);
    if (!stockResult.available) {
      throw new StockUnavailableError(stockResult.lines.filter((line) => !line.sufficient));
    }

    // Reference data is fully resolved and stock is available — ONLY now is
    // the transaction opened. Order-number allocation happens inside it
    // (order-number-allocator.ts), so a rollback here also rolls back the
    // allocation rather than burning a sequence number.
    //
    // DESIGN NOTE (D7, review_orders_acceptance.md, 2026-08-21): this is a
    // deliberate throughput trade, not an oversight. `order-number-
    // allocator.ts`'s `SELECT ... FOR UPDATE` holds an exclusive lock on
    // the single counter row for the ENTIRE placing transaction (until
    // this `unitOfWork.execute` commits or rolls back), because allocation
    // must live INSIDE the transaction for a rollback to return the number
    // rather than burn it (see the comment above). The direct consequence:
    // every concurrent `orders.create` acceptance serialises behind the
    // slowest one — the counter row is the throughput ceiling of order
    // acceptance. The trade is: gap-free, human-facing `ORD-######`
    // references (no "where did ORD-000042 go?" after a failed placement)
    // bought with serialised placement. Correct at this scale; revisit
    // (e.g. a striped/sharded counter, or accepting gaps) only if order
    // acceptance throughput is ever load-tested against this ceiling —
    // feature 16 (the saga) and any later load-testing feature should
    // treat this as known, not rediscover it.
    return this.unitOfWork.execute(async (tx) => {
      const orderReference: OrderNumber = await this.orderNumbers.next(tx);
      const now = this.clock.now();

      const order = Order.place(
        {
          id: UniqueId.generate(),
          orderReference,
          orderDate: now,
          buyer: { gln: referenceData.retailer!.gln, code: command.retailerCode },
          supplier: { gln: referenceData.company!.gln, code: command.companyCode },
          currency: command.currency,
          lines: command.lines.map((line) => this.toLineInput(line, command.currency, referenceData)),
          notes: command.notes,
        },
        { occurredAt: now, causationId: this.resolveCausationId(command.requestId) },
      );

      await this.orders.save(order, tx);

      return this.toResult(order);
    });
  }

  private assertReferenceDataComplete(command: PlaceOrderCommand, referenceData: OrderReferenceData): void {
    if (!referenceData.retailer) {
      throw new ReferenceDataNotFoundError('retailerCode', command.retailerCode);
    }
    if (!referenceData.company) {
      throw new ReferenceDataNotFoundError('companyCode', command.companyCode);
    }
    if (!referenceData.currencyExists) {
      throw new ReferenceDataNotFoundError('currency', command.currency);
    }
    const missingProduct = command.lines.find((line) => !referenceData.products.has(line.productCode));
    if (missingProduct) {
      throw new ReferenceDataNotFoundError('productCode', missingProduct.productCode);
    }
  }

  private toLineInput(
    line: PlaceOrderLineCommand,
    currency: string,
    referenceData: OrderReferenceData,
  ): PlaceOrderLineInput {
    // Presence already proven by assertReferenceDataComplete.
    const product = referenceData.products.get(line.productCode)!;
    return {
      productCode: line.productCode,
      description: product.description,
      quantity: Quantity.of(line.quantity),
      unitPrice: line.unitPrice !== undefined ? Money.of(line.unitPrice, currency) : product.price,
      lineDiscount: Money.of(line.lineDiscount ?? 0, currency),
    };
  }

  /** R12-style causation for the root fact: the client's idempotency key when it parses as a `UniqueId`, otherwise a freshly generated command id — `order.placed.v1` is the saga's root, so there is no PRIOR fact/command id to inherit. */
  private resolveCausationId(requestId: string | undefined): UniqueId {
    if (requestId === undefined) {
      return UniqueId.generate();
    }
    try {
      return UniqueId.from(requestId);
    } catch {
      return UniqueId.generate();
    }
  }

  private toResult(order: Order): PlaceOrderResult {
    return {
      orderId: order.id.value,
      orderReference: order.orderReference.value,
      status: 'placed',
      currency: order.currency,
      initialAmount: order.initialAmount.amount,
      initialDiscount: order.initialDiscount.amount,
      totalAmount: order.totalAmount.amount,
      orderDate: order.orderDate.toISOString(),
    };
  }
}
