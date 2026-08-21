// Pure unit — every port faked, no store, no broker (CLAUDE.md § Testing
// conventions). Proves the four outcomes `orders_acceptance`'s acceptance
// list and "Testing" section ask for: accept, reject-on-unavailable,
// reject-on-timeout, and that NOTHING is persisted on any rejection path.
import { GLN, Money, UniqueId } from '@otc/shared-kernel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from './ports/clock.port';
import type { OrderNumberAllocator } from './ports/order-number-allocator.port';
import type { OrderReferenceData, OrderReferenceDataPort } from './ports/order-reference-data.port';
import type { OrderRepository } from './ports/order-repository.port';
import { StockCheckTimeoutError, type StockAvailabilityPort, type StockAvailabilityResult } from './ports/stock-availability.port';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port';
import { OrderDiscountNotSupportedError, ReferenceDataNotFoundError, StockUnavailableError } from './place-order.errors';
import { PlaceOrderHandler, type PlaceOrderCommand } from './place-order.handler';
import { OrderNumber, Quantity } from '@otc/shared-kernel';

const FIXTURE_CURRENCY = 'EUR';
const FIXTURE_RETAILER_CODE = 'RET-0001';
const FIXTURE_COMPANY_CODE = 'COM-0001';
const FIXTURE_PRODUCT_CODE = 'PRD-0001';

function fakeTx(): TransactionContext {
  return {} as TransactionContext;
}

class FakeClock implements Clock {
  constructor(private readonly current: Date) {}
  now(): Date {
    return this.current;
  }
}

function fakeReferenceData(overrides: Partial<OrderReferenceData> = {}): OrderReferenceData {
  return {
    retailer: { code: FIXTURE_RETAILER_CODE, gln: GLN.of('5412345000013') },
    company: { code: FIXTURE_COMPANY_CODE, gln: GLN.of('5412345000037') },
    currencyExists: true,
    products: new Map([
      [
        FIXTURE_PRODUCT_CODE,
        { productCode: FIXTURE_PRODUCT_CODE, description: 'Widget', price: Money.of(1_000, FIXTURE_CURRENCY) },
      ],
    ]),
    ...overrides,
  };
}

function baseCommand(overrides: Partial<PlaceOrderCommand> = {}): PlaceOrderCommand {
  return {
    retailerCode: FIXTURE_RETAILER_CODE,
    companyCode: FIXTURE_COMPANY_CODE,
    currency: FIXTURE_CURRENCY,
    lines: [{ productCode: FIXTURE_PRODUCT_CODE, quantity: 2 }],
    ...overrides,
  };
}

describe('PlaceOrderHandler', () => {
  let unitOfWork: UnitOfWork;
  let orders: OrderRepository;
  let orderNumbers: OrderNumberAllocator;
  let referenceData: OrderReferenceDataPort;
  let stockAvailability: StockAvailabilityPort;
  let clock: Clock;
  let handler: PlaceOrderHandler;
  let saveSpy: ReturnType<typeof vi.fn>;
  let executeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    saveSpy = vi.fn(async () => undefined);
    executeSpy = vi.fn(async (work: (tx: TransactionContext) => Promise<unknown>) => work(fakeTx()));

    unitOfWork = { execute: executeSpy as UnitOfWork['execute'] };
    orders = { save: saveSpy as OrderRepository['save'], findById: vi.fn(), findByReference: vi.fn() };
    orderNumbers = { next: vi.fn(async () => OrderNumber.fromSequence(7)) };
    referenceData = { resolve: vi.fn(async () => fakeReferenceData()) };
    stockAvailability = {
      check: vi.fn(async (): Promise<StockAvailabilityResult> => ({
        available: true,
        lines: [{ productCode: FIXTURE_PRODUCT_CODE, requested: 2, available: 10, sufficient: true }],
      })),
    };
    clock = new FakeClock(new Date('2026-08-21T10:00:00.000Z'));

    handler = new PlaceOrderHandler(unitOfWork, orders, orderNumbers, referenceData, stockAvailability, clock);
  });

  it('accepts: calls the stock check, allocates a reference, saves the order and the outbox record in one unit of work, and returns the order id synchronously', async () => {
    const result = await handler.execute(baseCommand());

    expect(stockAvailability.check).toHaveBeenCalledWith(FIXTURE_COMPANY_CODE, [
      { productCode: FIXTURE_PRODUCT_CODE, quantity: 2 },
    ]);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const [savedOrder] = saveSpy.mock.calls[0]!;
    expect(savedOrder.id.value).toBe(result.orderId);
    expect(savedOrder.orderReference.value).toBe('ORD-000007');

    expect(result).toMatchObject({
      orderReference: 'ORD-000007',
      status: 'placed',
      currency: FIXTURE_CURRENCY,
      initialAmount: 2_000,
      initialDiscount: 0,
      totalAmount: 2_000,
    });
    expect(() => UniqueId.from(result.orderId)).not.toThrow();
  });

  it('rejects when the stock check reports unavailability, and persists NOTHING', async () => {
    stockAvailability.check = vi.fn(async (): Promise<StockAvailabilityResult> => ({
      available: false,
      lines: [{ productCode: FIXTURE_PRODUCT_CODE, requested: 2, available: 1, sufficient: false }],
    }));
    handler = new PlaceOrderHandler(unitOfWork, orders, orderNumbers, referenceData, stockAvailability, clock);

    await expect(handler.execute(baseCommand())).rejects.toThrow(StockUnavailableError);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(orderNumbers.next).not.toHaveBeenCalled();
  });

  it('rejects when the stock check times out, and persists NOTHING (a timeout is a legitimate, handled answer — saga.md §1)', async () => {
    stockAvailability.check = vi.fn(async () => {
      throw new StockCheckTimeoutError('fulfillment.stock.check', 5000);
    });
    handler = new PlaceOrderHandler(unitOfWork, orders, orderNumbers, referenceData, stockAvailability, clock);

    await expect(handler.execute(baseCommand())).rejects.toThrow(StockCheckTimeoutError);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('rejects when the retailer code does not resolve, before ever calling the stock check', async () => {
    referenceData.resolve = vi.fn(async () => fakeReferenceData({ retailer: null }));
    handler = new PlaceOrderHandler(unitOfWork, orders, orderNumbers, referenceData, stockAvailability, clock);

    await expect(handler.execute(baseCommand())).rejects.toThrow(ReferenceDataNotFoundError);

    expect(stockAvailability.check).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-zero orderDiscount — the aggregate carries no order-level discount (orders_aggregate/design.md §4.3)', async () => {
    await expect(handler.execute(baseCommand({ orderDiscount: 500 }))).rejects.toThrow(
      OrderDiscountNotSupportedError,
    );
    expect(referenceData.resolve).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  // D1 regression (review_orders_acceptance.md): proves initialAmount,
  // initialDiscount and totalAmount are three genuinely distinct numbers
  // on the returned result when a line carries a non-zero lineDiscount —
  // without this, a reply-mapping bug that substitutes initialAmount for
  // totalAmount is invisible to the whole suite.
  it('computes initialAmount, initialDiscount and totalAmount as distinct values when a line carries a discount', async () => {
    const result = await handler.execute(
      baseCommand({ lines: [{ productCode: FIXTURE_PRODUCT_CODE, quantity: 2, lineDiscount: 300 }] }),
    );

    expect(result.initialAmount).toBe(2_000);
    expect(result.initialDiscount).toBe(300);
    expect(result.totalAmount).toBe(1_700);
    expect(result.totalAmount).not.toBe(result.initialAmount);
  });

  it('snapshots the catalogue price when a line omits unitPrice, and uses a supplied unitPrice when present', async () => {
    await handler.execute(
      baseCommand({ lines: [{ productCode: FIXTURE_PRODUCT_CODE, quantity: 3, unitPrice: 999, lineDiscount: 50 }] }),
    );

    const [savedOrder] = saveSpy.mock.calls[0]!;
    expect(savedOrder.lines[0].unitPrice.amount).toBe(999);
    expect(savedOrder.lines[0].lineDiscount.amount).toBe(50);
    expect(savedOrder.lines[0].quantity.equals(Quantity.of(3))).toBe(true);
  });
});
