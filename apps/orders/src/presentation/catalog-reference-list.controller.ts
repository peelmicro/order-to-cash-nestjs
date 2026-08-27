// The `catalog.reference.list` responder — `orders_catalog_responder`
// "What to build": a `@MessagePattern` (NATS, `@nestjs/microservices`),
// registered on the SAME `orders.create` NATS microservice `main.ts` already
// connects (bare-JSON (de)serializer pair — F1), a validated request DTO
// (`catalog-reference-list.dto.ts`), delegating to the `@nestjs/cqrs`
// `QueryBus` (`ListCatalogReferenceQuery`), replying with the AsyncAPI reply
// schema (`CatalogReferenceListReplyPayload`) from `@otc/contracts`.
//
// Mirrors `orders-create.controller.ts` exactly: explicit `Transport.NATS`
// (a bare pattern binds to every connected transport — the Kafka
// microservice this service also runs would try to subscribe to a topic
// literally named "catalog.reference.list" and crash the boot, the SAME
// live-stack finding `orders-create.controller.ts`'s header records),
// explicit `@Inject(TOKEN)` DI (CLAUDE.md § Non-negotiables), trace-context
// propagation via `@Ctx() natsContext` (OR4/R57), and NEVER throwing — every
// outcome resolves the method with a plain object, discriminated by shape
// (`products`/`retailers`/... vs `code`), never a rejected promise.
import { Controller, Inject } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Ctx, MessagePattern, NatsContext, Payload, Transport } from '@nestjs/microservices';
import { context as otelContext } from '@opentelemetry/api';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { MsgHdrs } from 'nats';
import type { CatalogReferenceListReplyPayload, RpcError } from '@otc/contracts';
import { ListCatalogReferenceQuery } from '../application/queries/list-catalog-reference.query';
import { extractNatsTraceContext } from '../infrastructure/observability/trace-context';
import { CatalogReferenceListRequestDto } from './dto/catalog-reference-list.dto';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

export const CATALOG_REFERENCE_LIST_SUBJECT = 'catalog.reference.list';

@Controller()
export class CatalogReferenceListController {
  constructor(@Inject(QueryBus) private readonly queries: QueryBus) {}

  @MessagePattern(CATALOG_REFERENCE_LIST_SUBJECT, Transport.NATS)
  async list(
    @Payload() payload: unknown,
    @Ctx() natsContext: NatsContext,
  ): Promise<CatalogReferenceListReplyPayload | RpcError> {
    const extracted = extractNatsTraceContext(natsContext.getHeaders() as MsgHdrs | undefined);
    return otelContext.with(extracted, () => this.handle(payload));
  }

  private async handle(payload: unknown): Promise<CatalogReferenceListReplyPayload | RpcError> {
    const dto = plainToInstance(CatalogReferenceListRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true, forbidNonWhitelisted: false });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    try {
      return await this.queries.execute<ListCatalogReferenceQuery, CatalogReferenceListReplyPayload>(
        new ListCatalogReferenceQuery(dto.kinds ?? [], dto.includeDisabled ?? false),
      );
    } catch (error) {
      return toRpcError(error);
    }
  }
}
