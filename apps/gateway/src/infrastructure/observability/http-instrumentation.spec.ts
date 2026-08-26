// Proves the HTTP hop's own mechanism (OR4, R57, design.md §4.3, §5):
// `@opentelemetry/instrumentation-http` auto-instruments Node's `http`
// module, so an inbound HTTP request the Gateway's Express layer handles
// gets a REAL server span with no manual code — the same instrumentation
// `tracing.ts` registers in production. This spins up a bare `http`
// server (never the full Nest app / Testcontainers — that stack is
// exercised by the Gateway's existing API integration suite; this spec's
// only job is proving the auto-instrumentation mechanism itself produces
// real spans with real trace ids), issues a REAL request against it, and
// reads the resulting spans back from a real `InMemorySpanExporter` — not
// a bare "no error was thrown" check.
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanKind } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

describe('HttpInstrumentation — auto-instruments Node http (OR4, R57, design.md §4.3)', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;
  let instrumentation: HttpInstrumentation;
  let server: http.Server;
  let port: number;
  let httpModule: typeof http;

  beforeAll(async () => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    instrumentation = new HttpInstrumentation();
    instrumentation.setTracerProvider(provider);
    instrumentation.enable();

    // A real, non-obvious finding (validating `tracing.ts`'s own header
    // comment on WHY it must be `main.ts`'s literal first import):
    // `HttpInstrumentation` patches Node's `http` module via
    // `require-in-the-middle`'s module-load hook, which only fires for a
    // module not yet resolved. `require('node:http')` MUST therefore
    // happen strictly AFTER `enable()` — a static top-level `import http
    // from 'node:http'` (evaluated before this file's own `beforeAll`
    // runs, i.e. before `enable()`) silently produces ZERO spans, no
    // error, nothing to observe failing; only a genuine, deliberately
    // POST-`enable()` `require` patches the module. Confirmed empirically
    // (a first draft of this spec used the static import and passed
    // `enable()` without complaint while `exporter.getFinishedSpans()`
    // stayed permanently empty) before switching to this dynamic
    // `require`.
    // `await import(...)` (dynamic ESM import) does NOT trigger this —
    // Vite/vitest's ESM module graph resolves `node:http` through the
    // native ESM loader, which `require-in-the-middle` (the mechanism
    // `HttpInstrumentation`, and every other core-module OTel
    // instrumentation, patches modules with) does not intercept; only a
    // genuine CJS `require()` call, evaluated strictly after `enable()`,
    // does. Confirmed empirically: swapping this line for `await
    // import('node:http')` made the request below hang until the test's
    // own timeout, with zero spans and no error — a second real finding,
    // not merely a style preference for `require` over `import`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above
    httpModule = require('node:http');

    server = httpModule.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    instrumentation.disable();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    contextManager.disable();
    await provider.shutdown();
  });

  it('a real inbound request produces a real HTTP SERVER span with a non-degenerate traceId, and a real HTTP CLIENT span for the outbound call — the exact two auto-instrumented directions design.md §4.3 names', async () => {
    exporter.reset();

    await new Promise<void>((resolve, reject) => {
      const req = httpModule.request({ host: '127.0.0.1', port, path: '/orders', method: 'POST' }, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });

    // Spans export asynchronously relative to the response — poll briefly
    // rather than a bare sleep.
    const deadline = Date.now() + 5000;
    let spans = exporter.getFinishedSpans();
    while (spans.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      spans = exporter.getFinishedSpans();
    }

    const serverSpan = spans.find((s) => s.kind === SpanKind.SERVER);
    const clientSpan = spans.find((s) => s.kind === SpanKind.CLIENT);

    expect(serverSpan).toBeDefined();
    expect(clientSpan).toBeDefined();

    // Both directions share the SAME trace — the client span is the
    // server span's parent (HttpInstrumentation's own context propagation,
    // the exact mechanism `nats-rpc-client.adapter.ts`'s own trace
    // injection relies on being active).
    expect(serverSpan!.spanContext().traceId).toBe(clientSpan!.spanContext().traceId);
    expect(serverSpan!.parentSpanContext?.spanId).toBe(clientSpan!.spanContext().spanId);
    expect(serverSpan!.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(serverSpan!.spanContext().traceId).not.toBe('0'.repeat(32));
  });
});
