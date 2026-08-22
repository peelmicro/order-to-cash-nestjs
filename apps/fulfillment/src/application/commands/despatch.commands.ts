// The one `CommandBus` command of this feature (mirrors `stock.commands.ts`
// §5.1). Carries `correlationId`/`requestId` as `UniqueId` — derived from
// the request's `x-correlation-id`/`x-request-id` headers by the controller
// (same FS3 discipline feature 17 established) — so the transactional flow
// never has to re-parse a header.
import { Command } from '@nestjs/cqrs';
import type { DespatchCreateReplyPayload, DespatchCreateRequestPayload } from '@otc/contracts';
import type { UniqueId } from '@otc/shared-kernel';

export class CreateDespatchCommand extends Command<DespatchCreateReplyPayload> {
  constructor(
    readonly request: DespatchCreateRequestPayload,
    readonly correlationId: UniqueId,
    readonly requestId: UniqueId,
  ) {
    super();
  }
}
