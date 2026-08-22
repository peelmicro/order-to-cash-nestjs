// The hold transactional unit as a PLAIN CLASS (no decorator) — design.md
// §5.5. The `@CommandHandler` wrapper in `commands/credit.command-handlers.ts`
// delegates to this, the same split `StockReservationHandler` and
// `SagaFactHandler` use so a unit test can `new` it with fakes.
import { Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { CreditHoldReplyPayload } from '@otc/contracts';
import type { HoldCreditCommand } from './commands/credit.commands.js';
import type { Clock } from './ports/clock.port.js';
import type { BuyerCreditRepository } from './ports/buyer-credit-repository.port.js';
import type { CreditDecisionPort } from './ports/credit-decision.port.js';
import type { UnitOfWork } from './ports/unit-of-work.port.js';
import { CreditCurrencyMismatchError, CreditLineNotFoundError } from './credit-application-errors.js';
import type { CreditContext, HoldRequest } from '../domain/buyer-credit.js';

export class CreditHoldHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly credits: BuyerCreditRepository,
    private readonly decision: CreditDecisionPort,
    private readonly clock: Clock,
  ) {}

  /**
   * §5.5: `unitOfWork.execute(tx => lockForOrder → null ⇒ throw
   * CreditLineNotFoundError → evaluateHold → already_held/currency_mismatch
   * short-circuit → over_limit ⇒ refuseHold('over_limit') → fits ⇒
   * decision.decide(...) ⇒ approveHold | refuseHold(reason) → save → map to
   * reply)`. The reply is built from the domain outcome BEFORE commit but
   * returned only AFTER `execute` resolves, so a rollback can never have
   * produced a success reply. `ctx.causationId = cmd.requestId` (BC1, R12).
   */
  async hold(cmd: HoldCreditCommand): Promise<CreditHoldReplyPayload> {
    const request = cmd.request;
    const orderReference = OrderNumber.of(request.orderReference);
    const amount = Money.of(request.amount.amount, request.amount.currency);

    return this.unitOfWork.execute(async (tx) => {
      const credit = await this.credits.lockForOrder(tx, request.retailerCode, request.companyCode, orderReference);
      if (!credit) {
        // BC3 — a contract violation, not a credit decision: nothing was
        // written (the transaction rolls back), no fact is emitted.
        throw new CreditLineNotFoundError(request.retailerCode, request.companyCode);
      }

      const holdRequest: HoldRequest = { orderReference, amount, correlationId: cmd.correlationId };
      const evaluation = credit.evaluateHold(holdRequest);

      if (evaluation.kind === 'already_held') {
        // BC7 — the idempotent repeat: no port consulted, nothing written.
        return {
          outcome: 'already_held' as const,
          orderReference: request.orderReference,
          creditCode: credit.code.value,
          currency: credit.currency,
          heldAmount: evaluation.heldAmount.amount,
          availableCredit: credit.availableCredit.amount,
        };
      }

      if (evaluation.kind === 'currency_mismatch') {
        // BC4 — a contract violation, not a credit decision: nothing was
        // written, no fact is emitted.
        throw new CreditCurrencyMismatchError(evaluation.expected, request.amount.currency);
      }

      const ctx: CreditContext = { occurredAt: this.clock.now(), causationId: cmd.requestId };

      if (evaluation.kind === 'over_limit') {
        // R39 — the aggregate's own word; the port is never consulted.
        credit.refuseHold(holdRequest, 'over_limit', ctx);
        await this.credits.save(credit, tx);
        return {
          outcome: 'rejected' as const,
          orderReference: request.orderReference,
          creditCode: credit.code.value,
          currency: credit.currency,
          availableCredit: credit.availableCredit.amount,
          reason: 'over_limit' as const,
        };
      }

      // `fits` — consult the credit-decision port ONLY here (BC13).
      const decision = await this.decision.decide({
        orderReference: request.orderReference,
        retailerCode: request.retailerCode,
        companyCode: request.companyCode,
        creditCode: credit.code.value,
        amountMinorUnits: amount.amount,
        currency: amount.currency,
        availableCreditMinorUnits: credit.availableCredit.amount,
      });

      if (decision.kind === 'refuse') {
        credit.refuseHold(holdRequest, decision.reason, ctx);
        await this.credits.save(credit, tx);
        return {
          outcome: 'rejected' as const,
          orderReference: request.orderReference,
          creditCode: credit.code.value,
          currency: credit.currency,
          availableCredit: credit.availableCredit.amount,
          reason: decision.reason,
        };
      }

      credit.approveHold(holdRequest, ctx, () => UniqueId.generate());
      await this.credits.save(credit, tx);
      return {
        outcome: 'approved' as const,
        orderReference: request.orderReference,
        creditCode: credit.code.value,
        currency: credit.currency,
        heldAmount: amount.amount,
        availableCredit: credit.availableCredit.amount,
      };
    });
  }
}
