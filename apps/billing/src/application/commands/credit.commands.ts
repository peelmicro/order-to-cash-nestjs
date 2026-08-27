// The `CommandBus` commands (design.md §5.1). Carries
// `correlationId`/`requestId` as `UniqueId` — derived from the request's
// `x-correlation-id`/`x-request-id` headers by the controller (BC1) — so
// the transactional flow never has to re-parse a header.
import { Command } from '@nestjs/cqrs';
import type { CreditHoldReplyPayload, CreditHoldRequestPayload, CreditReleaseReplyPayload, CreditReleaseRequestPayload } from '@otc/contracts';
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

/**
 * `billing.credit.release` (the follow-up pass closing feature 41's
 * `credit_approved`/`confirmed` gap). Mirrors `HoldCreditCommand` field for
 * field — `reason` is NOT carried here: the wire payload
 * (`CreditReleaseRequestPayload`) has no `reason` field at all, and
 * `CreditReleaseHandler` always passes `'order_cancelled'` to
 * `BuyerCredit.releaseHold` (the only external trigger for this RPC —
 * `'invoice_paid'` is set only by `PaymentRegisterHandler`'s own internal
 * call, never reachable from this command).
 */
export class ReleaseCreditCommand extends Command<CreditReleaseReplyPayload> {
  constructor(
    readonly request: CreditReleaseRequestPayload,
    readonly correlationId: UniqueId,
    readonly requestId: UniqueId,
  ) {
    super();
  }
}
