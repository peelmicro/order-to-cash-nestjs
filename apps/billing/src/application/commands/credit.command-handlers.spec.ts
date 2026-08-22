// Pure unit — proves plain delegation to `CreditHoldHandler`, nothing more
// (the transactional flow itself is `credit-hold.handler.spec.ts`'s job).
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { CreditHoldReplyPayload, CreditHoldRequestPayload } from '@otc/contracts';
import type { CreditHoldHandler } from '../credit-hold.handler.js';
import { HoldCreditCommand } from './credit.commands.js';
import { HoldCreditHandler } from './credit.command-handlers.js';

function request(): CreditHoldRequestPayload {
  return { orderReference: 'ORD-000001', retailerCode: 'RET-0001', companyCode: 'COM-0001', amount: { amount: 4_000, currency: 'EUR' } };
}

describe('HoldCreditHandler', () => {
  it('delegates to CreditHoldHandler.hold with the command, unchanged', async () => {
    const reply: CreditHoldReplyPayload = { outcome: 'approved', orderReference: 'ORD-000001', currency: 'EUR', availableCredit: 6_000 };
    let seenCommand: HoldCreditCommand | undefined;
    const fake = {
      async hold(command: HoldCreditCommand) {
        seenCommand = command;
        return reply;
      },
    } as unknown as CreditHoldHandler;
    const command = new HoldCreditCommand(request(), UniqueId.generate(), UniqueId.generate());
    const handler = new HoldCreditHandler(fake);

    const result = await handler.execute(command);

    expect(result).toBe(reply);
    expect(seenCommand).toBe(command);
  });
});
