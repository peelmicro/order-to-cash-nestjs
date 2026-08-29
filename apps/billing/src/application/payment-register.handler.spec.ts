// Pure unit — fake `UnitOfWork`/`BuyerCreditRepository`/`InvoiceRepository`/
// `Clock` (CLAUDE.md § Testing conventions), mirrors
// `invoice-issue.handler.spec.ts`'s shape exactly. Proves: the R48 fast
// path opens NO transaction at all; the credit line is locked BEFORE the
// invoice row (BI8, extended to `billing.payment.register`); the R48
// authority re-read under the invoice lock answers `duplicate` and writes
// NOTHING new; R49's three refusals (currency, amount, already-paid-under-
// a-different-reference) write NOTHING and are observable at the fake
// level — never a post-rollback DB read (the N10 rule); `Invoice.markPaid`
// and `BuyerCredit.releaseHold` are BOTH actually called on the happy
// path, each armed against its own deletion; `invoices.markPaid` is
// called strictly BEFORE `credits.save` (R47's ordering, armed against a
// swap); the reply is built from the domain outcome and returned only
// AFTER `execute` resolves — a rollback never produces a reply.
import {
  CreditLineReference,
  InvoiceReference,
  Money,
  OrderNumber,
  Quantity,
  UniqueId,
} from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { PaymentRegisterRequestPayload } from '@otc/contracts';
import { BuyerCredit } from '../domain/buyer-credit.js';
import type { BuyerCreditSnapshot } from '../domain/buyer-credit-snapshot.js';
import { Invoice } from '../domain/invoice.js';
import type { InvoiceSnapshot } from '../domain/invoice-snapshot.js';
import { CreditLineNotFoundError } from './credit-application-errors.js';
import { InvoiceAlreadyPaidError, InvoicePaymentAmountMismatchError, InvoicePaymentCurrencyMismatchError } from '../domain/invoice-errors.js';
import { PaymentReferenceConflictError } from './invoice-application-errors.js';
import { RegisterPaymentCommand } from './commands/payment.commands.js';
import { PaymentRegisterHandler } from './payment-register.handler.js';
import type { Clock } from './ports/clock.port.js';
import type { BuyerCreditRepository } from './ports/buyer-credit-repository.port.js';
import type { InvoiceRepository, PaymentRecordSnapshot } from './ports/invoice-repository.port.js';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port.js';

const CURRENCY = 'EUR';
const ORDER = OrderNumber.fromSequence(1);
const INVOICE_REF = InvoiceReference.fromSequence(1);
const OTHER_INVOICE_REF = InvoiceReference.fromSequence(2);
const TOTAL_AMOUNT = 2_000;
const HOLD_AMOUNT = 2_000; // the whole order — mirrors `invoice-issue.handler`'s consume of the full active hold.

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

const fixedClock: Clock = { now: () => new Date('2026-08-24T10:00:00.000Z') };

function invoiceSnapshot(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    id: UniqueId.generate(),
    invoiceReference: INVOICE_REF,
    invoiceDate: new Date('2026-08-20T10:00:00.000Z'),
    orderReference: ORDER,
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    currency: CURRENCY,
    lines: [{ id: UniqueId.generate(), productCode: 'PRD-0001', units: Quantity.of(2), unitPrice: Money.of(1_000, CURRENCY) }],
    amount: Money.of(TOTAL_AMOUNT, CURRENCY),
    discount: Money.zero(CURRENCY),
    totalAmount: Money.of(TOTAL_AMOUNT, CURRENCY),
    status: 'issued',
    paidAt: null,
    ...overrides,
  };
}

function creditSnapshot(overrides: Partial<BuyerCreditSnapshot> = {}): BuyerCreditSnapshot {
  return {
    id: UniqueId.generate(),
    code: CreditLineReference.fromSequence(1),
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    creditLimit: 500_000,
    currency: CURRENCY,
    // Mirrors the post-`invoice.issue` ledger state: a `hold` converted by
    // `consumeHold` (numerically neutral — `credit-exposure.ts`), so
    // `committedExposure` still carries the full hold amount and
    // `releaseHold` has exactly `HOLD_AMOUNT` of outstanding exposure to
    // release.
    committedExposure: HOLD_AMOUNT,
    orderEntries: [
      { id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(HOLD_AMOUNT, CURRENCY), type: 'hold', entryDate: new Date('2026-08-19T10:00:00.000Z') },
      { id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(HOLD_AMOUNT, CURRENCY), type: 'consume', entryDate: new Date('2026-08-20T10:00:00.000Z') },
    ],
    ...overrides,
  };
}

function paymentRequest(overrides: Partial<PaymentRegisterRequestPayload> = {}): PaymentRegisterRequestPayload {
  return {
    invoiceReference: INVOICE_REF.value,
    paymentReference: 'PAY-000001',
    amount: { amount: TOTAL_AMOUNT, currency: CURRENCY },
    valueDate: '2026-08-24T09:00:00.000Z',
    source: 'robot',
    ...overrides,
  };
}

function registerCommand(overrides: Partial<PaymentRegisterRequestPayload> = {}): RegisterPaymentCommand {
  return new RegisterPaymentCommand(paymentRequest(overrides), UniqueId.generate(), UniqueId.generate());
}

interface RecordedMarkPaid {
  readonly invoice: Invoice;
  readonly events: readonly { eventType: string; eventId: UniqueId; causationId: UniqueId }[];
}

interface RecordingInvoices {
  repo: InvoiceRepository;
  callLog: string[];
  markPaidCalls: RecordedMarkPaid[];
}

interface InvoiceRepoOptions {
  readonly fastPathPayment?: PaymentRecordSnapshot | null;
  readonly identitySnapshot: InvoiceSnapshot | null;
  readonly lockedSnapshot?: InvoiceSnapshot | null;
  readonly authorityPayment?: PaymentRecordSnapshot | null;
}

function invoiceRepositoryOf(options: InvoiceRepoOptions): RecordingInvoices {
  const callLog: string[] = [];
  const markPaidCalls: RecordedMarkPaid[] = [];
  const locked = options.lockedSnapshot === undefined ? options.identitySnapshot : options.lockedSnapshot;

  const repo: InvoiceRepository = {
    async findByOrderReference() {
      throw new Error('not used by billing.payment.register');
    },
    async lockByOrderReference() {
      throw new Error('not used by billing.payment.register');
    },
    async save() {
      throw new Error('not used by billing.payment.register');
    },
    async findById() {
      callLog.push('findById');
      return options.identitySnapshot;
    },
    async findByInvoiceReference() {
      callLog.push('findByInvoiceReference');
      return options.identitySnapshot;
    },
    async lockById() {
      callLog.push('lockById');
      return locked;
    },
    async findPaymentByReference() {
      callLog.push('findPaymentByReference');
      return options.fastPathPayment ?? null;
    },
    async findPaymentByInvoiceId() {
      callLog.push('findPaymentByInvoiceId');
      return options.authorityPayment ?? null;
    },
    async markPaid(invoice) {
      callLog.push('markPaid');
      markPaidCalls.push({ invoice, events: invoice.pullDomainEvents() });
    },
  };
  return { repo, callLog, markPaidCalls };
}

interface RecordedSave {
  readonly credit: BuyerCredit;
  readonly events: readonly { eventType: string; eventId: UniqueId; causationId: UniqueId }[];
}

interface RecordingCredits {
  repo: BuyerCreditRepository;
  callLog: string[];
  saveCalls: RecordedSave[];
}

function creditRepositoryOf(credit: BuyerCredit | null, callLog: string[] = []): RecordingCredits {
  const saveCalls: RecordedSave[] = [];
  const repo: BuyerCreditRepository = {
    async lockForOrder() {
      callLog.push('lockForOrder');
      return credit;
    },
    async save(savedCredit) {
      callLog.push('creditsSave');
      saveCalls.push({ credit: savedCredit, events: savedCredit.pullDomainEvents() });
    },
  };
  return { repo, callLog, saveCalls };
}

function freshCredit(overrides: Partial<BuyerCreditSnapshot> = {}): BuyerCredit {
  return BuyerCredit.reconstitute(creditSnapshot(overrides));
}

describe('PaymentRegisterHandler — R47, the happy path', () => {
  it('locks the credit line before the invoice row (BI8), calls Invoice.markPaid and BuyerCredit.releaseHold, persists the invoice BEFORE the credit line, and replies accepted', async () => {
    const callLog: string[] = [];
    const { repo: invoices, markPaidCalls } = invoiceRepositoryOf({ identitySnapshot: invoiceSnapshot() });
    // Route both repos through the SAME callLog so ordering is observable
    // across the two aggregates, not just within one.
    const sharedInvoices: InvoiceRepository = {
      ...invoices,
      findByInvoiceReference: async (...args) => {
        callLog.push('findByInvoiceReference');
        return invoices.findByInvoiceReference(...args);
      },
      lockById: async (...args) => {
        callLog.push('lockById');
        return invoices.lockById(...args);
      },
      markPaid: async (...args) => {
        callLog.push('markPaid');
        return invoices.markPaid(...args);
      },
    };
    const { repo: credits, saveCalls } = creditRepositoryOf(freshCredit(), callLog);
    const unitOfWork = new RecordingUnitOfWork();
    const handler = new PaymentRegisterHandler(unitOfWork, credits, sharedInvoices, fixedClock);

    const cmd = registerCommand();
    const reply = await handler.register(cmd);

    expect(unitOfWork.executeCalls).toBe(1);
    expect(reply).toMatchObject({ outcome: 'accepted', invoiceReference: INVOICE_REF.value, orderReference: ORDER.value, invoiceStatus: 'paid' });
    expect(reply.paidAt).toBe(fixedClock.now().toISOString());

    // BI8, extended: credits BEFORE the invoice row.
    const lockForOrderIdx = callLog.indexOf('lockForOrder');
    const lockByIdIdx = callLog.indexOf('lockById');
    expect(lockForOrderIdx).toBeGreaterThanOrEqual(0);
    expect(lockByIdIdx).toBeGreaterThan(lockForOrderIdx);

    // R47's ordering: invoices.markPaid (payment.received.v1) BEFORE
    // credits.save (credit.released.v1).
    const markPaidIdx = callLog.indexOf('markPaid');
    const creditsSaveIdx = callLog.indexOf('creditsSave');
    expect(markPaidIdx).toBeGreaterThanOrEqual(0);
    expect(creditsSaveIdx).toBeGreaterThan(markPaidIdx);

    // Invoice.markPaid was actually called: exactly one payment.received.v1
    // reaches the repository's `markPaid`.
    expect(markPaidCalls).toHaveLength(1);
    expect(markPaidCalls[0]!.events.map((e) => e.eventType)).toEqual(['payment.received.v1']);
    expect(markPaidCalls[0]!.invoice.status).toBe('paid');

    // BuyerCredit.releaseHold was actually called: exactly one
    // credit.released.v1 reaches the repository's `save`.
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]!.events.map((e) => e.eventType)).toEqual(['credit.released.v1']);
    // The ledger identity: outstanding = hold - release = HOLD_AMOUNT,
    // fully released — availableCredit returns to creditLimit exactly.
    expect(saveCalls[0]!.credit.availableCredit).toEqual(Money.of(500_000, CURRENCY));

    // Amendment A1 (open point 2, progress/spec_projector_timeline_ordering.md)
    // — `credit.released.v1`'s `causationId` is `payment.received.v1`'s OWN
    // `eventId`, NOT `cmd.requestId`. Before this change both facts shared
    // `cmd.requestId` as their `causationId` and were siblings, not a
    // chain — the projector's causal-edge timeline rule (PR10) could not
    // order them. This assertion fails if `payment-register.handler.ts`
    // reverts to reusing `ctx.causationId` for the release.
    const paymentEventId = markPaidCalls[0]!.events[0]!.eventId;
    const releaseCausationId = saveCalls[0]!.events[0]!.causationId;
    expect(releaseCausationId).toEqual(paymentEventId);
    expect(releaseCausationId).not.toEqual(cmd.requestId);
  });

  it('resolves the target invoice by invoiceId when invoiceReference is absent', async () => {
    const snapshot = invoiceSnapshot();
    const { repo: invoices, callLog } = invoiceRepositoryOf({ identitySnapshot: snapshot });
    const { repo: credits } = creditRepositoryOf(freshCredit());
    const handler = new PaymentRegisterHandler(new RecordingUnitOfWork(), credits, invoices, fixedClock);

    await handler.register(registerCommand({ invoiceReference: undefined, invoiceId: snapshot.id.value }));

    expect(callLog).toContain('findById');
    expect(callLog).not.toContain('findByInvoiceReference');
  });
});

describe('PaymentRegisterHandler — R48, idempotent by paymentReference', () => {
  it('the fast path answers duplicate WITHOUT opening a transaction at all', async () => {
    const paidSnapshot = invoiceSnapshot({ status: 'paid', paidAt: fixedClock.now() });
    const existingPayment: PaymentRecordSnapshot = {
      id: UniqueId.generate(),
      paymentReference: 'PAY-000001',
      invoiceId: paidSnapshot.id,
      amount: Money.of(TOTAL_AMOUNT, CURRENCY),
      valueDate: new Date('2026-08-24T09:00:00.000Z'),
      source: 'robot',
      createdAt: fixedClock.now(),
    };
    const { repo: invoices, callLog } = invoiceRepositoryOf({ fastPathPayment: existingPayment, identitySnapshot: paidSnapshot });
    const { repo: credits } = creditRepositoryOf(freshCredit());
    const unitOfWork = new RecordingUnitOfWork();
    const handler = new PaymentRegisterHandler(unitOfWork, credits, invoices, fixedClock);

    const reply = await handler.register(registerCommand());

    expect(reply).toMatchObject({ outcome: 'duplicate', paymentReference: 'PAY-000001', invoiceStatus: 'paid' });
    expect(unitOfWork.executeCalls).toBe(0);
    expect(callLog).not.toContain('lockById');
    expect(callLog).not.toContain('markPaid');
  });

  // N11 (review_billing_remittance_intake.md) — the fast path used to
  // answer a success-shaped `duplicate` for a paymentReference recorded
  // against a DIFFERENT invoice than the one the caller named. This is
  // the SAME condition the concurrent path's UNIQUE-constraint backstop
  // (`PaymentReferenceConflictError`) already refuses; the property under
  // test is that this path answers it the SAME way, not merely that it
  // answers with a plausible error.
  it('the fast path raises PaymentReferenceConflictError, opening no transaction, when the recorded paymentReference belongs to a DIFFERENT invoice than the one named (N11)', async () => {
    const paidSnapshot = invoiceSnapshot({ status: 'paid', paidAt: fixedClock.now() }); // invoiceReference = INVOICE_REF
    const existingPayment: PaymentRecordSnapshot = {
      id: UniqueId.generate(),
      paymentReference: 'PAY-000001',
      invoiceId: paidSnapshot.id,
      amount: Money.of(TOTAL_AMOUNT, CURRENCY),
      valueDate: new Date('2026-08-24T09:00:00.000Z'),
      source: 'robot',
      createdAt: fixedClock.now(),
    };
    const { repo: invoices, callLog, markPaidCalls } = invoiceRepositoryOf({ fastPathPayment: existingPayment, identitySnapshot: paidSnapshot });
    const { repo: credits, saveCalls } = creditRepositoryOf(freshCredit());
    const unitOfWork = new RecordingUnitOfWork();
    const handler = new PaymentRegisterHandler(unitOfWork, credits, invoices, fixedClock);

    // The request names a DIFFERENT invoiceReference than the one
    // PAY-000001 is actually recorded against.
    await expect(
      handler.register(registerCommand({ invoiceReference: OTHER_INVOICE_REF.value, paymentReference: 'PAY-000001' })),
    ).rejects.toThrow(PaymentReferenceConflictError);

    // Same "no transaction, no lock" property the genuine-redelivery case
    // above has — the mismatch is caught on the fast path, before any
    // lock is ever taken.
    expect(unitOfWork.executeCalls).toBe(0);
    expect(callLog).not.toContain('lockById');
    expect(markPaidCalls).toHaveLength(0);
    expect(saveCalls).toHaveLength(0);
  });

  it('the authority re-read under the invoice lock answers duplicate and writes NOTHING new, closing the race the fast path leaves open', async () => {
    // The fast path (step 0) misses — as if a concurrent identical
    // request had not yet committed when THIS request's step 0 ran — but
    // by the time this transaction takes the invoice's own row lock, the
    // concurrent request has committed: the LOCKED read shows `paid`,
    // under the SAME paymentReference.
    const issuedIdentity = invoiceSnapshot({ status: 'issued' });
    const paidLocked = invoiceSnapshot({ id: issuedIdentity.id, status: 'paid', paidAt: fixedClock.now() });
    const authorityPayment: PaymentRecordSnapshot = {
      id: UniqueId.generate(),
      paymentReference: 'PAY-000001',
      invoiceId: paidLocked.id,
      amount: Money.of(TOTAL_AMOUNT, CURRENCY),
      valueDate: new Date('2026-08-24T09:00:00.000Z'),
      source: 'robot',
      createdAt: fixedClock.now(),
    };
    const { repo: invoices, markPaidCalls } = invoiceRepositoryOf({
      identitySnapshot: issuedIdentity,
      lockedSnapshot: paidLocked,
      authorityPayment,
    });
    const { repo: credits, saveCalls } = creditRepositoryOf(freshCredit());
    const handler = new PaymentRegisterHandler(new RecordingUnitOfWork(), credits, invoices, fixedClock);

    const reply = await handler.register(registerCommand({ paymentReference: 'PAY-000001' }));

    expect(reply).toMatchObject({ outcome: 'duplicate', paymentReference: 'PAY-000001', invoiceStatus: 'paid' });
    // Nothing new was ATTEMPTED — not merely "nothing was written" (a
    // rolled-back write proves nothing about whether it was attempted,
    // per the N10 rule): the repository methods themselves are never
    // even called.
    expect(markPaidCalls).toHaveLength(0);
    expect(saveCalls).toHaveLength(0);
  });
});

describe('PaymentRegisterHandler — R49, refusals write nothing', () => {
  it('a DIFFERENT paymentReference against an already-paid invoice raises InvoiceAlreadyPaidError and writes nothing', async () => {
    const issuedIdentity = invoiceSnapshot({ status: 'issued' });
    const paidLocked = invoiceSnapshot({ id: issuedIdentity.id, status: 'paid', paidAt: fixedClock.now() });
    const authorityPayment: PaymentRecordSnapshot = {
      id: UniqueId.generate(),
      paymentReference: 'PAY-ORIGINAL',
      invoiceId: paidLocked.id,
      amount: Money.of(TOTAL_AMOUNT, CURRENCY),
      valueDate: new Date('2026-08-24T09:00:00.000Z'),
      source: 'robot',
      createdAt: fixedClock.now(),
    };
    const { repo: invoices, markPaidCalls } = invoiceRepositoryOf({ identitySnapshot: issuedIdentity, lockedSnapshot: paidLocked, authorityPayment });
    const { repo: credits, saveCalls } = creditRepositoryOf(freshCredit());
    const handler = new PaymentRegisterHandler(new RecordingUnitOfWork(), credits, invoices, fixedClock);

    await expect(handler.register(registerCommand({ paymentReference: 'PAY-DIFFERENT' }))).rejects.toThrow(InvoiceAlreadyPaidError);
    expect(markPaidCalls).toHaveLength(0);
    expect(saveCalls).toHaveLength(0);
  });

  it('an amount mismatch raises InvoicePaymentAmountMismatchError and writes nothing — the credit line is never touched', async () => {
    const { repo: invoices, markPaidCalls } = invoiceRepositoryOf({ identitySnapshot: invoiceSnapshot() });
    const { repo: credits, saveCalls } = creditRepositoryOf(freshCredit());
    const handler = new PaymentRegisterHandler(new RecordingUnitOfWork(), credits, invoices, fixedClock);

    await expect(
      handler.register(registerCommand({ amount: { amount: TOTAL_AMOUNT - 1, currency: CURRENCY } })),
    ).rejects.toThrow(InvoicePaymentAmountMismatchError);
    expect(markPaidCalls).toHaveLength(0);
    expect(saveCalls).toHaveLength(0);
  });

  it('a currency mismatch raises InvoicePaymentCurrencyMismatchError and writes nothing', async () => {
    const { repo: invoices, markPaidCalls } = invoiceRepositoryOf({ identitySnapshot: invoiceSnapshot() });
    const { repo: credits, saveCalls } = creditRepositoryOf(freshCredit());
    const handler = new PaymentRegisterHandler(new RecordingUnitOfWork(), credits, invoices, fixedClock);

    await expect(
      handler.register(registerCommand({ amount: { amount: TOTAL_AMOUNT, currency: 'GBP' } })),
    ).rejects.toThrow(InvoicePaymentCurrencyMismatchError);
    expect(markPaidCalls).toHaveLength(0);
    expect(saveCalls).toHaveLength(0);
  });
});

describe('PaymentRegisterHandler — identity and defensive refusals', () => {
  it('no invoice resolves for the given invoiceId/invoiceReference -> InvoiceNotFoundError, no transaction opened', async () => {
    const { repo: invoices } = invoiceRepositoryOf({ identitySnapshot: null });
    const { repo: credits } = creditRepositoryOf(freshCredit());
    const unitOfWork = new RecordingUnitOfWork();
    const handler = new PaymentRegisterHandler(unitOfWork, credits, invoices, fixedClock);

    await expect(handler.register(registerCommand())).rejects.toThrow('no invoice for');
    expect(unitOfWork.executeCalls).toBe(0);
  });

  it('no credit line for the resolved invoice -> CreditLineNotFoundError before the invoice row is ever locked', async () => {
    const { repo: invoices, callLog } = invoiceRepositoryOf({ identitySnapshot: invoiceSnapshot() });
    const { repo: credits } = creditRepositoryOf(null);
    const handler = new PaymentRegisterHandler(new RecordingUnitOfWork(), credits, invoices, fixedClock);

    await expect(handler.register(registerCommand())).rejects.toThrow(CreditLineNotFoundError);
    expect(callLog).not.toContain('lockById');
  });
});

describe('PaymentRegisterHandler — the reply is built from the domain outcome and returned only AFTER commit', () => {
  it('a rollback (the transactional work rejects) propagates the rejection and never produces a reply', async () => {
    const { repo: invoices } = invoiceRepositoryOf({ identitySnapshot: invoiceSnapshot() });
    const { repo: credits } = creditRepositoryOf(freshCredit());
    const failingUnitOfWork: UnitOfWork = {
      async execute() {
        throw new Error('simulated commit failure');
      },
    };
    const handler = new PaymentRegisterHandler(failingUnitOfWork, credits, invoices, fixedClock);

    await expect(handler.register(registerCommand())).rejects.toThrow('simulated commit failure');
  });
});
