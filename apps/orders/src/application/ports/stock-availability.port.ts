// The outbound `fulfillment.stock.check` RPC port (`orders_acceptance`
// feature) — saga.md §2: "`stock.check` | Orders (acceptance, NOT the saga)
// | Fulfillment | — (read-only) | per-line available / insufficient". A
// non-locking read (R31): the adapter mutates nothing and the check itself
// emits no fact.
//
// Per the Kafka-vs-NATS decision matrix (saga.md §1: "If the peer is down —
// the caller gets a timeout and handles it"), a timeout or any other
// transport failure is a DISTINCT, explicitly-typed outcome from a
// BUSINESS rejection (`available: false`, some line short) — the caller
// (`PlaceOrderHandler`) must be able to tell "Fulfillment said no" apart
// from "Fulfillment did not answer in time", because only the former is a
// `STOCK_UNAVAILABLE` RpcError and the latter is a `TIMEOUT`/`UNAVAILABLE`
// one (asyncapi.yaml `RpcError.code`).
export const STOCK_AVAILABILITY = Symbol('StockAvailability');

export interface StockAvailabilityLine {
  readonly productCode: string;
  readonly quantity: number;
}

export interface StockAvailabilityLineResult {
  readonly productCode: string;
  readonly requested: number;
  readonly available: number;
  readonly sufficient: boolean;
}

export interface StockAvailabilityResult {
  readonly available: boolean;
  readonly lines: readonly StockAvailabilityLineResult[];
}

export interface StockAvailabilityPort {
  /** Never throws for a business rejection — `available: false` IS the answer. Throws only `StockCheckTimeoutError`/`StockCheckTransportError` for a transport-level failure, which the caller must handle explicitly (never lets it hang). */
  check(companyCode: string, lines: readonly StockAvailabilityLine[]): Promise<StockAvailabilityResult>;
}

/** The caller observed no reply within its deadline — saga.md's "a timeout is a legitimate, handled answer", applied at order acceptance rather than inside the saga (this call happens before the order — and therefore the saga — exists). */
export class StockCheckTimeoutError extends Error {
  readonly code = 'STOCK_CHECK_TIMEOUT';

  constructor(
    readonly subject: string,
    readonly timeoutMs: number,
  ) {
    super(`fulfillment.stock.check: no reply within ${timeoutMs}ms on subject "${subject}"`);
    this.name = new.target.name;
  }
}

/** Any other transport-level failure — no responder subscribed (NATS `NoResponders`), a malformed reply, a connection error. Distinct from a timeout because it is diagnosable immediately rather than after waiting out the deadline. */
export class StockCheckTransportError extends Error {
  readonly code = 'STOCK_CHECK_TRANSPORT_ERROR';

  constructor(
    readonly subject: string,
    reason: string,
  ) {
    super(`fulfillment.stock.check: transport failure on subject "${subject}": ${reason}`);
    this.name = new.target.name;
  }
}
