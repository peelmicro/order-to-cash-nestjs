// Pure unit — proves plain delegation to `InvoiceIssueHandler`, nothing
// more (the transactional flow itself is `invoice-issue.handler.spec.ts`'s
// job).
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { InvoiceIssueReplyPayload, InvoiceIssueRequestPayload } from '@otc/contracts';
import type { InvoiceIssueHandler } from '../invoice-issue.handler.js';
import { IssueInvoiceCommand } from './invoice.commands.js';
import { IssueInvoiceHandler } from './invoice.command-handlers.js';

function request(): InvoiceIssueRequestPayload {
  return { orderReference: 'ORD-000001', retailerCode: 'RET-0001', companyCode: 'COM-0001', currency: 'EUR', lines: [{ productCode: 'PRD-0001', units: 2, unitPrice: 1_000 }] };
}

describe('IssueInvoiceHandler', () => {
  it('delegates to InvoiceIssueHandler.issue with the command, unchanged', async () => {
    const reply: InvoiceIssueReplyPayload = {
      orderReference: 'ORD-000001',
      invoiceReference: 'INV-000001',
      invoiceDate: '2026-08-21T10:00:00.000Z',
      currency: 'EUR',
      totalAmount: 2_000,
      status: 'issued',
      created: true,
    };
    let seenCommand: IssueInvoiceCommand | undefined;
    const fake = {
      async issue(command: IssueInvoiceCommand) {
        seenCommand = command;
        return reply;
      },
    } as unknown as InvoiceIssueHandler;
    const command = new IssueInvoiceCommand(request(), UniqueId.generate(), UniqueId.generate());
    const handler = new IssueInvoiceHandler(fake);

    const result = await handler.execute(command);

    expect(result).toBe(reply);
    expect(seenCommand).toBe(command);
  });
});
