// The two NATS responders (design.md §4.1) — `@MessagePattern(subject,
// Transport.NATS)`, dispatching on the `CommandBus` (hold) and the
// `QueryBus` (list). Subjects are the AsyncAPI addresses, guarded by
// `credit.controller.spec.ts`'s read-the-spec-as-text assertion. Every
// `Transport.NATS` is explicit (CLAUDE.md non-negotiable + ESLint guard).
// This controller NEVER throws: validate → dispatch → `try/catch` →
// `toRpcError` — every outcome resolves the method with a plain object.
import { Controller, Inject } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Ctx, MessagePattern, Payload, Transport, type NatsContext } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UniqueId } from '@otc/shared-kernel';
import type { CreditHoldReplyPayload, CreditListReplyPayload, RpcError } from '@otc/contracts';
import { HoldCreditCommand } from '../application/commands/credit.commands';
import { ListCreditQuery } from '../application/queries/credit.queries';
import { CreditHoldRequestDto, CreditListRequestDto } from './dto/credit.dto';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

export const CREDIT_HOLD_SUBJECT = 'billing.credit.hold';
export const CREDIT_LIST_SUBJECT = 'billing.credit.list';

interface RpcMeta {
  readonly correlationId: UniqueId;
  readonly requestId: UniqueId;
}

/** BC1: `x-correlation-id`/`x-request-id` parsed with `UniqueId.from`; `null` when either is absent or malformed. */
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
    message: 'x-correlation-id and x-request-id are required headers and must be valid UniqueIds (BC1)',
    occurredAt: new Date().toISOString(),
  };
}

@Controller()
export class CreditController {
  constructor(
    @Inject(QueryBus) private readonly queries: QueryBus,
    @Inject(CommandBus) private readonly commands: CommandBus,
  ) {}

  @MessagePattern(CREDIT_HOLD_SUBJECT, Transport.NATS)
  async hold(@Payload() payload: unknown, @Ctx() ctx: NatsContext): Promise<CreditHoldReplyPayload | RpcError> {
    const dto = plainToInstance(CreditHoldRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    const meta = parseRpcMeta(ctx);
    if (!meta) {
      return missingHeadersRpcError();
    }

    try {
      return await this.commands.execute<HoldCreditCommand, CreditHoldReplyPayload>(
        new HoldCreditCommand(dto, meta.correlationId, meta.requestId),
      );
    } catch (error) {
      return toRpcError(error);
    }
  }

  @MessagePattern(CREDIT_LIST_SUBJECT, Transport.NATS)
  async list(@Payload() payload: unknown): Promise<CreditListReplyPayload | RpcError> {
    const dto = plainToInstance(CreditListRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    try {
      return await this.queries.execute<ListCreditQuery, CreditListReplyPayload>(new ListCreditQuery(dto));
    } catch (error) {
      return toRpcError(error);
    }
  }
}
