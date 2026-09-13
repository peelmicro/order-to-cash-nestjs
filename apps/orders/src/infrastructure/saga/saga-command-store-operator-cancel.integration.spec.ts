// SA-4 (id 79), guarded against a real MySQL for the first time (backlog id
// 91 of order-to-cash-dotnet, filed against THIS repository).
//
// `DrizzleSagaCommandStore.hasAcceptedOperatorCancel` sits between two ends
// that are each already armed: the PREDICATE
// (`application/operator-cancel-envelope.ts`, unit-tested both ways) and the
// CALL SITE (`saga-fact-handler.ts`, armed against a fake store). The two
// lines of SQL BETWEEN them — "select the envelope column of this order's
// `credit.release` and `stock.release` rows" — were executed by nothing:
// every other mention of the method in this repository is a fake store or
// an assertion against a fake. #8 guards its equivalent against a real
// database (tests/Orders.IntegrationTests/SagaCommandStoreTests.cs:387,
// :415); this is that guard, ported back.
//
// What is open without it is a SUBSTITUTION, not a deletion (CLAUDE.md,
// "substitute a valid sibling identifier"): either command token can be
// repointed at another `SagaCommandKind` member, and the envelope column at
// its sibling `json` column `payload`, and all three compile, type-check and
// answer `false` for every order — which sends a late `credit.approved.v1`
// down the ordinary path and orders a despatch for an order being
// cancelled, the exact defect SA-4 exists to prevent. So the cases below
// are chosen so that each substitution flips a `false` expectation to
// `true` somewhere: a mutation that merely emptied the result set could
// only ever break the `true` cases, and "no row matched" is indistinguishable
// from "the row was never inserted" — not evidence about the NAME.
//
// Real MySQL (mysql:8.4.11, Testcontainers) via the MySQL-only
// `startOrdersTestFixture`: `hasAcceptedOperatorCancel` is a pure database
// read, so the saga trio's Kafka and NATS containers would buy nothing.
// `saga_commands.order_id` carries no foreign key to `orders`
// (saga-commands.schema.ts:44), so no order row is needed — each case uses
// its own generated order id, which also keeps the `(order_id, command)`
// unique key out of the way.
import type { Envelope } from '@otc/contracts';
import { OrderNumber, UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR_CANCEL_EVENT_TYPE } from '../../application/operator-cancel-envelope';
import type { SagaCommandPayload } from '../../application/saga-command-payloads';
import type { SagaCommandKind } from '../../application/saga-steps';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { FakeClock } from '../persistence/test-support/fake-clock';
import {
  startOrdersTestFixture,
  type OrdersTestFixture,
} from '../persistence/test-support/orders-test-fixture';
import { DrizzleSagaCommandStore } from './drizzle-saga-command-store';

const ORDERS_FACTS_TOPIC = 'otc.orders.facts.v1';
const BILLING_FACTS_TOPIC = 'otc.billing.facts.v1';
const FULFILLMENT_FACTS_TOPIC = 'otc.fulfillment.facts.v1';

const ORDER_REFERENCE = OrderNumber.fromSequence(910_091);

/**
 * A real wire fact's envelope — the shape EVERY fact-driven `stock.release`
 * (R27's `credit.rejected.v1` compensation) and `credit.release`
 * (`stock.released.v1`'s `credit_approved`/`confirmed` variant) row carries.
 * `eventType` is a real, declared fact type, so `isOperatorCancelEnvelope`
 * must answer `false` for it.
 */
function realFactEnvelope(orderId: UniqueId, eventType: string): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType,
    aggregateId: orderId.value,
    correlationId: orderId.value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-09-13T09:00:00.000Z',
    payload: { orderReference: ORDER_REFERENCE.value },
  };
}

/**
 * The synthetic envelope `CancelOrderHandler.buildTriggeringEnvelope`
 * stamps on the row it enqueues directly. `OPERATOR_CANCEL_EVENT_TYPE` is
 * IMPORTED, never retyped: a local copy of the literal would pin this test
 * to its own string rather than to the one the writer and the reader share,
 * and a drift between them is precisely the failure
 * `operator-cancel-envelope.ts` exists to make impossible.
 */
function syntheticOperatorCancelEnvelope(orderId: UniqueId, note?: string): Envelope {
  const requestId = UniqueId.generate().value;
  return {
    eventId: requestId,
    eventType: OPERATOR_CANCEL_EVENT_TYPE,
    aggregateId: orderId.value,
    correlationId: orderId.value,
    causationId: requestId,
    occurredAt: '2026-09-13T09:30:00.000Z',
    payload: {
      orderId: orderId.value,
      reason: 'operator_cancelled',
      ...(note !== undefined ? { note } : {}),
    },
  };
}

/** The real typed RPC payload each command carries — `saga-command-payloads.ts`'s own shapes, so nothing here depends on a cast. */
function payloadFor(command: SagaCommandKind): SagaCommandPayload {
  switch (command) {
    case 'stock.release':
      return { orderReference: ORDER_REFERENCE.value, reason: 'order_cancelled' };
    case 'credit.release':
      return {
        orderReference: ORDER_REFERENCE.value,
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
      };
    case 'despatch.create':
      return { orderReference: ORDER_REFERENCE.value };
    case 'stock.reserve':
      return {
        orderReference: ORDER_REFERENCE.value,
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
        lines: [{ productCode: 'PRD-0001', units: 2 }],
      };
    default:
      return {
        orderReference: ORDER_REFERENCE.value,
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
      };
  }
}

describe('DrizzleSagaCommandStore.hasAcceptedOperatorCancel — SA-4, real MySQL (mysql:8.4.11, Testcontainers)', () => {
  let fixture: OrdersTestFixture;
  let store: DrizzleSagaCommandStore;
  let unitOfWork: DrizzleUnitOfWork;

  beforeAll(async () => {
    fixture = await startOrdersTestFixture();
    // The REAL store and the REAL unit of work — the `tx` below is a genuine
    // open MySQL transaction, so both the write and the read go through the
    // same signature `SagaFactHandler` uses (saga-fact-handler.ts:140).
    store = new DrizzleSagaCommandStore(
      fixture.db,
      new FakeClock(new Date('2026-09-13T10:00:00.000Z')),
    );
    unitOfWork = new DrizzleUnitOfWork(fixture.db);
  }, 180_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  async function enqueueRow(
    orderId: UniqueId,
    command: SagaCommandKind,
    triggeringEventEnvelope: Envelope,
    triggeringEventTopic: string,
    payload: SagaCommandPayload = payloadFor(command),
  ): Promise<void> {
    await unitOfWork.execute(async (tx) => {
      const outcome = await store.enqueue(tx, {
        id: UniqueId.generate(),
        orderId,
        orderReference: ORDER_REFERENCE,
        command,
        payload,
        triggeringEventId: UniqueId.from(triggeringEventEnvelope.eventId),
        triggeringEventEnvelope,
        triggeringEventTopic,
      });
      // Every case below uses a fresh order id, so any `already_owed` here
      // would mean the fixture is not in the state the case assumes.
      expect(outcome).toBe('enqueued');
    });
  }

  /** Asked exactly as `SagaFactHandler` asks it: inside the caller's own open transaction. */
  function ask(orderId: UniqueId): Promise<boolean> {
    return unitOfWork.execute((tx) => store.hasAcceptedOperatorCancel(tx, orderId));
  }

  it('answers false for a stock.release row carrying a REAL fact envelope — R27 automatic compensation is not an operator cancellation', async () => {
    const orderId = UniqueId.generate();
    await enqueueRow(
      orderId,
      'stock.release',
      realFactEnvelope(orderId, 'credit.rejected.v1'),
      BILLING_FACTS_TOPIC,
    );

    expect(await ask(orderId)).toBe(false);
  });

  it('answers true for a stock.release row carrying the SYNTHETIC operator-cancel envelope — the stock_reserved branch, where the order row is left untouched', async () => {
    const orderId = UniqueId.generate();
    await enqueueRow(
      orderId,
      'stock.release',
      syntheticOperatorCancelEnvelope(orderId, 'Operator cancelled while stock_reserved.'),
      ORDERS_FACTS_TOPIC,
    );

    expect(await ask(orderId)).toBe(true);
  });

  it('answers false for a credit.release row carrying a REAL fact envelope — the stock.released.v1 credit_approved variant is not an operator cancellation', async () => {
    const orderId = UniqueId.generate();
    await enqueueRow(
      orderId,
      'credit.release',
      realFactEnvelope(orderId, 'stock.released.v1'),
      FULFILLMENT_FACTS_TOPIC,
    );

    expect(await ask(orderId)).toBe(false);
  });

  it('answers true for a credit.release row carrying the SYNTHETIC operator-cancel envelope — the query scans BOTH release commands, not only stock.release', async () => {
    const orderId = UniqueId.generate();
    await enqueueRow(
      orderId,
      'credit.release',
      syntheticOperatorCancelEnvelope(orderId, 'Operator cancelled while credit_approved.'),
      ORDERS_FACTS_TOPIC,
    );

    expect(await ask(orderId)).toBe(true);
  });

  // The NARROWING, stated as a false expectation on purpose: this is the
  // case a command-token substitution ('stock.release' or 'credit.release'
  // repointed at a sibling `SagaCommandKind`) flips to `true`, and a
  // false -> true flip cannot be produced by an empty result set. Both
  // decoy rows carry the synthetic envelope, so the ONLY thing keeping the
  // answer `false` is the pair of command names in the `or(...)`.
  it('answers false for rows of OTHER commands carrying the SYNTHETIC envelope — stock.reserve and despatch.create are outside the two release commands the query scans', async () => {
    const orderId = UniqueId.generate();
    const envelope = syntheticOperatorCancelEnvelope(
      orderId,
      'a decoy on a command the query must not scan',
    );
    await enqueueRow(orderId, 'stock.reserve', envelope, ORDERS_FACTS_TOPIC);
    await enqueueRow(orderId, 'despatch.create', envelope, ORDERS_FACTS_TOPIC);

    expect(await ask(orderId)).toBe(false);
  });

  // The COLUMN, likewise stated as a false expectation: `payload` and
  // `triggering_event_envelope` are both `json`
  // (saga-commands.schema.ts:52, :61), so repointing the select at the
  // sibling column type-checks identically and `tsc` cannot see it. This
  // row's PAYLOAD is a copy of the operator-cancel envelope while its
  // ENVELOPE is a real fact's — a shape production never writes, and the
  // only one that tells the two columns apart.
  it('answers false when the operator-cancel envelope is in the PAYLOAD column and the envelope column holds a real fact — the answer comes from triggering_event_envelope, not from payload', async () => {
    const orderId = UniqueId.generate();
    const decoyPayload = syntheticOperatorCancelEnvelope(
      orderId,
      'in the wrong column',
    ) as unknown as SagaCommandPayload;
    await enqueueRow(
      orderId,
      'credit.release',
      realFactEnvelope(orderId, 'stock.released.v1'),
      FULFILLMENT_FACTS_TOPIC,
      decoyPayload,
    );

    expect(await ask(orderId)).toBe(false);
  });

  it('answers true under the production interleave — a fact-driven credit.release row alongside the operator own stock.release row, where the operator row is not the physically first', async () => {
    const orderId = UniqueId.generate();
    // `credit.release` sorts first under the `(order_id, command)` unique
    // key, and is the row the fact-driven flow wrote; the operator's own
    // row is second. Content, never row position, must decide — #8's
    // SagaCommandStoreTests.cs:342 makes the same point about its
    // note lookup.
    await enqueueRow(
      orderId,
      'credit.release',
      realFactEnvelope(orderId, 'stock.released.v1'),
      FULFILLMENT_FACTS_TOPIC,
    );
    await enqueueRow(
      orderId,
      'stock.release',
      syntheticOperatorCancelEnvelope(orderId, 'Operator cancelled — second row physically.'),
      ORDERS_FACTS_TOPIC,
    );

    expect(await ask(orderId)).toBe(true);
  });

  it('answers false for an order with no saga_commands rows at all', async () => {
    expect(await ask(UniqueId.generate())).toBe(false);
  });
});
