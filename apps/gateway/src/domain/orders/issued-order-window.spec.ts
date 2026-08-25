import { describe, expect, it } from 'vitest';
import { IssuedOrderWindow } from './issued-order-window';

describe('IssuedOrderWindow — F3, R55 "an id the caller has just been given"', () => {
  it('reports an id as recently issued right after record()', () => {
    const window = new IssuedOrderWindow({ now: () => new Date('2026-08-18T10:00:00.000Z') }, 60_000, 10);
    window.record('order-1');

    expect(window.isRecentlyIssued('order-1')).toBe(true);
  });

  it('reports false for an id that was never recorded — the "genuinely unknown" case', () => {
    const window = new IssuedOrderWindow({ now: () => new Date('2026-08-18T10:00:00.000Z') }, 60_000, 10);

    expect(window.isRecentlyIssued('never-issued')).toBe(false);
  });

  it('expires an entry once its age exceeds ttlMs, and evicts it (subsequent size reflects the eviction)', () => {
    let current = new Date('2026-08-18T10:00:00.000Z').getTime();
    const window = new IssuedOrderWindow({ now: () => new Date(current) }, 1000, 10);
    window.record('order-1');

    current += 1001;
    expect(window.isRecentlyIssued('order-1')).toBe(false);
    expect(window.size).toBe(0);
  });

  it('stays true right up to the ttl boundary and flips false just past it', () => {
    let current = new Date('2026-08-18T10:00:00.000Z').getTime();
    const window = new IssuedOrderWindow({ now: () => new Date(current) }, 1000, 10);
    window.record('order-1');

    current += 1000;
    expect(window.isRecentlyIssued('order-1')).toBe(true);

    current += 1;
    expect(window.isRecentlyIssued('order-1')).toBe(false);
  });

  it('evicts the oldest entry once capacity is exceeded, bounding memory', () => {
    const window = new IssuedOrderWindow({ now: () => new Date('2026-08-18T10:00:00.000Z') }, 60_000, 2);
    window.record('order-1');
    window.record('order-2');
    window.record('order-3');

    expect(window.isRecentlyIssued('order-1')).toBe(false);
    expect(window.isRecentlyIssued('order-2')).toBe(true);
    expect(window.isRecentlyIssued('order-3')).toBe(true);
    expect(window.size).toBe(2);
  });

  it('rejects a non-positive ttlMs or capacity', () => {
    expect(() => new IssuedOrderWindow({ now: () => new Date() }, 0, 10)).toThrow();
    expect(() => new IssuedOrderWindow({ now: () => new Date() }, 1000, 0)).toThrow();
  });
});
