import { describe, expect, it } from 'vitest';
import { ReplayBuffer } from './replay-buffer';

describe('ReplayBuffer', () => {
  it('returns everything after a known cursor, resumed:true', () => {
    const buffer = new ReplayBuffer<string>(10);
    buffer.push('c1', 'a');
    buffer.push('c2', 'b');
    buffer.push('c3', 'c');

    expect(buffer.replayAfter('c1')).toEqual({ resumed: true, missed: ['b', 'c'] });
  });

  it('returns an empty missed list when the client is already caught up to the newest cursor', () => {
    const buffer = new ReplayBuffer<string>(10);
    buffer.push('c1', 'a');

    expect(buffer.replayAfter('c1')).toEqual({ resumed: true, missed: [] });
  });

  it('resumed:false, nothing missed, when no Last-Event-ID was sent at all (fresh connect)', () => {
    const buffer = new ReplayBuffer<string>(10);
    buffer.push('c1', 'a');

    expect(buffer.replayAfter(undefined)).toEqual({ resumed: false, missed: [] });
  });

  it('R55/openapi "the buffer is bounded" — a cursor older than the buffer holds resolves resumed:false, not an error and not a replay of stale data', () => {
    const buffer = new ReplayBuffer<string>(2);
    buffer.push('c1', 'a');
    buffer.push('c2', 'b');
    buffer.push('c3', 'c'); // evicts c1

    expect(buffer.replayAfter('c1')).toEqual({ resumed: false, missed: [] });
    expect(buffer.replayAfter('c2')).toEqual({ resumed: true, missed: ['c'] });
  });

  it('an unknown cursor (never issued) is treated the same as one that aged out — resumed:false', () => {
    const buffer = new ReplayBuffer<string>(10);
    buffer.push('c1', 'a');

    expect(buffer.replayAfter('not-a-real-cursor')).toEqual({ resumed: false, missed: [] });
  });

  it('never grows past its configured capacity', () => {
    const buffer = new ReplayBuffer<string>(2);
    buffer.push('c1', 'a');
    buffer.push('c2', 'b');
    buffer.push('c3', 'c');

    expect(buffer.size).toBe(2);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new ReplayBuffer<string>(0)).toThrow();
  });
});
