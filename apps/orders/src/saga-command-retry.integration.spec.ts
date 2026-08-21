// R29 (retry clause) + SO3/SO4/SO5 — no responder ⇒ parked row with
// attempts + error, order status unchanged; the crash-window composition
// (SO3): a `pending` row committed with NO in-memory hop is still issued
// by a sweeper cycle; starting the stub ⇒ the next sweep resumes the saga.
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UniqueId } from '@otc/shared-kernel';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import {
  startStubSagaResponders,
  type StubSagaResponders,
} from './infrastructure/messaging/test-support/stub-saga-responders';
import { SagaCommandDispatcher } from './infrastructure/saga/saga-command-dispatcher';
import { DrizzleSagaCommandStore } from './infrastructure/saga/drizzle-saga-command-store';
import { NatsSagaCommandsAdapter } from './infrastructure/messaging/nats-saga-commands.adapter';
import { startSagaIntegrationHarness, type SagaIntegrationHarness } from './test-support/saga-integration-harness';

// Budget (post-approval hardening, 2026-08-21): `beforeAll` now blocks on
// `waitForConsumerGroupReady` before either `it` in this suite runs
// (saga-integration-harness.ts) — the "coordinator loading" startup cost
// is paid once, inside beforeAll's 300_000ms hook budget, not here. The
// vitest's 180s `testTimeout` so a true hang still fails fast. Both tests
// deliberately use a tiny `dispatcherConfig` so SO4's park-on-exhaustion
// policy resolves in well under a second.
async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`saga-command-retry: condition not met within ${timeoutMs}ms`);
}

async function orderRow(harness: SagaIntegrationHarness, orderId: string) {
  const [row] = await harness.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, orderId));
  return row;
}

async function commandRow(
  harness: SagaIntegrationHarness,
  orderId: string,
  command: 'stock.reserve' | 'stock.release' | 'despatch.create' | 'credit.hold' | 'invoice.issue',
) {
  const [row] = await harness.db
    .select()
    .from(ordersSchema.sagaCommands)
    .where(and(eq(ordersSchema.sagaCommands.orderId, orderId), eq(ordersSchema.sagaCommands.command, command)));
  return row;
}

describe('saga-command-retry — R29 (retry), SO3, SO4, SO5 (Testcontainers)', () => {
  let harness: SagaIntegrationHarness;
  let responders: StubSagaResponders | undefined;

  beforeAll(async () => {
    // A short dispatcher budget (attempts=2, ~50ms backoff, 300ms
    // per-attempt timeout) so "no responder ⇒ parked" resolves in well
    // under a second instead of the production 16.5s worst case — SO4's
    // POLICY (attempt count, backoff shape, park-on-exhaustion) is what is
    // under test, not its production timing.
    harness = await startSagaIntegrationHarness({
      dispatcherConfig: { timeoutMs: 300, maxAttempts: 2, backoffBaseMs: 50 },
    });
  }, 300_000);

  afterEach(async () => {
    await responders?.stop();
    responders = undefined;
  });

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('parks a command after exhausted attempts, keeps the order in its last legal status, and resumes to the next status when a responder appears', async () => {
    // Deliberately NO responder started — the "Fulfillment is down" case.
    const order = await harness.placeOrderAndRelay();

    await waitFor(async () => {
      const row = await commandRow(harness, order.id.value, 'stock.reserve');
      return row?.status === 'parked';
    });

    const parkedRow = await commandRow(harness, order.id.value, 'stock.reserve');
    expect(parkedRow).toMatchObject({ status: 'parked', attempts: 2 });
    expect(parkedRow?.lastError).toBeTruthy();
    expect(parkedRow?.nextAttemptAt).not.toBeNull();

    // The order status is untouched while parked (R29's "not changed while retrying").
    expect((await orderRow(harness, order.id.value))?.status).toBe('placed');

    // Now the responder appears — the sweeper (not yet run) will pick this
    // up on its next cycle. Run one dispatcher cycle DIRECTLY (the same
    // call the sweeper makes, design.md §6.4) rather than waiting out the
    // production interval — this is deliberately a manual "sweep" for
    // determinism, proving the SAME mechanism the sweeper uses resumes the
    // saga unattended.
    responders = await startStubSagaResponders(
      harness.testNatsConnection,
      { fulfillment: harness.fulfillmentFactPublisher, billing: harness.billingFactPublisher },
      harness.resolveOrderId,
    );

    const store = new DrizzleSagaCommandStore(harness.db, harness.clock);
    const commands = new NatsSagaCommandsAdapter(harness.testNatsConnection, 3000);
    const dispatcher = new SagaCommandDispatcher(commands, store, {
      timeoutMs: 3000,
      maxAttempts: 3,
      backoffBaseMs: 200,
      parkRetryCapMs: 900_000,
    });
    const outcome = await dispatcher.dispatch(order.id, 'stock.reserve');
    expect(outcome).toBe('sent');

    // "at least stock_reserved", not "exactly" — once the responder is up,
    // the whole downstream chain can advance faster than this poll
    // observes an exact intermediate value (same reasoning as
    // saga-happy-path.integration.spec.ts's `waitUntilAtLeast`).
    await waitFor(async () => (await orderRow(harness, order.id.value))?.status !== 'placed');
    const resentRow = await commandRow(harness, order.id.value, 'stock.reserve');
    expect(resentRow?.status).toBe('sent');
  }, 60_000);

  it('SO3 — the crash-window composition: a pending row committed with NO in-memory hop is still issued by a sweeper cycle', async () => {
    responders = await startStubSagaResponders(
      harness.testNatsConnection,
      { fulfillment: harness.fulfillmentFactPublisher, billing: harness.billingFactPublisher },
      harness.resolveOrderId,
    );

    // Simulate "committed, never issued" directly: enqueue a pending
    // saga_commands row for a real order WITHOUT ever publishing the
    // order.placed.v1 fact through the app's own consumer — i.e. no
    // EventBus->@Saga hop ever ran for it, exactly the crash window SO3
    // describes (design.md §5.2: "a crash between commit and the hop").
    const order = await harness.placeOrder();
    const store = new DrizzleSagaCommandStore(harness.db, harness.clock);
    await harness.db.transaction(async (tx) => {
      await store.enqueue(tx as never, {
        id: UniqueId.generate(),
        orderId: order.id,
        orderReference: order.orderReference,
        command: 'stock.reserve',
        payload: {
          orderReference: order.orderReference.value,
          retailerCode: order.retailerCode,
          companyCode: order.companyCode,
          lines: [{ productCode: 'PRD-0001', units: 2 }],
        },
        triggeringEventId: UniqueId.generate(),
      });
    });

    const beforeSweep = await commandRow(harness, order.id.value, 'stock.reserve');
    expect(beforeSweep?.status).toBe('pending');

    // A real sweeper cycle: claim (own short tx, FOR UPDATE SKIP LOCKED)
    // then dispatch OUTSIDE it, calling the dispatcher directly — never
    // via any bus (design.md §6.4/§5.5). The harness's clock is a FIXED
    // `FakeClock` (it never ticks on its own), so `enqueue`'s `created_at`
    // and a `now` read a moment later are the exact same instant —
    // `claimDue`'s `created_at < now - grace` is then only satisfiable by
    // asking for a `now` strictly LATER than that instant, which is what
    // "the just-enqueued row is immediately due" means in wall-clock terms
    // anyway (SAGA_PENDING_GRACE_MS has already elapsed by the time a real
    // sweeper cycle runs).
    const commands = new NatsSagaCommandsAdapter(harness.testNatsConnection, 3000);
    const dispatcher = new SagaCommandDispatcher(commands, store, {
      timeoutMs: 3000,
      maxAttempts: 3,
      backoffBaseMs: 200,
      parkRetryCapMs: 900_000,
    });
    const sweepNow = new Date(harness.clock.now().getTime() + 1);
    const claimed = await harness.db.transaction((tx) =>
      store.claimDue(tx as never, sweepNow, 10, { pendingGraceMs: 0 }),
    );
    expect(claimed.some((row) => row.orderId.equals(order.id))).toBe(true);
    for (const row of claimed) {
      await dispatcher.dispatch(row.orderId, row.command);
    }

    // "at least stock_reserved" — same race-avoidance reasoning as the
    // previous test; the downstream chain can outrun a single poll.
    await waitFor(async () => (await orderRow(harness, order.id.value))?.status !== 'placed');
    const afterSweep = await commandRow(harness, order.id.value, 'stock.reserve');
    expect(afterSweep?.status).toBe('sent');
  }, 60_000);
}, 300_000);
