// The reference-data resolution port `orders_acceptance`'s "What to build"
// step 4 asks for: "resolve reference data (retailer/company/product codes
// -> the ids the adapter needs)" — done here, BEFORE `Order.place(...)`
// runs, because `PlaceOrderInput` needs `buyer.gln`/`supplier.gln` (value
// objects `Order.place` cannot resolve itself, domain purity forbids it a
// database) and because `OrdersCreateRequestPayload.unitPrice` is optional
// ("when omitted the responder snapshots the catalogue price" —
// asyncapi.yaml `requestOrdersCreate`).
//
// A read, deliberately outside the placing transaction (reference data is
// close to static; `DrizzleOrderRepository.save` already re-resolves
// currency/retailer/company by code inside its own transaction as the
// authoritative check — see design.md §4.3 — so a reference row disabled or
// removed between this read and the commit still fails loudly there, it
// just fails as a generic write error rather than a clean `NOT_FOUND`
// RpcError; accepted as out of scope for this feature, noted in
// progress/impl_orders_acceptance.md).
import type { GLN, Money } from '@otc/shared-kernel';

export const ORDER_REFERENCE_DATA = Symbol('OrderReferenceData');

export interface PartyReference {
  readonly code: string;
  readonly gln: GLN;
}

export interface ProductReference {
  readonly productCode: string;
  /** The catalogue snapshot description — copied into `OrderLine.description` when the request omits a line's own value (it never does; the wire schema does not carry a per-line description, only the aggregate does — domain-model.md §3.1). */
  readonly description: string;
  /** The current catalogue price, in the product's own currency (`products.currency_id`) — used only when a request line omits `unitPrice`. */
  readonly price: Money;
}

export interface OrderReferenceDataInput {
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly currency: string;
  readonly productCodes: readonly string[];
}

export interface OrderReferenceData {
  readonly retailer: PartyReference | null;
  readonly company: PartyReference | null;
  readonly currencyExists: boolean;
  /** Keyed by `productCode`. A code absent from the map was not found in the catalogue. */
  readonly products: ReadonlyMap<string, ProductReference>;
}

export interface OrderReferenceDataPort {
  resolve(input: OrderReferenceDataInput): Promise<OrderReferenceData>;
}
