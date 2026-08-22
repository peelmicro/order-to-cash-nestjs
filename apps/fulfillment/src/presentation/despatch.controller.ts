// The one NATS responder of this feature (mirrors `stock.controller.ts`
// §6.1) — `@MessagePattern(subject, Transport.NATS)`, dispatching on the
// `CommandBus`. Subject is the AsyncAPI address, guarded by
// `despatch.controller.spec.ts`'s read-the-spec-as-text assertion. Every
// `Transport.NATS` is explicit (CLAUDE.md non-negotiable + ESLint guard).
// This controller NEVER throws — validate -> dispatch -> `toRpcError`, the
// same rule `stock.controller.ts` follows, including the SAME `x-correlation-id`/
// `x-request-id` header discipline feature 17 established (FS3): refuse
// without them, `VALIDATION_FAILED`, nothing mutated.
import { Controller, Inject } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Ctx, MessagePattern, Payload, Transport, type NatsContext } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UniqueId } from '@otc/shared-kernel';
import type { DespatchCreateReplyPayload, RpcError } from '@otc/contracts';
import { CreateDespatchCommand } from '../application/commands/despatch.commands';
import { DespatchCreateRequestDto } from './dto/despatch.dto';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

export const DESPATCH_CREATE_SUBJECT = 'fulfillment.despatch.create';

interface RpcMeta {
  readonly correlationId: UniqueId;
  readonly requestId: UniqueId;
}

/** FS3, reused verbatim: `x-correlation-id`/`x-request-id` parsed with `UniqueId.from`; `null` when either is absent or malformed. */
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
    message:
      'x-correlation-id and x-request-id are required headers and must be valid UniqueIds (FS3)',
    occurredAt: new Date().toISOString(),
  };
}

@Controller()
export class DespatchController {
  constructor(@Inject(CommandBus) private readonly commands: CommandBus) {}

  @MessagePattern(DESPATCH_CREATE_SUBJECT, Transport.NATS)
  async create(
    @Payload() payload: unknown,
    @Ctx() ctx: NatsContext,
  ): Promise<DespatchCreateReplyPayload | RpcError> {
    const dto = plainToInstance(DespatchCreateRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    const meta = parseRpcMeta(ctx);
    if (!meta) {
      return missingHeadersRpcError();
    }

    try {
      return await this.commands.execute<CreateDespatchCommand, DespatchCreateReplyPayload>(
        new CreateDespatchCommand(dto, meta.correlationId, meta.requestId),
      );
    } catch (error) {
      return toRpcError(error);
    }
  }
}
