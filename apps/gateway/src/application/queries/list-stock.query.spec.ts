import { describe, expect, it } from 'vitest';
import { ListStockHandler, ListStockQuery, STOCK_LIST_SUBJECT } from './list-stock.query';
import { FakeRpcClient } from '../../test-support/fake-rpc-client';

describe('ListStockHandler', () => {
  it('translates to fulfillment.stock.list — a live read of the Fulfillment write model, not the read model (openapi.yaml)', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(STOCK_LIST_SUBJECT, {
      items: [{ companyCode: 'IBERFOODS', productCode: 'PRD-0001', units: 100, reservedUnits: 5, availableUnits: 95, lowStockThreshold: 20 }],
      page: { page: 1, pageSize: 25, total: 1 },
    });
    const handler = new ListStockHandler(rpc);

    const result = await handler.execute(new ListStockQuery({ page: 1, pageSize: 25 }));

    expect(rpc.calls[0]?.subject).toBe(STOCK_LIST_SUBJECT);
    expect(result.items).toHaveLength(1);
  });
});
