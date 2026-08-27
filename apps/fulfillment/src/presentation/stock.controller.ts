// The five NATS responders (design.md §6.1) — `@MessagePattern(subject,
// Transport.NATS)`, dispatching on the `QueryBus` (check, list) and the
// `CommandBus` (reserve, release, replenish). Subjects are the AsyncAPI
// addresses, guarded by `stock.controller.spec.ts`'s read-the-spec-as-text
// assertion. Every `Transport.NATS` is explicit (CLAUDE.md non-negotiable +
// ESLint guard). This controller NEVER throws — validate -> dispatch ->
// `toRpcError`, the `orders-create.controller.ts` rule — every outcome
// resolves the method with a plain object.
import { Controller, Inject } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Ctx, MessagePattern, Payload, Transport, type NatsContext } from '@nestjs/microservices';
import { context as otelContext } from '@opentelemetry/api';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { MsgHdrs } from 'nats';
import { UniqueId } from '@otc/shared-kernel';
import type {
  RpcError,
  StockCheckReplyPayload,
  StockListReplyPayload,
  StockReleaseReplyPayload,
  StockReplenishReplyPayload,
  StockReserveReplyPayload,
} from '@otc/contracts';
import { ReleaseStockCommand, ReplenishStockCommand, ReserveStockCommand } from '../application/commands/stock.commands';
import { CheckStockQuery, ListStockQuery } from '../application/queries/stock.queries';
import { extractNatsTraceContext } from '../infrastructure/observability/trace-context';
import {
  StockCheckRequestDto,
  StockListRequestDto,
  StockReleaseRequestDto,
  StockReplenishRequestDto,
  StockReserveRequestDto,
} from './dto/stock.dto';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

export const STOCK_CHECK_SUBJECT = 'fulfillment.stock.check';
export const STOCK_RESERVE_SUBJECT = 'fulfillment.stock.reserve';
export const STOCK_RELEASE_SUBJECT = 'fulfillment.stock.release';
export const STOCK_LIST_SUBJECT = 'fulfillment.stock.list';
export const STOCK_REPLENISH_SUBJECT = 'fulfillment.stock.replenish';

interface RpcMeta {
  readonly correlationId: UniqueId;
  readonly requestId: UniqueId;
}

/** FS3: `x-correlation-id`/`x-request-id` parsed with `UniqueId.from`; `null` when either is absent or malformed. */
function parseRpcMeta(ctx: NatsContext): RpcMeta | null {
  const headers = ctx.getHeaders() as { get(key: string): string } | undefined;
  if (!headers) {
    return null;
  }
  const correlationRaw = headers.get('x-correlation-id');
  const requestRaw = headers.get('x-request-id');
  if (!correlationRaw || !requestRaw) {
    return null;
  }
  try {
    return { correlationId: UniqueId.from(correlationRaw), requestId: UniqueId.from(requestRaw) };
  } catch {
    return null;
  }
}

function missingHeadersRpcError(): RpcError {
  return {
    code: 'VALIDATION_FAILED',
    message: 'x-correlation-id and x-request-id are required headers and must be valid UniqueIds (FS3)',
    occurredAt: new Date().toISOString(),
  };
}

@Controller()
export class StockController {
  constructor(
    @Inject(QueryBus) private readonly queries: QueryBus,
    @Inject(CommandBus) private readonly commands: CommandBus,
  ) {}

  // `@Ctx()` + `extractNatsTraceContext`/`otelContext.with(...)` (A5b, R57,
  // mirrors `orders-create.controller.ts`'s own pattern) on EVERY handler
  // below, not only the ones that also read `x-correlation-id`/
  // `x-request-id` via `parseRpcMeta`: extraction is a no-op when the
  // caller sent no `traceparent` header (`extractNatsTraceContext` returns
  // the ambient context unchanged), so wrapping `check`/`list`/`replenish`
  // costs nothing on a call that carries none, while continuing the trace
  // on any call that does (every saga-command/Gateway caller now injects
  // one).
  @MessagePattern(STOCK_CHECK_SUBJECT, Transport.NATS)
  async check(@Payload() payload: unknown, @Ctx() ctx: NatsContext): Promise<StockCheckReplyPayload | RpcError> {
    const extracted = extractNatsTraceContext(ctx.getHeaders() as MsgHdrs | undefined);
    return otelContext.with(extracted, () => this.handleCheck(payload));
  }

  private async handleCheck(payload: unknown): Promise<StockCheckReplyPayload | RpcError> {
    const dto = plainToInstance(StockCheckRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    try {
      return await this.queries.execute<CheckStockQuery, StockCheckReplyPayload>(new CheckStockQuery(dto.companyCode, dto.lines));
    } catch (error) {
      return toRpcError(error);
    }
  }

  @MessagePattern(STOCK_RESERVE_SUBJECT, Transport.NATS)
  async reserve(@Payload() payload: unknown, @Ctx() ctx: NatsContext): Promise<StockReserveReplyPayload | RpcError> {
    const extracted = extractNatsTraceContext(ctx.getHeaders() as MsgHdrs | undefined);
    return otelContext.with(extracted, () => this.handleReserve(payload, ctx));
  }

  private async handleReserve(payload: unknown, ctx: NatsContext): Promise<StockReserveReplyPayload | RpcError> {
    const dto = plainToInstance(StockReserveRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    const meta = parseRpcMeta(ctx);
    if (!meta) {
      return missingHeadersRpcError();
    }

    try {
      return await this.commands.execute<ReserveStockCommand, StockReserveReplyPayload>(
        new ReserveStockCommand(dto, meta.correlationId, meta.requestId),
      );
    } catch (error) {
      return toRpcError(error);
    }
  }

  @MessagePattern(STOCK_RELEASE_SUBJECT, Transport.NATS)
  async release(@Payload() payload: unknown, @Ctx() ctx: NatsContext): Promise<StockReleaseReplyPayload | RpcError> {
    const extracted = extractNatsTraceContext(ctx.getHeaders() as MsgHdrs | undefined);
    return otelContext.with(extracted, () => this.handleRelease(payload, ctx));
  }

  private async handleRelease(payload: unknown, ctx: NatsContext): Promise<StockReleaseReplyPayload | RpcError> {
    const dto = plainToInstance(StockReleaseRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    const meta = parseRpcMeta(ctx);
    if (!meta) {
      return missingHeadersRpcError();
    }

    try {
      return await this.commands.execute<ReleaseStockCommand, StockReleaseReplyPayload>(
        new ReleaseStockCommand(dto, meta.correlationId, meta.requestId),
      );
    } catch (error) {
      return toRpcError(error);
    }
  }

  @MessagePattern(STOCK_LIST_SUBJECT, Transport.NATS)
  async list(@Payload() payload: unknown, @Ctx() ctx: NatsContext): Promise<StockListReplyPayload | RpcError> {
    const extracted = extractNatsTraceContext(ctx.getHeaders() as MsgHdrs | undefined);
    return otelContext.with(extracted, () => this.handleList(payload));
  }

  private async handleList(payload: unknown): Promise<StockListReplyPayload | RpcError> {
    const dto = plainToInstance(StockListRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    try {
      return await this.queries.execute<ListStockQuery, StockListReplyPayload>(new ListStockQuery(dto));
    } catch (error) {
      return toRpcError(error);
    }
  }

  @MessagePattern(STOCK_REPLENISH_SUBJECT, Transport.NATS)
  async replenish(@Payload() payload: unknown, @Ctx() ctx: NatsContext): Promise<StockReplenishReplyPayload | RpcError> {
    const extracted = extractNatsTraceContext(ctx.getHeaders() as MsgHdrs | undefined);
    return otelContext.with(extracted, () => this.handleReplenish(payload));
  }

  private async handleReplenish(payload: unknown): Promise<StockReplenishReplyPayload | RpcError> {
    const dto = plainToInstance(StockReplenishRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    try {
      return await this.commands.execute<ReplenishStockCommand, StockReplenishReplyPayload>(new ReplenishStockCommand(dto));
    } catch (error) {
      return toRpcError(error);
    }
  }
}
