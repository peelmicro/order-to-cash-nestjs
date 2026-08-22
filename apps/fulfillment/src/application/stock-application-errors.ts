// Application-layer errors of `StockReservationHandler`/`ReplenishStockCommandHandler`
// — refusals raised above the domain (no carrier aggregate for a fact, an
// unknown product on a replenish line, a locking read that observed a
// stock id the caller did not lock) but not a violation of a domain
// invariant itself. Same shape `apps/orders/src/application/place-order.errors.ts`
// established: a stable `code`, translated by `rpc-error-mapper.ts` (§6.4)
// alongside the domain errors of `domain/stock-errors.ts`.
export abstract class StockApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `stock.reserve` — no line of the request resolved to a known stock item, so `reserveOrderStock` returned no carrier aggregate for a fact (design.md §3.3). */
export class NoKnownStockItemError extends StockApplicationError {
  readonly code = 'NO_KNOWN_STOCK_ITEM';

  constructor(readonly orderReference: string) {
    super(`stock.reserve: order ${orderReference} names no product this company stocks — no carrier aggregate for a fact`);
  }
}

/** `stock.replenish` — a line names a `productCode` with no stock item under the request's `companyCode` (FS14, all-or-nothing). */
export class UnknownStockItemError extends StockApplicationError {
  readonly code = 'UNKNOWN_STOCK_ITEM';

  constructor(
    readonly companyCode: string,
    readonly productCode: string,
  ) {
    super(`stock.replenish: no stock item for companyCode "${companyCode}", productCode "${productCode}"`);
  }
}

/** `stock.release` — the non-locking pre-read (design.md §4.4 step 0) named a stock id that the subsequent locking read (step 1/2) did not confirm still belongs to the order. Defensive: a reservation inserted for this order between step 0 and step 1 is impossible in practice (reservations are created once, under the stock locks, by `stock.reserve`). The handler aborts rather than release under a lock it does not hold, and lets the orchestrator retry. */
export class ConcurrentReservationChangeError extends StockApplicationError {
  readonly code = 'CONCURRENT_RESERVATION_CHANGE';

  constructor(readonly orderReference: string) {
    super(`stock.release: order ${orderReference}'s reservations changed between the pre-read and the locking read`);
  }
}
