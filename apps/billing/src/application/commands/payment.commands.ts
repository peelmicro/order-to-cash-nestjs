// The one `CommandBus` command of `billing.payment.register` (feature 22,
// mirrors `invoice.commands.ts`'s `IssueInvoiceCommand` exactly). Carries
// `correlationId`/`requestId` as `UniqueId` — derived from the request's
// `x-correlation-id`/`x-request-id` headers by the controller (BC1/BI2) —
// so the transactional flow never has to re-parse a header.
import { Command } from '@nestjs/cqrs';
import type { PaymentRegisterReplyPayload, PaymentRegisterRequestPayload } from '@otc/contracts';
import type { UniqueId } from '@otc/shared-kernel';

export class RegisterPaymentCommand extends Command<PaymentRegisterReplyPayload> {
  constructor(
    readonly request: PaymentRegisterRequestPayload,
    readonly correlationId: UniqueId,
    readonly requestId: UniqueId,
  ) {
    super();
  }
}
