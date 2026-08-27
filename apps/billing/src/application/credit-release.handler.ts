// The release transactional unit as a PLAIN CLASS (no decorator) — mirrors
// `credit-hold.handler.ts`'s own split exactly, so a unit test can `new` it
// with fakes. This is the follow-up pass closing feature 41's
// `credit_approved`/`confirmed` gap: `BuyerCredit.releaseHold` (feature 22)
// already exists, already idempotent by construction (recomputes outstanding
// exposure from the ledger every call — BC11, B5) and already accepts
// `reason` — this handler is the FIRST caller to reach it from outside
// Billing's own payment-registration flow, with `reason: 'order_cancelled'`
// always (the wire payload carries no `reason` field — see
// `ReleaseCreditCommand`'s own doc comment).
import { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { CreditReleaseReplyPayload } from '@otc/contracts';
import type { ReleaseCreditCommand } from './commands/credit.commands.js';
import type { Clock } from './ports/clock.port.js';
import type { BuyerCreditRepository } from './ports/buyer-credit-repository.port.js';
import type { UnitOfWork } from './ports/unit-of-work.port.js';
import { CreditLineNotFoundError } from './credit-application-errors.js';
import type { CreditContext } from '../domain/buyer-credit.js';

export class CreditReleaseHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly credits: BuyerCreditRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * `unitOfWork.execute(tx => lockForOrder → null ⇒ throw
   * CreditLineNotFoundError (BC3, reused unchanged from `credit.hold`) →
   * BuyerCredit.releaseHold(reason: 'order_cancelled') → null ⇒ reply
   * released:false, save NOT called (no entry, no fact — BC11/B5's
   * idempotent repeat) → an entry ⇒ save (INSERTs the `release` row,
   * drains `credit.released.v1` into the outbox) → reply released:true)`.
   * The reply is built from the domain outcome BEFORE commit but returned
   * only AFTER `execute` resolves, so a rollback can never produce a
   * success reply — the same rule every other Billing handler in this
   * service follows. `ctx.causationId = cmd.requestId` (BC1, R12).
   */
  async release(cmd: ReleaseCreditCommand): Promise<CreditReleaseReplyPayload> {
    const request = cmd.request;
    const orderReference = OrderNumber.of(request.orderReference);

    return this.unitOfWork.execute(async (tx) => {
      const credit = await this.credits.lockForOrder(tx, request.retailerCode, request.companyCode, orderReference);
      if (!credit) {
        // BC3 — a contract violation, not a credit decision: nothing was
        // written (the transaction rolls back), no fact is emitted.
        throw new CreditLineNotFoundError(request.retailerCode, request.companyCode);
      }

      const ctx: CreditContext = { occurredAt: this.clock.now(), causationId: cmd.requestId };
      const entry = credit.releaseHold({ orderReference, reason: 'order_cancelled', correlationId: cmd.correlationId }, ctx, () => UniqueId.generate());

      if (!entry) {
        // BC11/B5 — idempotent repeat, or nothing was ever held: NO
        // entry was appended and NO fact was raised by the aggregate, so
        // `save` is deliberately not called here — there is nothing for
        // it to persist or drain. `released: false` is still a success
        // reply, not an error (the RPC contract's own wording).
        return {
          released: false,
          orderReference: request.orderReference,
          creditCode: credit.code.value,
          currency: credit.currency,
          availableCreditAfter: credit.availableCredit.amount,
        };
      }

      await this.credits.save(credit, tx);
      return {
        released: true,
        orderReference: request.orderReference,
        creditCode: credit.code.value,
        currency: credit.currency,
        releasedAmount: entry.amount.amount,
        availableCreditAfter: credit.availableCredit.amount,
      };
    });
  }
}
