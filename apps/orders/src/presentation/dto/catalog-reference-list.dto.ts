// The validated request DTO for `catalog.reference.list` — matches
// `@otc/contracts`'s generated `CatalogReferenceListRequestPayload`
// field-for-field (`implements`, `orders-create.dto.ts`'s own convention),
// validated manually inside `catalog-reference-list.controller.ts` (not a
// global `ValidationPipe`) so a validation failure becomes an
// `RpcError`-shaped reply object, same as every other responder in this
// service (`rpc-error-mapper.ts`).
import 'reflect-metadata';
import { ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { CatalogReferenceListRequestPayload } from '@otc/contracts';

export const CATALOG_KINDS = ['products', 'retailers', 'companies', 'currencies'] as const;

export class CatalogReferenceListRequestDto implements CatalogReferenceListRequestPayload {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(CATALOG_KINDS, { each: true })
  kinds?: CatalogReferenceListRequestPayload['kinds'];

  @IsOptional()
  @IsBoolean()
  includeDisabled?: boolean;
}
