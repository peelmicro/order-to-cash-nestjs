// The `@nestjs/cqrs` query side of `orders_catalog_responder` (CLAUDE.md's
// binding CQRS convention: "application layers use CommandBus/QueryBus/
// EventBus handlers in every service"). Thin — the actual reference-table
// reads live in `DrizzleOrderReferenceDataRepository.list` (bound to
// `CATALOG_REFERENCE_LIST`, see that port's own header for why this is the
// SAME class `PlaceOrderHandler`'s `ORDER_REFERENCE_DATA` binds).
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import type { CatalogReferenceListReplyPayload } from '@otc/contracts';
import { CATALOG_REFERENCE_LIST, type CatalogKind, type CatalogReferenceListPort } from '../ports/catalog-reference-list.port';

export class ListCatalogReferenceQuery {
  constructor(
    readonly kinds: readonly CatalogKind[],
    readonly includeDisabled: boolean,
  ) {}
}

@QueryHandler(ListCatalogReferenceQuery)
export class ListCatalogReferenceHandler
  implements IQueryHandler<ListCatalogReferenceQuery, CatalogReferenceListReplyPayload>
{
  constructor(@Inject(CATALOG_REFERENCE_LIST) private readonly catalog: CatalogReferenceListPort) {}

  async execute(query: ListCatalogReferenceQuery): Promise<CatalogReferenceListReplyPayload> {
    return this.catalog.list({ kinds: query.kinds, includeDisabled: query.includeDisabled });
  }
}
