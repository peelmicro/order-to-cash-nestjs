// The read-only reference-catalogue LISTING port — `orders_catalog_responder`
// "What to build": the Gateway's `list-catalog.query.ts` calls
// `catalog.reference.list` expecting products/retailers/companies/currencies
// back (asyncapi.yaml `CatalogReferenceListRequestPayload`/
// `CatalogReferenceListReplyPayload`).
//
// Deliberately a SEPARATE port from `OrderReferenceDataPort` (not an added
// method on it): that port's `resolve(...)` takes SPECIFIC business codes
// (the ones a single `orders.create` request names) and its return shape
// (`ReadonlyMap`, `GLN`/`Money` value objects) is tailored for
// `PlaceOrderHandler`'s own validation, not for a wire reply. Widening that
// interface would also force every existing fake typed against it
// (`place-order.handler.spec.ts`) to grow a method it never uses.
//
// What IS reused, per this feature's brief ("reuse this port's underlying
// data access... do not duplicate the lookup logic"): the CONCRETE adapter.
// `DrizzleOrderReferenceDataRepository` (order-reference-data.repository.ts)
// implements BOTH this port and `OrderReferenceDataPort` — same `OrdersDb`
// connection, same `products`/`retailers`/`companies`/`currencies` Drizzle
// schema imports, so there is exactly one place these four tables are read
// from, never two independent query paths that could drift apart.
import type { CatalogReferenceListReplyPayload } from '@otc/contracts';

export const CATALOG_REFERENCE_LIST = Symbol('CatalogReferenceList');

export type CatalogKind = 'products' | 'retailers' | 'companies' | 'currencies';

export const ALL_CATALOG_KINDS: readonly CatalogKind[] = ['products', 'retailers', 'companies', 'currencies'];

export interface CatalogReferenceListInput {
  /** Empty (or omitted upstream) means "all four" — resolved to `ALL_CATALOG_KINDS` before this port is called. */
  readonly kinds: readonly CatalogKind[];
  readonly includeDisabled: boolean;
}

export interface CatalogReferenceListPort {
  list(input: CatalogReferenceListInput): Promise<CatalogReferenceListReplyPayload>;
}
