// Pure unit — a fake `StockReadPort`, never a real database. Proves plain
// delegation, nothing more (the SELECTs themselves are the repository's
// integration tests, D3/D4).
import { describe, expect, it } from 'vitest';
import type { StockCheckReplyPayload, StockListReplyPayload, StockListRequestPayload } from '@otc/contracts';
import type { StockReadPort } from '../ports/stock-read.port.js';
import { CheckStockHandler, ListStockHandler } from './stock.query-handlers.js';
import { CheckStockQuery, ListStockQuery } from './stock.queries.js';

function fakeStockRead(overrides: Partial<StockReadPort> = {}): StockReadPort {
  return {
    async availability() {
      throw new Error('not used by this test');
    },
    async list() {
      throw new Error('not used by this test');
    },
    ...overrides,
  };
}

describe('CheckStockHandler', () => {
  it('delegates to StockReadPort.availability with the query fields', async () => {
    const reply: StockCheckReplyPayload = { available: true, lines: [] };
    let seenArgs: unknown;
    const stockRead = fakeStockRead({
      async availability(companyCode, lines) {
        seenArgs = { companyCode, lines };
        return reply;
      },
    });
    const handler = new CheckStockHandler(stockRead);
    const query = new CheckStockQuery('COM-0001', [{ productCode: 'PRD-0001', quantity: 2 }]);

    const result = await handler.execute(query);

    expect(result).toBe(reply);
    expect(seenArgs).toEqual({ companyCode: 'COM-0001', lines: [{ productCode: 'PRD-0001', quantity: 2 }] });
  });
});

describe('ListStockHandler', () => {
  it('delegates to StockReadPort.list with the query request', async () => {
    const reply: StockListReplyPayload = { items: [], page: { page: 1, pageSize: 25, total: 0 } };
    let seenRequest: StockListRequestPayload | undefined;
    const stockRead = fakeStockRead({
      async list(request) {
        seenRequest = request;
        return reply;
      },
    });
    const handler = new ListStockHandler(stockRead);
    const request: StockListRequestPayload = { page: 1, pageSize: 25 };
    const query = new ListStockQuery(request);

    const result = await handler.execute(query);

    expect(result).toBe(reply);
    expect(seenRequest).toBe(request);
  });
});
