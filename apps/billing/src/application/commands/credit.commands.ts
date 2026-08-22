// The one `CommandBus` command (design.md §5.1). Carries
// `correlationId`/`requestId` as `UniqueId` — derived from the request's
// `x-correlation-id`/`x-request-id` headers by the controller (BC1) — so
// the transactional flow never has to re-parse a header.
import { Command } from '@nestjs/cqrs';
import type { CreditHoldReplyPayload, CreditHoldRequestPayload } from '@otc/contracts';
import type { UniqueId } from '@otc/shared-kernel';

export class HoldCreditCommand extends Command<CreditHoldReplyPayload> {
  constructor(
    readonly request: CreditHoldRequestPayload,
    readonly correlationId: UniqueId,
    readonly requestId: UniqueId,
  ) {
    super();
  }
}
