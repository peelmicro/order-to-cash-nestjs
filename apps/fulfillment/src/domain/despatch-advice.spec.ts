// Pure unit — no framework, no DB, no clock. Proves F6 (a `DespatchAdvice`
// has >= 1 line) and that `create` appends exactly one `order.despatched.v1`
// fact whose payload matches domain-model.md's fact catalogue (row 9) and
// asyncapi.yaml's `OrderDespatchedPayload` (fulfillment_despatch feature).
import { DespatchReference, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { DespatchAdvice } from './despatch-advice.js';
import { EmptyDespatchLinesError } from './despatch-errors.js';
import type { StockContext } from './stock-item.js';

const ORDER = OrderNumber.fromSequence(1);
const DESPATCH_REFERENCE = DespatchReference.fromSequence(1);

function ctx(): StockContext {
  return { occurredAt: new Date('2026-08-22T10:00:00.000Z'), causationId: UniqueId.generate() };
}

describe('DespatchAdvice.create — F6, F7', () => {
  it('creates the aggregate and emits exactly one order.despatched.v1 whose payload traces each line to a despatched product/units pair', () => {
    const correlationId = UniqueId.generate();
    const despatch = DespatchAdvice.create(
      {
        id: UniqueId.generate(),
        despatchReference: DESPATCH_REFERENCE,
        despatchDate: new Date('2026-08-22T10:00:00.000Z'),
        orderReference: ORDER,
        companyCode: 'COM-0001',
        retailerCode: 'RET-0001',
        lines: [
          { productCode: 'PRD-0001', units: Quantity.of(3) },
          { productCode: 'PRD-0002', units: Quantity.of(5) },
        ],
      },
      correlationId,
      ctx(),
    );

    expect(despatch.despatchReference.equals(DESPATCH_REFERENCE)).toBe(true);
    expect(despatch.orderReference.equals(ORDER)).toBe(true);
    expect(despatch.lines).toHaveLength(2);

    const events = despatch.pullDomainEvents();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.eventType).toBe('order.despatched.v1');
    expect(event.aggregateId.equals(despatch.id)).toBe(true);
    expect(event.correlationId.equals(correlationId)).toBe(true);
    expect(event.payload).toEqual({
      orderReference: 'ORD-000001',
      despatchReference: 'DES-000001',
      despatchDate: '2026-08-22T10:00:00.000Z',
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      lines: [
        { productCode: 'PRD-0001', units: 3 },
        { productCode: 'PRD-0002', units: 5 },
      ],
    });

    // pullDomainEvents drains — a second call sees nothing new.
    expect(despatch.pullDomainEvents()).toHaveLength(0);
  });

  it('F6 — refuses an empty line list and creates no aggregate', () => {
    expect(() =>
      DespatchAdvice.create(
        {
          id: UniqueId.generate(),
          despatchReference: DESPATCH_REFERENCE,
          despatchDate: new Date('2026-08-22T10:00:00.000Z'),
          orderReference: ORDER,
          companyCode: 'COM-0001',
          retailerCode: 'RET-0001',
          lines: [],
        },
        UniqueId.generate(),
        ctx(),
      ),
    ).toThrow(EmptyDespatchLinesError);
  });
});
