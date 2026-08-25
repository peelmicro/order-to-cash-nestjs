// PR16 › renders a human-readable summary for each of the thirteen facts
// from the envelope alone, with every amount in integer minor units and its
// own currency.
import { describe, expect, it } from 'vitest';
import { ALL_FACT_ENVELOPE_BUILDERS } from '../test-support/envelope-fixtures';
import {
  creditApprovedSummary,
  creditRejectedSummary,
  creditReleasedSummary,
  invoiceIssuedSummary,
  orderCancelledSummary,
  orderCompletedSummary,
  orderConfirmedSummary,
  orderDespatchedSummary,
  orderPlacedSummary,
  paymentReceivedSummary,
  stockRejectedSummary,
  stockReleasedSummary,
  stockReservedSummary,
} from './summaries';

const BUILDERS: Readonly<Record<string, (payload: never) => { summary: string }>> = {
  'order.placed.v1': orderPlacedSummary,
  'stock.reserved.v1': stockReservedSummary,
  'stock.rejected.v1': stockRejectedSummary,
  'stock.released.v1': stockReleasedSummary,
  'credit.approved.v1': creditApprovedSummary,
  'credit.rejected.v1': creditRejectedSummary,
  'credit.released.v1': creditReleasedSummary,
  'order.confirmed.v1': orderConfirmedSummary,
  'order.despatched.v1': orderDespatchedSummary,
  'invoice.issued.v1': invoiceIssuedSummary,
  'payment.received.v1': paymentReceivedSummary,
  'order.completed.v1': orderCompletedSummary,
  'order.cancelled.v1': orderCancelledSummary,
};

describe('summaries — PR16 › renders a human-readable summary for each of the thirteen facts from the envelope alone, with every amount in integer minor units and its own currency', () => {
  it('covers exactly the thirteen fact types', () => {
    expect(Object.keys(BUILDERS).sort()).toEqual(Object.keys(ALL_FACT_ENVELOPE_BUILDERS).sort());
    expect(Object.keys(BUILDERS)).toHaveLength(13);
  });

  it.each(Object.entries(ALL_FACT_ENVELOPE_BUILDERS))('%s: renders a summary carrying the identifying reference, no float artefact', (eventType, build) => {
    const envelope = build();
    const builder = BUILDERS[eventType]!;
    const result = builder(envelope.payload as never);

    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
    // No floating-point artefact: minor units are never rendered with a
    // decimal point (money-format.ts's own contract).
    expect(result.summary).not.toMatch(/\d\.\d/);
  });

  const IDENTIFYING_REFERENCE: Readonly<Record<string, string>> = {
    'order.placed.v1': 'ORD-000001',
    'stock.reserved.v1': 'line(s)',
    'stock.rejected.v1': 'P1',
    'stock.released.v1': 'unit(s)',
    'credit.approved.v1': 'USD',
    'credit.rejected.v1': 'over_limit',
    'credit.released.v1': 'invoice paid',
    'order.confirmed.v1': 'ORDRSP',
    'order.despatched.v1': 'DES-000001',
    'invoice.issued.v1': 'INV-000001',
    'payment.received.v1': 'PAY-000001',
    'order.completed.v1': 'ORD-000001',
    'order.cancelled.v1': 'ORD-000001',
  };

  it.each(Object.entries(ALL_FACT_ENVELOPE_BUILDERS))('%s: the summary carries its own identifying reference', (eventType, build) => {
    const envelope = build();
    const builder = BUILDERS[eventType]!;
    const result = builder(envelope.payload as never);
    expect(result.summary).toContain(IDENTIFYING_REFERENCE[eventType]);
  });

  it('renders structured detail for the four facts design.md §4 lists', () => {
    expect(stockRejectedSummary(stockRejectedEnvelopePayload()).detail).toBeDefined();
    expect(stockReleasedSummary(stockReleasedEnvelopePayload()).detail).toBeDefined();
    expect(creditRejectedSummary(creditRejectedEnvelopePayload()).detail).toBeDefined();
    expect(orderCancelledSummary(orderCancelledEnvelopePayload()).detail).toBeDefined();
  });

  it('renders the .99 simulator example verbatim in the currency-suffixed integer form', () => {
    const result = creditRejectedSummary({
      orderReference: 'ORD-000001',
      retailerCode: 'RETAILER01',
      companyCode: 'COMPANY01',
      currency: 'EUR',
      requestedAmount: 24900,
      availableCredit: 500,
      reason: 'simulated_cents_rule',
    });
    expect(result.summary).toBe('Credit hold of 24 900 EUR rejected (simulated_cents_rule)');
  });
});

function stockRejectedEnvelopePayload() {
  return ALL_FACT_ENVELOPE_BUILDERS['stock.rejected.v1']!().payload as Parameters<typeof stockRejectedSummary>[0];
}
function stockReleasedEnvelopePayload() {
  return ALL_FACT_ENVELOPE_BUILDERS['stock.released.v1']!().payload as Parameters<typeof stockReleasedSummary>[0];
}
function creditRejectedEnvelopePayload() {
  return ALL_FACT_ENVELOPE_BUILDERS['credit.rejected.v1']!().payload as Parameters<typeof creditRejectedSummary>[0];
}
function orderCancelledEnvelopePayload() {
  return ALL_FACT_ENVELOPE_BUILDERS['order.cancelled.v1']!().payload as Parameters<typeof orderCancelledSummary>[0];
}
