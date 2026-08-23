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
import type { CreditHoldReplyPayload, CreditListReplyPayload, RpcError } from '@otc/contracts';
import { HoldCreditCommand } from '../application/commands/credit.commands';
import { ListCreditQuery } from '../application/queries/credit.queries';
import { CreditHoldRequestDto, CreditListRequestDto } from './dto/credit.dto';
import { missingHeadersRpcError, parseRpcMeta } from './rpc-meta';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

export const CREDIT_HOLD_SUBJECT = 'billing.credit.hold';
export const CREDIT_LIST_SUBJECT = 'billing.credit.list';

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
