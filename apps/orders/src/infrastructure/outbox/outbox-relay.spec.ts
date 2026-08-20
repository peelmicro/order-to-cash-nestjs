// OI6 — the configured poll interval can never cause overlapping cycles to
// compete for the same records. Pure unit: fake timers, a `runOnce` that
// resolves only on command, no Docker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxRelayConfig } from './outbox-relay.config';
import { OutboxRelayService, type RunsOutboxOnce } from './outbox-relay.service';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function config(overrides: Partial<OutboxRelayConfig> = {}): OutboxRelayConfig {
  return { enabled: true, pollIntervalMs: 100, batchSize: 10, publishTimeoutMs: 1000, ...overrides };
}

describe('OutboxRelayService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never starts a second poll cycle while one is still in progress', async () => {
    const first = deferred<{ claimed: number; published: number }>();
    const runOnce = vi.fn(() => first.promise);
    const relay: RunsOutboxOnce = { runOnce };
    const service = new OutboxRelayService(relay, config());

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(runOnce).toHaveBeenCalledTimes(1);

    // Advance well past several poll intervals while the first cycle is
    // still in flight — a second cycle must NOT start.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    // Only once the first cycle settles may the next one be scheduled.
    first.resolve({ claimed: 0, published: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(runOnce).toHaveBeenCalledTimes(2);

    await service.onApplicationShutdown();
  });

  it('does not start any cycle when OUTBOX_RELAY_ENABLED is false', async () => {
    const runOnce = vi.fn(async () => ({ claimed: 0, published: 0 }));
    const relay: RunsOutboxOnce = { runOnce };
    const service = new OutboxRelayService(relay, config({ enabled: false }));

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runOnce).not.toHaveBeenCalled();
    await service.onApplicationShutdown();
  });

  it('clears the pending timer and awaits the in-flight cycle on shutdown, starting no further cycle', async () => {
    const cycle = deferred<{ claimed: number; published: number }>();
    const runOnce = vi.fn(() => cycle.promise);
    const relay: RunsOutboxOnce = { runOnce };
    const service = new OutboxRelayService(relay, config());

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(runOnce).toHaveBeenCalledTimes(1);

    const shutdown = service.onApplicationShutdown();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdownSettled).toBe(false); // still awaiting the in-flight cycle

    cycle.resolve({ claimed: 0, published: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(shutdownSettled).toBe(true);
    expect(runOnce).toHaveBeenCalledTimes(1); // no further cycle after shutdown
  });
});
