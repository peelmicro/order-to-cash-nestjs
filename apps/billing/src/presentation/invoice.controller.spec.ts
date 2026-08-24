// Pure unit — fake `QueryBus`/`CommandBus` (CLAUDE.md § Testing
// conventions). Proves: `BI2`'s header refusal on issue; the subject
// constants equal the AsyncAPI channel addresses (read-the-spec-as-text,
// `BI16` half); a validation failure replies RpcError and dispatches
// nothing; a handler error is mapped to an RpcError; the controller never
// throws.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NatsContext } from '@nestjs/microservices';
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import { INVOICE_ISSUE_SUBJECT, INVOICE_LIST_SUBJECT, InvoiceController, PAYMENT_REGISTER_SUBJECT } from './invoice.controller';
import { InvoiceNotFoundError, NoActiveCreditHoldError } from '../application/invoice-application-errors';

const ASYNCAPI_SPEC_PATH = path.resolve(__dirname, '../../../../specs/shared/asyncapi.yaml');

function channelAddress(specText: string, channelName: string): string {
  const blockMatch = specText.match(new RegExp(`\\n {2}${channelName}:\\n([\\s\\S]*?)\\n {2}\\S`));
  if (!blockMatch) {
    throw new Error(`invoice.controller.spec: could not locate the ${channelName} channel block`);
  }
  const addressMatch = blockMatch[1]!.match(/address:\s*(\S+)/);
  if (!addressMatch) {
    throw new Error(`invoice.controller.spec: ${channelName} channel has no address`);
  }
  return addressMatch[1]!;
}

describe('InvoiceController — BI16 half, subject constants match the AsyncAPI addresses', () => {
  it('uses exactly the two documented subjects, read from asyncapi.yaml as text', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');

    expect(INVOICE_ISSUE_SUBJECT).toBe(channelAddress(specText, 'invoiceIssue'));
    expect(INVOICE_LIST_SUBJECT).toBe(channelAddress(specText, 'invoiceList'));
  });

  // feature 22 — the same read-the-spec-as-text assertion, extended.
  it('uses exactly the documented subject for billing.payment.register, read from asyncapi.yaml as text', () => {
    const specText = readFileSync(ASYNCAPI_SPEC_PATH, 'utf8');

    expect(PAYMENT_REGISTER_SUBJECT).toBe(channelAddress(specText, 'paymentRegister'));
  });
});

function fakeContext(headers?: Record<string, string>): NatsContext {
  const headerRecord: Record<string, string> = headers ?? {};
  const hdrs = headers ? { get: (key: string) => headerRecord[key] ?? '' } : undefined;
  return new NatsContext(['billing.invoice.issue', hdrs]);
}

function buses() {
  const queryExecute = vi.fn();
  const commandExecute = vi.fn();
  const queries = { execute: queryExecute } as unknown as import('@nestjs/cqrs').QueryBus;
  const commands = { execute: commandExecute } as unknown as import('@nestjs/cqrs').CommandBus;
  return { queries, commands, queryExecute, commandExecute };
}

const VALID_REQUEST = {
  orderReference: 'ORD-000001',
  retailerCode: 'RET-0001',
  companyCode: 'COM-0001',
  currency: 'EUR',
  lines: [{ productCode: 'PRD-0001', units: 2, unitPrice: 1_000 }],
};

describe('InvoiceController — BI2 header refusal', () => {
  it('refuses an issue request without a valid correlation and request id before dispatching', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new InvoiceController(queries, commands);

    const noHeaders = await controller.issue(VALID_REQUEST, fakeContext());
    expect(noHeaders).toMatchObject({ code: 'VALIDATION_FAILED' });

    const malformed = await controller.issue(VALID_REQUEST, fakeContext({ 'x-correlation-id': 'not-a-uuid', 'x-request-id': UniqueId.generate().value }));
    expect(malformed).toMatchObject({ code: 'VALIDATION_FAILED' });

    const missingOne = await controller.issue(VALID_REQUEST, fakeContext({ 'x-correlation-id': UniqueId.generate().value }));
    expect(missingOne).toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('dispatches with the parsed correlationId/requestId when headers are present and valid', async () => {
    const { queries, commands, commandExecute } = buses();
    commandExecute.mockResolvedValue({
      orderReference: 'ORD-000001',
      invoiceReference: 'INV-000001',
      invoiceDate: '2026-08-21T10:00:00.000Z',
      currency: 'EUR',
      totalAmount: 2_000,
      status: 'issued',
      created: true,
    });
    const controller = new InvoiceController(queries, commands);
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    await controller.issue(VALID_REQUEST, fakeContext({ 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value }));

    expect(commandExecute).toHaveBeenCalledTimes(1);
    const dispatchedCommand = commandExecute.mock.calls[0]![0];
    expect(dispatchedCommand.correlationId.equals(correlationId)).toBe(true);
    expect(dispatchedCommand.requestId.equals(requestId)).toBe(true);
  });
});

describe('InvoiceController — validation and error mapping, never throws', () => {
  it('a validation failure on billing.invoice.issue replies RpcError and dispatches nothing', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new InvoiceController(queries, commands);

    const result = await controller.issue(
      { orderReference: 'not-a-valid-reference', retailerCode: 'RET-0001', companyCode: 'COM-0001', currency: 'EUR', lines: [] },
      fakeContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );

    expect(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(commandExecute).not.toHaveBeenCalled();
  });

  // N2 (review_billing_invoicing.md) — BI2's "a discount that exceeds the
  // computed amount" clause. The property under test is NOT the error
  // code (a correct code would also pass if the check sat uselessly
  // inside the transactional handler) but that the command is never
  // dispatched at all: IssueInvoiceCommand's only handler
  // (invoice.command-handlers.ts) delegates straight into
  // InvoiceIssueHandler.issue, which is the sole caller of
  // unitOfWork.execute — so commandExecute never being called is direct
  // proof no transaction was opened and no lock was ever taken.
  it('refuses a discount that exceeds the computed amount before dispatching to the command bus', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new InvoiceController(queries, commands);

    const result = await controller.issue(
      { ...VALID_REQUEST, lines: [{ productCode: 'PRD-0001', units: 2, unitPrice: 1_000 }], discount: 2_001 },
      fakeContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );

    expect(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('a validation failure on billing.invoice.list replies RpcError and dispatches nothing', async () => {
    const { queries, commands, queryExecute } = buses();
    const controller = new InvoiceController(queries, commands);

    const result = await controller.list({ page: 0 });

    expect(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(queryExecute).not.toHaveBeenCalled();
  });

  it('a handler error on billing.invoice.issue is mapped to an RpcError, not thrown', async () => {
    const { queries, commands, commandExecute } = buses();
    commandExecute.mockRejectedValue(new NoActiveCreditHoldError('ORD-000001'));
    const controller = new InvoiceController(queries, commands);

    const result = await controller.issue(
      VALID_REQUEST,
      fakeContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );

    expect(result).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('a handler error on billing.invoice.list is mapped to an RpcError, not thrown', async () => {
    const { queries, commands, queryExecute } = buses();
    queryExecute.mockRejectedValue(new Error('boom'));
    const controller = new InvoiceController(queries, commands);

    const result = await controller.list({ page: 1, pageSize: 25 });

    expect(result).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

const VALID_PAYMENT_REQUEST = {
  invoiceReference: 'INV-000001',
  paymentReference: 'PAY-000001',
  amount: { amount: 2_000, currency: 'EUR' },
  valueDate: '2026-08-21T10:00:00.000Z',
  source: 'robot' as const,
};

function fakePaymentContext(headers?: Record<string, string>): NatsContext {
  const headerRecord: Record<string, string> = headers ?? {};
  const hdrs = headers ? { get: (key: string) => headerRecord[key] ?? '' } : undefined;
  return new NatsContext([PAYMENT_REGISTER_SUBJECT, hdrs]);
}

describe('InvoiceController — billing.payment.register (feature 22, R47-R49)', () => {
  it('refuses a request without a valid correlation and request id before dispatching', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new InvoiceController(queries, commands);

    const noHeaders = await controller.registerPayment(VALID_PAYMENT_REQUEST, fakePaymentContext());
    expect(noHeaders).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('refuses a payload naming neither invoiceId nor invoiceReference before dispatching', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new InvoiceController(queries, commands);

    const result = await controller.registerPayment(
      { ...VALID_PAYMENT_REQUEST, invoiceReference: undefined },
      fakePaymentContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );

    expect(result).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('refuses an out-of-range paymentReference, amount, valueDate or source before dispatching', async () => {
    const { queries, commands, commandExecute } = buses();
    const controller = new InvoiceController(queries, commands);

    const badReference = await controller.registerPayment(
      { ...VALID_PAYMENT_REQUEST, paymentReference: '' },
      fakePaymentContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );
    expect(badReference).toMatchObject({ code: 'VALIDATION_FAILED' });

    const badSource = await controller.registerPayment(
      { ...VALID_PAYMENT_REQUEST, source: 'n8n' },
      fakePaymentContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );
    expect(badSource).toMatchObject({ code: 'VALIDATION_FAILED' });

    const badDate = await controller.registerPayment(
      { ...VALID_PAYMENT_REQUEST, valueDate: 'not-a-date' },
      fakePaymentContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );
    expect(badDate).toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(commandExecute).not.toHaveBeenCalled();
  });

  it('dispatches with the parsed correlationId/requestId when headers are present and valid', async () => {
    const { queries, commands, commandExecute } = buses();
    commandExecute.mockResolvedValue({
      outcome: 'accepted',
      paymentReference: 'PAY-000001',
      invoiceReference: 'INV-000001',
      orderReference: 'ORD-000001',
      invoiceStatus: 'paid',
      paidAt: '2026-08-21T10:00:00.000Z',
    });
    const controller = new InvoiceController(queries, commands);
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const result = await controller.registerPayment(
      VALID_PAYMENT_REQUEST,
      fakePaymentContext({ 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value }),
    );

    expect(commandExecute).toHaveBeenCalledTimes(1);
    const dispatchedCommand = commandExecute.mock.calls[0]![0];
    expect(dispatchedCommand.correlationId.equals(correlationId)).toBe(true);
    expect(dispatchedCommand.requestId.equals(requestId)).toBe(true);
    expect(result).toMatchObject({ outcome: 'accepted' });
  });

  it('a handler error on billing.payment.register is mapped to an RpcError, not thrown', async () => {
    const { queries, commands, commandExecute } = buses();
    commandExecute.mockRejectedValue(new InvoiceNotFoundError('INV-999999'));
    const controller = new InvoiceController(queries, commands);

    const result = await controller.registerPayment(
      VALID_PAYMENT_REQUEST,
      fakePaymentContext({ 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value }),
    );

    expect(result).toMatchObject({ code: 'NOT_FOUND' });
  });
});
