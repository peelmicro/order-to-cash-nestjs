// Pure unit — a fake `NatsRequestClient`, never a real broker (real NATS is
// the integration specs' job). Proves the timeout / no-responders /
// transport / RpcError-body taxonomy, and — the point this adapter exists
// to prove over the orders-side one it is copied from — that a business
// `RpcError` reply is thrown as `RpcBusinessError` carrying the ORIGINAL
// `code`/`details`, never collapsed to a generic transport error.
import { ErrorCode, JSONCodec, NatsError, type MsgHdrs } from 'nats';
import type { RpcError } from '@otc/contracts';
import { context, propagation, trace, type TextMapGetter } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpcBusinessError, RpcTimeoutError, RpcTransportError, type RpcCallMeta } from '../../application/ports/rpc-client.port';
import { NatsRpcClientAdapter, type NatsRequestClient } from './nats-rpc-client.adapter';

// Test-only extraction helper — the Gateway's own `trace-context.ts`
// exports injection only (it has no NATS RESPONDER of its own; extraction
// is Orders' `orders-create.controller.ts`'s job, proven there). Same
// getter shape as `apps/orders/src/infrastructure/observability/trace-context.ts`'s
// `NATS_GETTER`.
const NATS_GETTER: TextMapGetter<MsgHdrs> = {
  keys: (carrier) => carrier.keys(),
  get: (carrier, key) => (carrier.has(key) ? carrier.get(key) : undefined),
};

function fakeClient(handler: NatsRequestClient['request']): NatsRequestClient {
  return { request: handler };
}

const META: RpcCallMeta = { correlationId: 'order-1', requestId: 'req-1' };

describe('NatsRpcClientAdapter', () => {
  it('decodes and returns a success reply', async () => {
    const replyCodec = JSONCodec<{ outcome: string }>();
    const client = fakeClient(async (subject, _data, opts) => {
      expect(subject).toBe('some.subject');
      expect(opts.timeout).toBe(5000);
      return { data: replyCodec.encode({ outcome: 'accepted' }) };
    });
    const adapter = new NatsRpcClientAdapter(client, 5000);

    const result = await adapter.call('some.subject', { foo: 'bar' }, META);
    expect(result).toEqual({ outcome: 'accepted' });
  });

  it('sets x-correlation-id/x-request-id from the given meta', async () => {
    let seenHeaders: { get(key: string): string | undefined } | undefined;
    const replyCodec = JSONCodec<{ ok: true }>();
    const client = fakeClient(async (_subject, _data, opts) => {
      seenHeaders = opts.headers as unknown as { get(key: string): string | undefined };
      return { data: replyCodec.encode({ ok: true }) };
    });
    const adapter = new NatsRpcClientAdapter(client, 5000);

    await adapter.call('some.subject', {}, META);

    expect(seenHeaders?.get('x-correlation-id')).toBe('order-1');
    expect(seenHeaders?.get('x-request-id')).toBe('req-1');
  });

  it('throws RpcBusinessError, preserving code and details, when the reply is the RpcError shape', async () => {
    const rpcError: RpcError = { code: 'NOT_FOUND', message: 'no such order', details: { orderId: 'order-1' } };
    const replyCodec = JSONCodec<RpcError>();
    const client = fakeClient(async () => ({ data: replyCodec.encode(rpcError) }));
    const adapter = new NatsRpcClientAdapter(client, 5000);

    await expect(adapter.call('some.subject', {}, META)).rejects.toBeInstanceOf(RpcBusinessError);
    await expect(adapter.call('some.subject', {}, META)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { orderId: 'order-1' },
    });
  });

  it('throws RpcTimeoutError on a NATS timeout', async () => {
    const client = fakeClient(async () => {
      throw new NatsError('timeout', ErrorCode.Timeout);
    });
    const adapter = new NatsRpcClientAdapter(client, 250);

    await expect(adapter.call('some.subject', {}, META)).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('throws RpcTransportError when no responder is subscribed', async () => {
    const client = fakeClient(async () => {
      throw new NatsError('no responders', ErrorCode.NoResponders);
    });
    const adapter = new NatsRpcClientAdapter(client, 5000);

    await expect(adapter.call('some.subject', {}, META)).rejects.toBeInstanceOf(RpcTransportError);
  });

  it('honours a per-call timeout override instead of the adapter default', async () => {
    const replyCodec = JSONCodec<{ ok: true }>();
    let seenTimeout = -1;
    const client = fakeClient(async (_subject, _data, opts) => {
      seenTimeout = opts.timeout;
      return { data: replyCodec.encode({ ok: true }) };
    });
    const adapter = new NatsRpcClientAdapter(client, 5000);

    await adapter.call('some.subject', {}, META, 250);

    expect(seenTimeout).toBe(250);
  });
});

describe('NatsRpcClientAdapter — trace propagation (OR4, R57, design.md §4.3)', () => {
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeAll(() => {
    const exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });
  });

  afterAll(async () => {
    contextManager.disable();
    await provider.shutdown();
  });

  it('injects the active span\'s REAL traceId — a span extracted from the sent headers has the SAME traceId, not merely "a header is present" — the trace that would come from HttpInstrumentation\'s own inbound span in production', async () => {
    const replyCodec = JSONCodec<{ ok: true }>();
    let capturedHeaders: MsgHdrs | undefined;
    const client = fakeClient(async (_subject, _data, opts) => {
      capturedHeaders = opts.headers;
      return { data: replyCodec.encode({ ok: true }) };
    });
    const adapter = new NatsRpcClientAdapter(client, 5000);

    const span = provider.getTracer('test').startSpan('test-inbound-http-span');
    const { traceId } = span.spanContext();

    await context.with(trace.setSpan(context.active(), span), () => adapter.call('some.subject', {}, META));
    span.end();

    expect(capturedHeaders).toBeDefined();
    const extracted = propagation.extract(context.active(), capturedHeaders!, NATS_GETTER);
    const extractedSpanContext = trace.getSpanContext(extracted);
    expect(extractedSpanContext).toBeDefined();
    expect(extractedSpanContext!.traceId).toBe(traceId);
    expect(extractedSpanContext!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
