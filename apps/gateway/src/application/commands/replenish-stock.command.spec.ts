import { describe, expect, it } from 'vitest';
import { ReplenishStockCommand, ReplenishStockHandler, STOCK_REPLENISH_SUBJECT } from './replenish-stock.command';
import { FakeRpcClient } from '../../test-support/fake-rpc-client';

describe('ReplenishStockHandler', () => {
  it('R61 — translates to fulfillment.stock.replenish and passes the affected items through', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(STOCK_REPLENISH_SUBJECT, {
      items: [{ companyCode: 'IBERFOODS', productCode: 'PRD-0001', units: 200, reservedUnits: 10, availableUnits: 190, lowStockThreshold: 20 }],
    });
    const handler = new ReplenishStockHandler(rpc);

    const result = await handler.execute(
      new ReplenishStockCommand({ companyCode: 'IBERFOODS', lines: [{ productCode: 'PRD-0001', units: 100 }] }),
    );

    expect(rpc.calls[0]?.subject).toBe(STOCK_REPLENISH_SUBJECT);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.units).toBe(200);
  });
});
