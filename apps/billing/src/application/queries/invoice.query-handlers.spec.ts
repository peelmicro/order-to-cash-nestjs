// Pure unit — a fake `InvoiceReadPort`/`Clock`, never a real database.
// Proves plain delegation, nothing more (the SELECTs themselves are the
// repository's integration tests, E4), including that `now` is read from
// the injected clock and passed through, not the ambient system clock.
import { describe, expect, it } from 'vitest';
import type { InvoiceListReplyPayload, InvoiceListRequestPayload } from '@otc/contracts';
import type { Clock } from '../ports/clock.port.js';
import type { InvoiceReadPort } from '../ports/invoice-read.port.js';
import { ListInvoicesHandler } from './invoice.query-handlers.js';
import { ListInvoicesQuery } from './invoice.queries.js';

describe('ListInvoicesHandler', () => {
  it('delegates to InvoiceReadPort.list with the query request and the clock\'s current time, unchanged', async () => {
    const reply: InvoiceListReplyPayload = { items: [], page: { page: 1, pageSize: 25, total: 0 } };
    let seenRequest: InvoiceListRequestPayload | undefined;
    let seenNow: Date | undefined;
    const invoiceRead: InvoiceReadPort = {
      async list(request, now) {
        seenRequest = request;
        seenNow = now;
        return reply;
      },
    };
    const fixedNow = new Date('2026-08-21T10:00:00.000Z');
    const clock: Clock = { now: () => fixedNow };
    const request: InvoiceListRequestPayload = { page: 2, pageSize: 10 };
    const handler = new ListInvoicesHandler(invoiceRead, clock);

    const result = await handler.execute(new ListInvoicesQuery(request));

    expect(result).toBe(reply);
    expect(seenRequest).toBe(request);
    expect(seenNow).toEqual(fixedNow);
  });
});
