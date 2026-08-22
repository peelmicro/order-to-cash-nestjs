// Pure unit — a fake `CreditReadPort`, never a real database. Proves plain
// delegation, nothing more (the SELECTs themselves are the repository's
// integration tests, D3/D4).
import { describe, expect, it } from 'vitest';
import type { CreditListReplyPayload, CreditListRequestPayload } from '@otc/contracts';
import type { CreditReadPort } from '../ports/credit-read.port.js';
import { ListCreditHandler } from './credit.query-handlers.js';
import { ListCreditQuery } from './credit.queries.js';

describe('ListCreditHandler', () => {
  it('delegates to CreditReadPort.list with the query request, unchanged', async () => {
    const reply: CreditListReplyPayload = { items: [], page: { page: 1, pageSize: 25, total: 0 } };
    let seenRequest: CreditListRequestPayload | undefined;
    const creditRead: CreditReadPort = {
      async list(request) {
        seenRequest = request;
        return reply;
      },
    };
    const request: CreditListRequestPayload = { page: 2, pageSize: 10 };
    const handler = new ListCreditHandler(creditRead);

    const result = await handler.execute(new ListCreditQuery(request));

    expect(result).toBe(reply);
    expect(seenRequest).toBe(request);
  });
});
