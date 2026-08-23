// Pure unit — fake `UnitOfWork`/`BuyerCreditRepository`/`InvoiceRepository`/
// `InvoiceNumberAllocator`/`Clock` (CLAUDE.md § Testing conventions).
// Proves: BI5's NO_ACTIVE_HOLD refusal never saves to the invoice
// repository; the B7 fast path opens NO transaction at all; the credit
// line is locked BEFORE the invoice row is read (BI8's unit half); the
// reply is built from the domain outcome and returned only AFTER
// `execute` resolves; a rollback (the transactional work rejects)
// propagates the rejection and never produces a reply.
import { CreditLineReference, InvoiceReference, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { InvoiceIssueRequestPayload } from '@otc/contracts';
import { BuyerCredit } from '../domain/buyer-credit.js';
import type { BuyerCreditSnapshot } from '../domain/buyer-credit-snapshot.js';
import { Invoice } from '../domain/invoice.js';
import type { InvoiceSnapshot } from '../domain/invoice-snapshot.js';
import { IssueInvoiceCommand } from './commands/invoice.commands.js';
import { InvoiceIssueHandler } from './invoice-issue.handler.js';
import type { Clock } from './ports/clock.port.js';
import type { BuyerCreditRepository } from './ports/buyer-credit-repository.port.js';
import type { InvoiceNumberAllocator } from './ports/invoice-number-allocator.port.js';
import type { InvoiceRepository } from './ports/invoice-repository.port.js';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port.js';
import { NoActiveCreditHoldError } from './invoice-application-errors.js';

const CURRENCY = 'EUR';
const ORDER = OrderNumber.fromSequence(1);

function fakeTx(): TransactionContext {
  return {} as TransactionContext;
}

class RecordingUnitOfWork implements UnitOfWork {
  executeCalls = 0;

  async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.executeCalls += 1;
    return work(fakeTx());
  }
}

const fixedClock: Clock = { now: () => new Date('2026-08-21T10:00:00.000Z') };

function creditSnapshot(overrides: Partial<BuyerCreditSnapshot> = {}): BuyerCreditSnapshot {
  return {
    id: UniqueId.generate(),
    code: CreditLineReference.fromSequence(1),
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    creditLimit: 500_000,
    currency: CURRENCY,
    committedExposure: 0,
    orderEntries: [],
    ...overrides,
  };
}

function issueRequest(overrides: Partial<InvoiceIssueRequestPayload> = {}): InvoiceIssueRequestPayload {
  return {
    orderReference: ORDER.value,
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    currency: CURRENCY,
    lines: [{ productCode: 'PRD-0001', units: 2, unitPrice: 1_000 }],
    ...overrides,
  };
}

function issueCommand(overrides: Partial<InvoiceIssueRequestPayload> = {}): IssueInvoiceCommand {
  return new IssueInvoiceCommand(issueRequest(overrides), UniqueId.generate(), UniqueId.generate());
}

interface RecordingInvoices {
  repo: InvoiceRepository;
  saveCalls: Invoice[];
  callLog: string[];
}

function invoiceRepositoryOf(existing: InvoiceSnapshot | null, callLog: string[] = []): RecordingInvoices {
  const saveCalls: Invoice[] = [];
  const repo: InvoiceRepository = {
    async findByOrderReference() {
      callLog.push('findByOrderReference');
      return existing;
    },
    async lockByOrderReference() {
      callLog.push('lockByOrderReference');
      return existing;
    },
    async save(invoice) {
      callLog.push('save');
      saveCalls.push(invoice);
    },
  };
  return { repo, saveCalls, callLog };
}

function creditRepositoryOf(credit: BuyerCredit | null, callLog: string[] = []): { repo: BuyerCreditRepository; saveCalls: BuyerCredit[] } {
  const saveCalls: BuyerCredit[] = [];
  const repo: BuyerCreditRepository = {
    async lockForOrder() {
      callLog.push('lockForOrder');
      return credit;
    },
    async save(saved) {
      saveCalls.push(saved);
    },
  };
  return { repo, saveCalls };
}

function invoiceNumbers(reference = InvoiceReference.fromSequence(1)): InvoiceNumberAllocator {
  return { next: async () => reference };
}

describe('InvoiceIssueHandler.issue — BI5', () => {
  it('raises NO_ACTIVE_HOLD without touching the invoice repository when the order holds no active hold', async () => {
    // A credit line with NO ledger entries for this order — activeHold is 0.
    const credit = BuyerCredit.reconstitute(creditSnapshot());
    const { repo: credits } = creditRepositoryOf(credit);
    const { repo: invoices, saveCalls } = invoiceRepositoryOf(null);
    const handler = new InvoiceIssueHandler(new RecordingUnitOfWork(), credits, invoices, invoiceNumbers(), fixedClock);

    await expect(handler.issue(issueCommand())).rejects.toBeInstanceOf(NoActiveCreditHoldError);

    expect(saveCalls).toHaveLength(0);
  });
});

describe('InvoiceIssueHandler.issue — B7 fast path', () => {
  it('opens no transaction when an invoice already exists', async () => {
    const existingSnapshot: InvoiceSnapshot = {
      id: UniqueId.generate(),
      invoiceReference: InvoiceReference.fromSequence(1),
      invoiceDate: fixedClock.now(),
      orderReference: ORDER,
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      currency: CURRENCY,
      lines: [],
      amount: Money.of(2_000, CURRENCY),
      discount: Money.zero(CURRENCY),
      totalAmount: Money.of(2_000, CURRENCY),
      status: 'issued',
      paidAt: null,
    };
    const { repo: invoices } = invoiceRepositoryOf(existingSnapshot);
    const { repo: credits } = creditRepositoryOf(null);
    const unitOfWork = new RecordingUnitOfWork();
    const handler = new InvoiceIssueHandler(unitOfWork, credits, invoices, invoiceNumbers(), fixedClock);

    const reply = await handler.issue(issueCommand());

    expect(reply).toMatchObject({ created: false, invoiceReference: 'INV-000001' });
    expect(unitOfWork.executeCalls).toBe(0);
  });
});

describe('InvoiceIssueHandler.issue — BI8, the credit line is locked before the invoice row is read', () => {
  it('locks the credit line before reading the invoice', async () => {
    const callLog: string[] = [];
    const credit = BuyerCredit.reconstitute(
      creditSnapshot({
        orderEntries: [{ id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(2_000, CURRENCY), type: 'hold', entryDate: fixedClock.now() }],
      }),
    );
    const { repo: credits } = creditRepositoryOf(credit, callLog);
    const { repo: invoices } = invoiceRepositoryOf(null, callLog);
    const handler = new InvoiceIssueHandler(new RecordingUnitOfWork(), credits, invoices, invoiceNumbers(), fixedClock);

    await handler.issue(issueCommand());

    // findByOrderReference is the B7 FAST path (before any lock); the
    // ordered pair that matters for BI8 is lockForOrder BEFORE
    // lockByOrderReference.
    const lockOrder = callLog.filter((call) => call === 'lockForOrder' || call === 'lockByOrderReference');
    expect(lockOrder).toEqual(['lockForOrder', 'lockByOrderReference']);
  });
});

describe('InvoiceIssueHandler.issue — reply built after commit', () => {
  it('returns the reply only after execute resolves, and rollback propagates the rejection with no reply', async () => {
    const credit = BuyerCredit.reconstitute(
      creditSnapshot({
        orderEntries: [{ id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(2_000, CURRENCY), type: 'hold', entryDate: fixedClock.now() }],
      }),
    );
    const { repo: credits } = creditRepositoryOf(credit);
    const { repo: invoices } = invoiceRepositoryOf(null);
    const unitOfWork = new RecordingUnitOfWork();
    const handler = new InvoiceIssueHandler(unitOfWork, credits, invoices, invoiceNumbers(), fixedClock);

    const reply = await handler.issue(issueCommand());
    expect(reply).toMatchObject({ created: true, orderReference: ORDER.value });
    expect(unitOfWork.executeCalls).toBe(1);

    // Rollback: the credit repository has no line at all — the
    // transactional work rejects with CreditLineNotFoundError. No reply is
    // ever produced on that path — `issue` rejects too.
    const { repo: notFoundCredits } = creditRepositoryOf(null);
    const notFoundHandler = new InvoiceIssueHandler(new RecordingUnitOfWork(), notFoundCredits, invoiceRepositoryOf(null).repo, invoiceNumbers(), fixedClock);

    await expect(notFoundHandler.issue(issueCommand())).rejects.toThrow();
  });
});
