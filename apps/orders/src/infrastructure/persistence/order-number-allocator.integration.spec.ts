// Real MySQL (Testcontainers, mysql:8.4.11). Proves the two properties
// `orders_acceptance`'s "Order-number allocation" task names: (1) it
// continues past pre-existing references — e.g. the seed's
// ORD-000001..ORD-000006 — without any hardcoded starting value or change
// to `apps/seed`; (2) it is safe under concurrent placement — N callers
// racing `next()` never collide and never leave a gap.
import { eq, sql } from 'drizzle-orm';
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Order, type PlaceOrderInput, type TransitionContext } from '../../domain/order';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work';
import { DrizzleOrderNumberAllocator } from './order-number-allocator';
import { DrizzleOrderRepository } from './order.repository';
import * as ordersSchema from './schema/index';
import {
  FIXTURE_COMPANY_CODE,
  FIXTURE_CURRENCY,
  FIXTURE_PRODUCT_CODE,
  FIXTURE_RETAILER_CODE,
  startOrdersTestFixture,
  type OrdersTestFixture,
} from './test-support/orders-test-fixture';
import { FakeClock } from './test-support/fake-clock';

function placeInput(orderReference: OrderNumber): PlaceOrderInput {
  return {
    id: UniqueId.generate(),
    orderReference,
    orderDate: new Date('2026-08-21T09:00:00.000Z'),
    buyer: { gln: GLN.of('5412345000013'), code: FIXTURE_RETAILER_CODE },
    supplier: { gln: GLN.of('5412345000037'), code: FIXTURE_COMPANY_CODE },
    currency: FIXTURE_CURRENCY,
    lines: [
      {
        productCode: FIXTURE_PRODUCT_CODE,
        description: 'Widget',
        quantity: Quantity.of(1),
        unitPrice: Money.of(1_000, FIXTURE_CURRENCY),
        lineDiscount: Money.of(0, FIXTURE_CURRENCY),
      },
    ],
  };
}

function ctx(): TransitionContext {
  return { occurredAt: new Date('2026-08-21T09:00:00.000Z'), causationId: UniqueId.generate() };
}

describe('DrizzleOrderNumberAllocator (Testcontainers, mysql:8.4.11)', () => {
  let fixture: OrdersTestFixture;

  beforeAll(async () => {
    fixture = await startOrdersTestFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    // Each test starts from a clean `orders`/`order_number_sequences` slate
    // so allocation numbers are deterministic and comparable across tests.
    await fixture.db.delete(ordersSchema.orderItems);
    await fixture.db.delete(ordersSchema.orders);
    await fixture.db.delete(ordersSchema.orderNumberSequences);
  });

  it('continues past pre-existing order references (a seed-shaped database) rather than starting over at ORD-000001', async () => {
    const clock = new FakeClock(new Date('2026-08-21T09:30:00.000Z'));
    const repository = new DrizzleOrderRepository(fixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);

    // Simulate the seed's ORD-000001..ORD-000006, written directly (the
    // allocator is never involved in seeding — task instruction: "no
    // change to apps/seed").
    for (let sequence = 1; sequence <= 6; sequence++) {
      const order = Order.place(placeInput(OrderNumber.fromSequence(sequence)), ctx());
      await unitOfWork.execute((tx) => repository.save(order, tx));
    }

    const allocator = new DrizzleOrderNumberAllocator();
    const allocated = await unitOfWork.execute((tx) => allocator.next(tx));

    expect(allocated.value).toBe('ORD-000007');
  });

  it('starts at ORD-000001 on an empty database', async () => {
    const allocator = new DrizzleOrderNumberAllocator();
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);

    const allocated = await unitOfWork.execute((tx) => allocator.next(tx));

    expect(allocated.value).toBe('ORD-000001');
  });

  it('is concurrency-safe: N callers racing next() inside their own transaction never collide and leave no gap', async () => {
    const allocator = new DrizzleOrderNumberAllocator();
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);
    const concurrency = 10;

    const results = await Promise.all(
      Array.from({ length: concurrency }, () => unitOfWork.execute((tx) => allocator.next(tx))),
    );

    const sequences = results.map((orderNumber) => Number(orderNumber.value.slice(4))).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: concurrency }, (_, index) => index + 1));

    const [row] = await fixture.db
      .select()
      .from(ordersSchema.orderNumberSequences)
      .where(eq(ordersSchema.orderNumberSequences.id, 1));
    expect(row?.nextValue).toBe(concurrency + 1);
  });

  // D6 (review_orders_acceptance.md): `MAX(order_reference)` as a plain
  // varchar comparison is LEXICAL, not numeric. Zero-padded 6-digit
  // references never disagree with numeric order (that is the whole point
  // of the padding — `OrderNumber.fromSequence` in
  // `@otc/shared-kernel/business-reference.ts` hard-refuses to ever
  // produce a reference outside that fixed 6-digit width, so this can
  // never arise from a value the domain itself produced) — but a
  // differently-shaped value in the table (a legacy row, a manual DB fix,
  // or a future widening of the format) is enough to make the two
  // orderings disagree. `'ORD-1000000' < 'ORD-999999'` LEXICALLY (`'1' <
  // '9'` at the first differing character) even though `1000000 >
  // 999999` NUMERICALLY — so a plain string MAX would silently pick the
  // WRONG row as "latest" and re-seed the counter one below an existing
  // reference, an eventual unique-constraint collision waiting to happen.
  // Proved directly against the two candidate SQL expressions (not routed
  // through `OrderNumber.fromSequence`, which has its own, independently
  // correct width guard and would mask the query-level bug behind an
  // unrelated validation error) — this isolates exactly the fix
  // (`order-number-allocator.ts`'s `cast(substring(...) as unsigned)`)
  // from the diagnosis.
  it('computes the numerically-correct MAX(order_reference), not the lexical one, across a digit-width crossing', async () => {
    // Reach the FK-bearing `orders` row shape via the normal domain path,
    // then move the goalposts with a raw UPDATE — the only way to get a
    // reference outside `OrderNumber`'s own 6-digit guard into the table
    // at all, which is exactly the "legacy/out-of-band row" scenario this
    // fix defends against.
    const clock = new FakeClock(new Date('2026-08-21T09:30:00.000Z'));
    const repository = new DrizzleOrderRepository(fixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);

    const lowOrder = Order.place(placeInput(OrderNumber.fromSequence(1)), ctx());
    await unitOfWork.execute((tx) => repository.save(lowOrder, tx));
    const highOrder = Order.place(placeInput(OrderNumber.fromSequence(2)), ctx());
    await unitOfWork.execute((tx) => repository.save(highOrder, tx));

    await fixture.db
      .update(ordersSchema.orders)
      .set({ orderReference: 'ORD-999999' })
      .where(eq(ordersSchema.orders.id, lowOrder.id.value));
    await fixture.db
      .update(ordersSchema.orders)
      .set({ orderReference: 'ORD-1000000' })
      .where(eq(ordersSchema.orders.id, highOrder.id.value));

    const [{ lexicalMax }] = await fixture.db
      .select({ lexicalMax: sql<string | null>`max(${ordersSchema.orders.orderReference})` })
      .from(ordersSchema.orders);
    const [{ numericMax }] = await fixture.db
      .select({
        numericMax: sql<number | null>`max(cast(substring(${ordersSchema.orders.orderReference}, 5) as unsigned))`,
      })
      .from(ordersSchema.orders);

    // The lexical comparison genuinely disagrees with the numeric one —
    // proves this scenario is a real trap, not a hypothetical one.
    expect(lexicalMax).toBe('ORD-999999');
    expect(numericMax).toBe(1_000_000);

    // Drive the ACTUAL production allocator over this exact scenario. The
    // resulting sequence (1_000_001) is one past `OrderNumber`'s own
    // 6-digit ceiling, so the domain object's independent guard rejects
    // it — but the guard's error message carries the sequence the
    // allocator computed, so it is still direct proof of which max the
    // allocator's SQL used. The buggy lexical query would have produced
    // 1_000_000 here (`999_999 + 1`) instead — a DIFFERENT, wrong number,
    // not merely "also over the limit".
    await fixture.db.delete(ordersSchema.orderNumberSequences);
    const allocator = new DrizzleOrderNumberAllocator();
    await expect(unitOfWork.execute((tx) => allocator.next(tx))).rejects.toThrow('1000001');
  });
});
