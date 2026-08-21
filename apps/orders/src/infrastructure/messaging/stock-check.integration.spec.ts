// Real NATS (Testcontainers, nats:2.14.5-alpine — the SAME pinned tag
// docker-compose.infra.yml uses). Proves `NatsStockAvailabilityAdapter`
// against the wire, not a fake: a real request/reply round trip, and a real
// timeout (ErrorCode.Timeout) when nothing answers within the deadline —
// "Timeouts must be handled explicitly... never a hang" (orders_acceptance
// task).
import type { NatsConnection, Subscription } from 'nats';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  StockCheckTimeoutError,
  StockCheckTransportError,
} from '../../application/ports/stock-availability.port';
import { NatsStockAvailabilityAdapter } from './nats-stock-availability.adapter';
import { startNatsTestFixture, type NatsTestFixture } from './test-support/nats-test-fixture';
import {
  alwaysAvailable,
  alwaysUnavailable,
  startStubStockCheckResponder,
  type StubStockCheckResponder,
} from './test-support/stub-stock-check-responder';

describe('NatsStockAvailabilityAdapter — real NATS (Testcontainers, nats:2.14.5-alpine)', () => {
  let fixture: NatsTestFixture;
  let callerConnection: NatsConnection;
  let responderConnection: NatsConnection;
  let responder: StubStockCheckResponder | undefined;

  beforeAll(async () => {
    fixture = await startNatsTestFixture();
    [callerConnection, responderConnection] = await Promise.all([fixture.connect(), fixture.connect()]);
  }, 120_000);

  afterEach(async () => {
    await responder?.stop();
    responder = undefined;
  });

  afterAll(async () => {
    await callerConnection?.close();
    await responderConnection?.close();
    await fixture?.teardown();
  }, 60_000);

  it('returns available: true when the stub responder reports every line sufficient', async () => {
    responder = await startStubStockCheckResponder(responderConnection, alwaysAvailable);
    const adapter = new NatsStockAvailabilityAdapter(callerConnection, 2000);

    const result = await adapter.check('COM-0001', [{ productCode: 'PRD-0001', quantity: 3 }]);

    expect(result.available).toBe(true);
    expect(result.lines[0]).toMatchObject({ productCode: 'PRD-0001', requested: 3, sufficient: true });
  });

  it('returns available: false with the short line when the stub responder reports unavailability — a business outcome, not a thrown error', async () => {
    responder = await startStubStockCheckResponder(responderConnection, alwaysUnavailable);
    const adapter = new NatsStockAvailabilityAdapter(callerConnection, 2000);

    const result = await adapter.check('COM-0001', [{ productCode: 'PRD-0001', quantity: 3 }]);

    expect(result.available).toBe(false);
    expect(result.lines[0]).toMatchObject({ productCode: 'PRD-0001', sufficient: false });
  });

  it('throws StockCheckTimeoutError, and does not hang, when a responder is subscribed but never replies within the deadline', async () => {
    // A subscriber IS present (so the server does not fast-fail with
    // "no responders") but deliberately never calls `.respond()` — the
    // genuine "peer is up but slow/stuck" case the deadline exists for.
    const silentSubscription: Subscription = responderConnection.subscribe('fulfillment.stock.check');
    void (async () => {
      for await (const _message of silentSubscription) {
        // intentionally never responds
      }
    })();
    // Round-trips a PING so the SUB frame above is guaranteed to have
    // reached the server before the request below — otherwise the request
    // can race ahead of subscription registration and the server answers
    // "no responders" instead of genuinely waiting out the deadline.
    await responderConnection.flush();

    const adapter = new NatsStockAvailabilityAdapter(callerConnection, 500);

    const startedAt = Date.now();
    await expect(adapter.check('COM-0001', [{ productCode: 'PRD-0001', quantity: 1 }])).rejects.toThrow(
      StockCheckTimeoutError,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    silentSubscription.unsubscribe();
    // Symmetric with the flush above — guarantees the UNSUB has reached the
    // server before the next test asserts "nobody is subscribed".
    await responderConnection.flush();
  });

  it('throws StockCheckTransportError (not a timeout) immediately when nobody is subscribed to the subject at all', async () => {
    // Deliberately no responder started — simulating fulfillment_stock
    // (feature 17) not having landed yet. NATS answers "no responders"
    // fast rather than waiting out the deadline.
    const adapter = new NatsStockAvailabilityAdapter(callerConnection, 5000);

    const startedAt = Date.now();
    await expect(adapter.check('COM-0001', [{ productCode: 'PRD-0001', quantity: 1 }])).rejects.toThrow(
      StockCheckTransportError,
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
}, 120_000);
