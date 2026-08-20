import { describe, expect, it } from 'vitest';
import { Money, OrderNumber } from '@otc/shared-kernel';
import { SAGAS, COMPLETED_SAGAS, CANCELLED_SAGAS } from './sagas.data';

describe('feature_list.json #12 acceptance: "a few completed orders and one cancelled order"', () => {
  it('seeds between 4 and 6 completed orders', () => {
    expect(COMPLETED_SAGAS.length).toBeGreaterThanOrEqual(4);
    expect(COMPLETED_SAGAS.length).toBeLessThanOrEqual(6);
  });

  it('seeds exactly 1 cancelled order', () => {
    expect(CANCELLED_SAGAS).toHaveLength(1);
  });
});

describe('every sample order: line items sum to the order total (invariant O3)', () => {
  it.each(SAGAS.map((saga) => [saga.orderReference, saga] as const))('%s: totals are derived, not asserted', (
    _reference,
    saga,
  ) => {
    const initialAmount = saga.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
    const initialDiscount = saga.lines.reduce((sum, line) => sum + line.lineDiscount, 0);

    expect(saga.initialAmount).toBe(initialAmount);
    expect(saga.initialDiscount).toBe(initialDiscount);
    expect(saga.totalAmount).toBe(initialAmount - initialDiscount);
    expect(saga.totalAmount).toBeGreaterThanOrEqual(0);
    // Also exercised through the domain Money VO — M1/M4 (integer minor
    // units, non-negative computed total) hold for every seeded order.
    expect(() => Money.of(saga.totalAmount, saga.currency)).not.toThrow();
  });
});

describe('the cancelled order has a total ending in .99 (the simulated_cents_rule demo, task prompt)', () => {
  it('CANCELLED_SAGAS[0].totalAmount mod 100 === 99', () => {
    const [cancelled] = CANCELLED_SAGAS;
    expect(cancelled.totalAmount % 100).toBe(99);
  });

  it('is constructible from a small quantity (a single line of quantity 1)', () => {
    const [cancelled] = CANCELLED_SAGAS;
    expect(cancelled.lines).toHaveLength(1);
    expect(cancelled.lines[0]!.quantity).toBe(1);
  });

  it('no completed order accidentally also ends in .99 (the property is exclusive to the cancelled saga)', () => {
    for (const saga of COMPLETED_SAGAS) {
      expect(saga.totalAmount % 100).not.toBe(99);
    }
  });
});

describe('business references are sequential and unique (task prompt: "leave obvious headroom")', () => {
  it('order references are ORD-000001..ORD-00000N with no gaps or repeats', () => {
    const references = SAGAS.map((saga) => saga.orderReference);
    const expected = SAGAS.map((_saga, index) => OrderNumber.fromSequence(index + 1).toString());
    expect(references).toEqual(expected);
    expect(new Set(references).size).toBe(references.length);
  });

  it('despatch/invoice references are DES-000001../INV-000001.. — sequential across only the completed orders', () => {
    const despatchRefs = COMPLETED_SAGAS.map((saga) => saga.despatch?.despatchReference);
    const invoiceRefs = COMPLETED_SAGAS.map((saga) => saga.invoice?.invoiceReference);
    expect(despatchRefs).toEqual(['DES-000001', 'DES-000002', 'DES-000003', 'DES-000004', 'DES-000005']);
    expect(invoiceRefs).toEqual(['INV-000001', 'INV-000002', 'INV-000003', 'INV-000004', 'INV-000005']);
  });

  it('the cancelled order has neither a despatch nor an invoice', () => {
    const [cancelled] = CANCELLED_SAGAS;
    expect(cancelled.despatch).toBeNull();
    expect(cancelled.invoice).toBeNull();
  });
});

describe('every seeded outbox row is already published (task prompt: "the relay never re-publishes fabricated history")', () => {
  it.each(SAGAS.map((saga) => [saga.orderReference, saga] as const))('%s: every outbox row across the three DBs has publishedAt set', (
    _reference,
    saga,
  ) => {
    const allRows = [...saga.ordersOutbox, ...saga.fulfillmentOutbox, ...saga.billingOutbox];
    expect(allRows.length).toBeGreaterThan(0);
    for (const row of allRows) {
      expect(row.publishedAt).toBeInstanceOf(Date);
      expect(row.publishedAt.getTime()).toBeGreaterThanOrEqual(row.occurredAt.getTime());
    }
  });
});

describe('the happy-path saga produces exactly the 9 facts of saga.md §3.1', () => {
  it.each(COMPLETED_SAGAS.map((saga) => [saga.orderReference, saga] as const))('%s', (_reference, saga) => {
    const eventTypes = [
      ...saga.ordersOutbox.map((r) => r.eventType),
      ...saga.fulfillmentOutbox.map((r) => r.eventType),
      ...saga.billingOutbox.map((r) => r.eventType),
    ].sort();

    expect(eventTypes.sort()).toEqual(
      [
        'order.placed.v1',
        'stock.reserved.v1',
        'credit.approved.v1',
        'order.confirmed.v1',
        'order.despatched.v1',
        'invoice.issued.v1',
        'payment.received.v1',
        'credit.released.v1',
        'order.completed.v1',
      ].sort(),
    );
  });
});

describe('the cancelled saga produces exactly the 5 facts of saga.md §4.2 (release, then cancel)', () => {
  it('order.placed, stock.reserved, credit.rejected, stock.released, order.cancelled — in causal order', () => {
    const [cancelled] = CANCELLED_SAGAS;
    const chronological = [...cancelled.timeline].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    expect(chronological.map((entry) => entry.eventType)).toEqual([
      'order.placed.v1',
      'stock.reserved.v1',
      'credit.rejected.v1',
      'stock.released.v1',
      'order.cancelled.v1',
    ]);
  });

  it('no credit.released.v1 was emitted — nothing was ever held (invariant B1)', () => {
    const [cancelled] = CANCELLED_SAGAS;
    const eventTypes = cancelled.billingOutbox.map((r) => r.eventType);
    expect(eventTypes).toEqual(['credit.rejected.v1']);
    expect(cancelled.creditLedgerEntries).toHaveLength(0);
  });

  it('reservations end in status "released", not "consumed"', () => {
    const [cancelled] = CANCELLED_SAGAS;
    for (const reservation of cancelled.reservations) {
      expect(reservation.status).toBe('released');
    }
  });
});

describe('every completed saga: reservations end in status "consumed"', () => {
  it.each(COMPLETED_SAGAS.map((saga) => [saga.orderReference, saga] as const))('%s', (_reference, saga) => {
    for (const reservation of saga.reservations) {
      expect(reservation.status).toBe('consumed');
    }
  });
});

describe('every seeded event envelope validates structurally against the contracts types (task prompt)', () => {
  const REQUIRED_KEYS: Record<string, string[]> = {
    'order.placed.v1': [
      'orderReference',
      'retailerCode',
      'companyCode',
      'buyerGln',
      'supplierGln',
      'currency',
      'orderDate',
      'lines',
      'initialAmount',
      'initialDiscount',
      'totalAmount',
    ],
    'stock.reserved.v1': ['orderReference', 'companyCode', 'retailerCode', 'reservations'],
    'stock.released.v1': ['orderReference', 'companyCode', 'retailerCode', 'released', 'reason'],
    'credit.approved.v1': [
      'orderReference',
      'retailerCode',
      'companyCode',
      'creditCode',
      'currency',
      'heldAmount',
      'availableCreditAfter',
    ],
    'credit.rejected.v1': [
      'orderReference',
      'retailerCode',
      'companyCode',
      'creditCode',
      'currency',
      'requestedAmount',
      'availableCredit',
      'reason',
    ],
    'credit.released.v1': [
      'orderReference',
      'retailerCode',
      'companyCode',
      'creditCode',
      'currency',
      'releasedAmount',
      'availableCreditAfter',
      'reason',
    ],
    'order.confirmed.v1': ['orderReference', 'retailerCode', 'companyCode', 'currency', 'totalAmount', 'confirmedAt'],
    'order.despatched.v1': [
      'orderReference',
      'despatchReference',
      'despatchDate',
      'companyCode',
      'retailerCode',
      'lines',
    ],
    'invoice.issued.v1': [
      'orderReference',
      'invoiceReference',
      'invoiceDate',
      'retailerCode',
      'companyCode',
      'currency',
      'lines',
      'amount',
      'discount',
      'totalAmount',
    ],
    'payment.received.v1': [
      'orderReference',
      'invoiceReference',
      'paymentReference',
      'currency',
      'amount',
      'valueDate',
      'source',
    ],
    'order.completed.v1': ['orderReference', 'retailerCode', 'companyCode', 'currency', 'totalAmount', 'completedAt'],
    'order.cancelled.v1': [
      'orderReference',
      'retailerCode',
      'companyCode',
      'cancellationReason',
      'cancelledAt',
      'compensationSteps',
    ],
  };

  // order.placed.v1 also carries the OPTIONAL `notes` field on the
  // cancelled demo order only (sagas.data.ts) — allowed, not required.
  const OPTIONAL_KEYS: Record<string, string[]> = { 'order.placed.v1': ['notes'] };

  it('every built outbox payload has exactly the required keys of its @otc/contracts payload interface, plus only documented optional ones', () => {
    let checked = 0;
    for (const saga of SAGAS) {
      const allRows = [...saga.ordersOutbox, ...saga.fulfillmentOutbox, ...saga.billingOutbox];
      for (const row of allRows) {
        const requiredKeys = REQUIRED_KEYS[row.eventType];
        expect(requiredKeys, `no expected-keys fixture for ${row.eventType}`).toBeDefined();
        const allowedKeys = new Set([...requiredKeys!, ...(OPTIONAL_KEYS[row.eventType] ?? [])]);
        const actualKeys = Object.keys(row.payload);

        for (const key of requiredKeys!) {
          expect(actualKeys, `${row.eventType} missing required key "${key}"`).toContain(key);
        }
        for (const key of actualKeys) {
          expect(allowedKeys.has(key), `${row.eventType} has undocumented key "${key}"`).toBe(true);
        }
        checked++;
      }
    }
    // 5 completed sagas x 9 facts + 1 cancelled saga x 5 facts.
    expect(checked).toBe(5 * 9 + 1 * 5);
  });
});
