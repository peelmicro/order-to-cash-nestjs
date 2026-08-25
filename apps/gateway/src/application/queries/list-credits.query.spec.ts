import { describe, expect, it } from 'vitest';
import { CREDIT_LIST_SUBJECT, ListCreditsHandler, ListCreditsQuery } from './list-credits.query';
import { FakeRpcClient } from '../../test-support/fake-rpc-client';

describe('ListCreditsHandler', () => {
  it('translates to billing.credit.list', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(CREDIT_LIST_SUBJECT, {
      items: [
        {
          creditCode: 'CR-000001',
          retailerCode: 'CarrefourEs',
          companyCode: 'IBERFOODS',
          currency: 'EUR',
          creditLimit: 1000000,
          activeHolds: 0,
          openExposure: 0,
          availableCredit: 1000000,
        },
      ],
      page: { page: 1, pageSize: 25, total: 1 },
    });
    const handler = new ListCreditsHandler(rpc);

    const result = await handler.execute(new ListCreditsQuery({ page: 1, pageSize: 25 }));

    expect(rpc.calls[0]?.subject).toBe(CREDIT_LIST_SUBJECT);
    expect(result.items).toHaveLength(1);
  });
});
