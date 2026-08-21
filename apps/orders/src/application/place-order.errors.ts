// Application-layer errors of `PlaceOrderHandler` — refusals raised above
// the domain (reference data missing, a stock rejection, a wire field the
// aggregate cannot represent) but before anything is persisted. Each
// carries a stable `code`, the same shape `apps/orders/src/domain/order-errors.ts`
// established, so `rpc-error-mapper.ts` can translate every one of them
// (domain and application alike) into the AsyncAPI `RpcError.code` vocabulary
// by one small, exhaustive table instead of ad hoc `instanceof` sprawl.
import type { StockAvailabilityLineResult } from './ports/stock-availability.port';

export abstract class PlaceOrderError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A `retailerCode`/`companyCode`/`currency`/`productCode` the request named does not exist in the Orders context's own reference tables. */
export class ReferenceDataNotFoundError extends PlaceOrderError {
  readonly code = 'REFERENCE_DATA_NOT_FOUND';

  constructor(
    readonly field: 'retailerCode' | 'companyCode' | 'currency' | 'productCode',
    readonly value: string,
  ) {
    super(`${field} "${value}" does not resolve to a known reference row`);
  }
}

/** `fulfillment.stock.check` answered `available: false` — R31, saga.md §3.1 step 0. Carries the short lines so the RPC error's `details` can name them (asyncapi.yaml: "STOCK_UNAVAILABLE names the short lines"). */
export class StockUnavailableError extends PlaceOrderError {
  readonly code = 'STOCK_UNAVAILABLE';

  constructor(readonly shortages: readonly StockAvailabilityLineResult[]) {
    super(
      `stock check reports ${shortages.length} short line(s): ${shortages
        .map((line) => `${line.productCode} (requested ${line.requested}, available ${line.available})`)
        .join(', ')}`,
    );
  }
}

/** `OrdersCreateRequestPayload.orderDiscount` is part of the wire contract, but `orders_aggregate/design.md` §4.3 deliberately carries no order-level discount field on the aggregate (only per-line discounts). A non-zero value is refused rather than silently dropped. */
export class OrderDiscountNotSupportedError extends PlaceOrderError {
  readonly code = 'ORDER_DISCOUNT_NOT_SUPPORTED';

  constructor(readonly orderDiscount: number) {
    super(
      `orderDiscount ${orderDiscount} was supplied, but the Order aggregate carries no order-level discount (orders_aggregate/design.md §4.3) — use per-line lineDiscount instead`,
    );
  }
}
