// PR3 › logs and acknowledges a malformed envelope without writing to the
// read model or publishing a signal. PR4 › logs and acknowledges an unknown
// eventType instead of discarding it silently. Both assert on a recording
// fake that the writer was NEVER CALLED (the attempt, not the residue —
// tasks.md's binding N10 rule).
//
// OR1/A4b (observability_reliability) — `route`'s dispatch point is now
// wrapped by `FactRetryDispatcher`, injected as a SECOND constructor
// parameter. Every case below except the two A4b-named ones at the bottom
// uses `passthroughRetryDispatcher()` (calls `process` exactly once, no
// retry, no DLQ) precisely so it keeps proving `route`'s OWN branching —
// PR3's malformed-envelope guard, PR4's unknown-eventType swallow, which
// now happens INSIDE `process`, before a genuine failure would ever reach
// the retry dispatcher. The retry/backoff/DLQ POLICY itself is proven
// once, generically, by fact-retry-dispatcher.spec.ts (byte-identical to
// the canonical, OI12) — not re-proven per call site here.
//
// One behavioural change from before this feature, worth stating
// explicitly: a generic CommandBus failure (a Mongo write failure, for
// instance) used to propagate RAW out of `route`, straight to
// `@nestjs/microservices`'s throw -> no-offset-commit -> redeliver-forever
// semantics — the exact poison-message shape OR1 exists to fix. It no
// longer does; it now reaches the retry dispatcher instead (proven below,
// "a generic processing failure reaches the retry dispatcher rather than
// propagating raw"), which retries in-line and only then, on exhaustion,
// dead-letters and lets the offset commit — see
// projector-dead-letter.integration.spec.ts for the real, Testcontainers
// proof of the full chain.
import { CommandBus } from '@nestjs/cqrs';
import { describe, expect, it, vi } from 'vitest';
import type { KafkaContext } from '@nestjs/microservices';
import type { Envelope } from '@otc/contracts';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { UnknownFactTypeError } from '../domain/fact-projection';
import type { DispatchesFactRetries } from '../infrastructure/messaging/fact-retry-dispatcher';
import { extractKafkaTraceContext, tracer } from '../infrastructure/observability/trace-context';
import { orderPlacedEnvelope } from '../test-support/envelope-fixtures';
import { ProjectorFactsController } from './projector-facts.controller';

// A5 (observability_reliability, R57/OR4): `route` now extracts a trace
// context from the inbound Kafka message's headers and starts a manual
// span around the dispatch call — a no-headers fake `KafkaContext` is
// enough for every case in this file, which is about routing, not trace
// propagation.
function fakeKafkaContext(): KafkaContext {
  return { getMessage: () => ({ headers: undefined }) } as unknown as KafkaContext;
}

function fakeCommandBus(behaviour: 'succeed' | 'throw-unknown-type' | 'throw-other'): { commandBus: CommandBus; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => {
    if (behaviour === 'throw-unknown-type') {
      throw new UnknownFactTypeError('bogus.fact.v1');
    }
    if (behaviour === 'throw-other') {
      throw new Error('mongo unreachable');
    }
    return 'processed';
  });
  return { commandBus: { execute } as unknown as CommandBus, execute };
}

/** Calls `process` exactly once, no retry, no DLQ — see this file's own header for why every case but the two A4b-named ones below uses this. */
function passthroughRetryDispatcher(): DispatchesFactRetries {
  return {
    async dispatch(
      _sourceTopic: string,
      envelope: Envelope,
      _consumer: string,
      process: (envelope: Envelope) => Promise<void>,
    ): Promise<void> {
      await process(envelope);
    },
  };
}

describe('ProjectorFactsController', () => {
  it('PR3 › logs and acknowledges a malformed envelope without writing to the read model (CommandBus never called)', async () => {
    const { commandBus, execute } = fakeCommandBus('succeed');
    const logger = { error: vi.fn() };
    const controller = new ProjectorFactsController(commandBus, passthroughRetryDispatcher(), logger);

    // Missing required fields -> malformed.
    await expect(controller.onOrdersFact({ eventType: 'order.placed.v1' }, fakeKafkaContext())).resolves.toBeUndefined();

    expect(execute).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toContain('malformed fact envelope');
  });

  it('PR4 › logs and acknowledges an unknown eventType instead of discarding it silently (CommandBus called once, no rethrow)', async () => {
    const { commandBus, execute } = fakeCommandBus('throw-unknown-type');
    const logger = { error: vi.fn() };
    const controller = new ProjectorFactsController(commandBus, passthroughRetryDispatcher(), logger);

    const envelope = orderPlacedEnvelope({ eventType: 'stock.teleported.v1' });
    await expect(controller.onFulfillmentFact(envelope, fakeKafkaContext())).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toContain('unknown eventType');
    // R58 closeout (design.md §4.4) — `correlationId` is the parsed
    // envelope's own, always present for this branch.
    expect(logger.error.mock.calls[0]![1]).toMatchObject({ correlationId: envelope.correlationId });
  });

  it('dispatches a well-formed, known fact to the CommandBus exactly once', async () => {
    const { commandBus, execute } = fakeCommandBus('succeed');
    const controller = new ProjectorFactsController(commandBus, passthroughRetryDispatcher(), { error: vi.fn() });

    await controller.onOrdersFact(orderPlacedEnvelope(), fakeKafkaContext());

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('A4b — a known fact\'s CommandBus dispatch genuinely goes THROUGH the injected FactRetryDispatcher, not around it', async () => {
    const { commandBus, execute } = fakeCommandBus('succeed');
    const dispatchCalls: Array<{ sourceTopic: string; envelope: Envelope; consumer: string }> = [];
    const retryDispatcher: DispatchesFactRetries = {
      async dispatch(sourceTopic, envelope, consumer, process) {
        dispatchCalls.push({ sourceTopic, envelope, consumer });
        await process(envelope);
      },
    };
    const envelope = orderPlacedEnvelope();
    const controller = new ProjectorFactsController(commandBus, retryDispatcher);

    await controller.onOrdersFact(envelope, fakeKafkaContext());

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.consumer).toBe('projector');
    expect(dispatchCalls[0]!.envelope).toEqual(envelope);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('A4b — a generic processing failure reaches the retry dispatcher rather than propagating raw out of route (the behaviour that changed)', async () => {
    const { commandBus } = fakeCommandBus('throw-other');
    let caughtByDispatcher: unknown;
    const retryDispatcher: DispatchesFactRetries = {
      async dispatch(_sourceTopic, envelope, _consumer, process) {
        try {
          await process(envelope);
        } catch (error) {
          // deliberately swallowed here too — mirrors FactRetryDispatcher's
          // own "never rethrows" contract, so this fake proves the SAME
          // shape `onBillingFact` must resolve normally against.
          caughtByDispatcher = error;
        }
      },
    };
    const controller = new ProjectorFactsController(commandBus, retryDispatcher);

    await expect(controller.onBillingFact(orderPlacedEnvelope(), fakeKafkaContext())).resolves.toBeUndefined();

    expect((caughtByDispatcher as Error)?.message).toBe('mongo unreachable');
  });

  it('PR4\'s UnknownFactTypeError is swallowed INSIDE process, never reaching the retry dispatcher\'s error path', async () => {
    const { commandBus, execute } = fakeCommandBus('throw-unknown-type');
    let dispatcherObservedAnError = false;
    const retryDispatcher: DispatchesFactRetries = {
      async dispatch(_sourceTopic, envelope, _consumer, process) {
        try {
          await process(envelope);
        } catch {
          dispatcherObservedAnError = true;
        }
      },
    };
    const controller = new ProjectorFactsController(commandBus, retryDispatcher, { error: vi.fn() });

    await expect(controller.onFulfillmentFact(orderPlacedEnvelope(), fakeKafkaContext())).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(dispatcherObservedAnError).toBe(false);
  });

  it('A5 (OR4, R57) — extracts the inbound Kafka header\'s trace context and CONTINUES it (same real traceId) inside CommandBus.execute, rather than starting fresh', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const upstreamSpan = tracer().startSpan('test-outbox-publish-span');
      const { traceId: originTraceId } = upstreamSpan.spanContext();
      const headers: Record<string, string> = {};
      context.with(trace.setSpan(context.active(), upstreamSpan), () => {
        propagation.inject(context.active(), headers);
      });
      upstreamSpan.end();

      let observedTraceId: string | undefined;
      const commandBus = { execute: vi.fn(async () => {
        observedTraceId = trace.getActiveSpan()?.spanContext().traceId;
      }) } as unknown as CommandBus;
      const controller = new ProjectorFactsController(commandBus, passthroughRetryDispatcher());
      const kafkaContext = { getMessage: () => ({ headers }) } as unknown as KafkaContext;

      await controller.onOrdersFact(orderPlacedEnvelope(), kafkaContext);

      expect(observedTraceId).toBeDefined();
      expect(observedTraceId).toBe(originTraceId);
      expect(observedTraceId).toMatch(/^[0-9a-f]{32}$/);

      // extractKafkaTraceContext itself (the exported helper) reads the
      // SAME real trace back from the plain-object headers.
      const reExtracted = extractKafkaTraceContext(headers);
      expect(trace.getSpanContext(reExtracted)?.traceId).toBe(originTraceId);
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
