// Pure unit — every branch of the error-to-RpcError translation table.
import { Money, Quantity, UniqueId } from '@otc/shared-kernel';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { EmptyOrderError, NegativeOrderTotalError } from '../domain/order-errors';
import { OrderLine } from '../domain/order-line';
import { computeOrderTotals } from '../domain/order-totals';
import { OrderDiscountNotSupportedError, ReferenceDataNotFoundError, StockUnavailableError } from '../application/place-order.errors';
import { StockCheckTimeoutError, StockCheckTransportError } from '../application/ports/stock-availability.port';
import { OrdersCreateRequestDto } from './dto/orders-create.dto';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

describe('toRpcError', () => {
  it('maps StockUnavailableError to STOCK_UNAVAILABLE with the shortages in details', () => {
    const error = new StockUnavailableError([
      { productCode: 'PRD-0001', requested: 5, available: 1, sufficient: false },
    ]);
    expect(toRpcError(error)).toMatchObject({
      code: 'STOCK_UNAVAILABLE',
      details: { shortages: error.shortages },
    });
  });

  it('maps StockCheckTimeoutError to TIMEOUT', () => {
    const error = new StockCheckTimeoutError('fulfillment.stock.check', 5000);
    expect(toRpcError(error)).toMatchObject({ code: 'TIMEOUT', details: { subject: 'fulfillment.stock.check' } });
  });

  it('maps StockCheckTransportError to UNAVAILABLE', () => {
    const error = new StockCheckTransportError('fulfillment.stock.check', 'no responders');
    expect(toRpcError(error)).toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('maps ReferenceDataNotFoundError to NOT_FOUND', () => {
    const error = new ReferenceDataNotFoundError('retailerCode', 'RET-9999');
    expect(toRpcError(error)).toMatchObject({ code: 'NOT_FOUND', details: { field: 'retailerCode', value: 'RET-9999' } });
  });

  it('maps OrderDiscountNotSupportedError to VALIDATION_FAILED', () => {
    expect(toRpcError(new OrderDiscountNotSupportedError(500, 'EUR'))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('maps a domain error (order-errors.ts) to VALIDATION_FAILED, preserving the domain code in details', () => {
    const error = new EmptyOrderError(UniqueId.generate());
    expect(toRpcError(error)).toMatchObject({ code: 'VALIDATION_FAILED', details: { code: 'ORDER_HAS_NO_LINES' } });
  });

  it('maps an unrecognised error to INTERNAL_ERROR', () => {
    expect(toRpcError(new Error('boom'))).toMatchObject({ code: 'INTERNAL_ERROR', message: 'boom' });
  });
});

// Backlog id 102, fix round 1 (review `review_timeline_money_and_stock_names.md`,
// defect E1). `domain-error-money-text.spec.ts` proves each fixed site's
// own `.message` is rendered with `formatMoney`; it never calls
// `toRpcError`. This closes that gap for Orders' two fixed sites — one
// per site, asserting the exact wire `message` through the real mapper.
describe('toRpcError — money text reaches the wire message (id 102 fix round 1)', () => {
  function makeOrderLine(unitPrice: Money, lineDiscount: Money): OrderLine {
    return OrderLine.create({
      id: UniqueId.generate(),
      productCode: 'PRD-0001',
      description: 'Widget',
      quantity: Quantity.of(1),
      unitPrice,
      lineDiscount,
    });
  }

  it('NegativeOrderTotalError reaches the wire message scaled by the currency exponent', () => {
    const lines = [makeOrderLine(Money.of(500, 'EUR'), Money.of(600, 'EUR'))];

    let caught: unknown;
    try {
      computeOrderTotals('EUR', lines);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NegativeOrderTotalError);
    const reply = toRpcError(caught);
    expect(reply.message).toBe('total amount would be negative: -1.00 EUR');
    expect(reply.message).not.toContain('-100 EUR');
  });

  it('OrderDiscountNotSupportedError reaches the wire message scaled by the currency exponent', () => {
    const error = new OrderDiscountNotSupportedError(150, 'EUR');

    const reply = toRpcError(error);

    expect(reply.message).toBe(
      'orderDiscount 1.50 EUR was supplied, but the Order aggregate carries no order-level discount (orders_aggregate/design.md §4.3) — use per-line lineDiscount instead',
    );
  });
});

describe('validationRpcError', () => {
  it('flattens class-validator violations, including nested line violations, into one VALIDATION_FAILED RpcError', async () => {
    const dto = plainToInstance(OrdersCreateRequestDto, {
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      currency: 'not-a-currency',
      lines: [{ productCode: 'PRD-0001', quantity: -1 }],
    });
    const violations = await validate(dto);

    const rpcError = validationRpcError(violations);

    expect(rpcError.code).toBe('VALIDATION_FAILED');
    expect(rpcError.message.length).toBeGreaterThan(0);
  });
});
