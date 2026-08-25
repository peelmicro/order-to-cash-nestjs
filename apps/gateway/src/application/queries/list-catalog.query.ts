// `GET /catalog/products`, `GET /catalog/retailers`, `GET /catalog/companies`
// (openapi.yaml `listProducts`/`listRetailers`/`listCompanies`) → NATS RPC
// `catalog.reference.list` (asyncapi.yaml `requestCatalogReferenceList`).
//
// **Known gap, recorded for the reviewer.** No service in this repository
// registers a responder on `catalog.reference.list` as of this feature
// (grepped: no `@MessagePattern(CATALOG_REFERENCE_LIST_SUBJECT, ...)`
// anywhere under `apps/*/src`) — the seeded product/retailer/company
// catalogue lives only in `otc_orders` (apps/orders' own write database,
// `apps/seed/src/writers/orders-db.writer.ts`), which this gateway must
// NEVER read directly (Group B's own rule). Implemented exactly per
// contract regardless: without a live responder these three endpoints
// correctly answer `503 UpstreamUnavailable` (`UNAVAILABLE` → no
// responders subscribed), which is the honest answer until Orders (or a
// dedicated reference-data service) grows that responder.
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { UniqueId } from '@otc/shared-kernel';
import type { CatalogReferenceListReplyPayload, CatalogReferenceListRequestPayload } from '@otc/contracts';
import { RPC_CLIENT, type RpcClient } from '../ports/rpc-client.port';

export const CATALOG_REFERENCE_LIST_SUBJECT = 'catalog.reference.list';

export type CatalogKind = 'products' | 'retailers' | 'companies';

export class ListCatalogQuery {
  constructor(
    readonly kind: CatalogKind,
    readonly includeDisabled: boolean,
  ) {}
}

@QueryHandler(ListCatalogQuery)
export class ListCatalogHandler implements IQueryHandler<ListCatalogQuery, CatalogReferenceListReplyPayload> {
  constructor(@Inject(RPC_CLIENT) private readonly rpc: RpcClient) {}

  async execute(query: ListCatalogQuery): Promise<CatalogReferenceListReplyPayload> {
    const requestId = UniqueId.generate().value;
    const request: CatalogReferenceListRequestPayload = { kinds: [query.kind], includeDisabled: query.includeDisabled };
    return this.rpc.call<CatalogReferenceListRequestPayload, CatalogReferenceListReplyPayload>(
      CATALOG_REFERENCE_LIST_SUBJECT,
      request,
      { correlationId: requestId, requestId },
    );
  }
}
