import { describe, expect, it } from 'vitest';
import { CursorGenerator } from './cursor';

describe('CursorGenerator', () => {
  it('produces the openapi.yaml frame-format shape "<epochMs>-<seq>"', () => {
    const generator = new CursorGenerator({ now: () => new Date('2026-08-18T10:15:02.100Z') });
    expect(generator.next()).toBe('1787048102100-1');
  });

  it('never repeats a cursor for two frames emitted within the same millisecond', () => {
    const fixedInstant = new Date('2026-08-18T10:15:02.100Z');
    const generator = new CursorGenerator({ now: () => fixedInstant });
    const first = generator.next();
    const second = generator.next();
    expect(first).not.toBe(second);
    expect(second).toBe('1787048102100-2');
  });

  it('advances the epoch-millisecond prefix when the clock advances', () => {
    let current = new Date('2026-08-18T10:15:02.100Z').getTime();
    const generator = new CursorGenerator({ now: () => new Date(current) });
    const first = generator.next();
    current += 1000;
    const second = generator.next();
    expect(first).toBe('1787048102100-1');
    expect(second).toBe('1787048103100-2');
  });
});
