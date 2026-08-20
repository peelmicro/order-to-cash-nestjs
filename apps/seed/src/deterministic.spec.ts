import { describe, expect, it } from 'vitest';
import { GLN } from '@otc/shared-kernel';
import { deterministicId, makeEan13, makeGln } from './deterministic';

describe('deterministicId — the backbone of "re-running the seed changes nothing"', () => {
  it('is a pure function of its namespace: same input, same output, every call', () => {
    expect(deterministicId('order:1')).toBe(deterministicId('order:1'));
    expect(deterministicId('retailer:CarrefourEs')).toBe(deterministicId('retailer:CarrefourEs'));
  });

  it('produces a different id for a different namespace', () => {
    expect(deterministicId('order:1')).not.toBe(deterministicId('order:2'));
  });

  it('produces a value shaped like a UUID v4 that UniqueId.from() accepts', async () => {
    const { UniqueId } = await import('@otc/shared-kernel');
    const id = deterministicId('order:1');

    expect(() => UniqueId.from(id)).not.toThrow();
    expect(UniqueId.from(id).value).toBe(id);
  });
});

describe('makeGln — GLN check digits must be genuinely valid (task prompt)', () => {
  it('produces a GLN accepted by the domain GLN value object, computed via the real GS1 algorithm', () => {
    const gln = makeGln(1);

    expect(() => GLN.of(gln)).not.toThrow();
    expect(gln).toHaveLength(13);
  });

  it('is deterministic across calls with the same sequence', () => {
    expect(makeGln(42)).toBe(makeGln(42));
  });

  it('produces a distinct GLN per sequence', () => {
    expect(makeGln(1)).not.toBe(makeGln(2));
  });
});

describe('makeEan13 — a genuine mod-10 check digit, not an invented one', () => {
  it('is internally consistent: recomputing the check digit over the 12-digit body matches the 13th digit', () => {
    const ean = makeEan13(7);
    const body = ean.slice(0, 12);
    const checkDigit = Number(ean[12]);

    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      const digit = Number(body[body.length - 1 - i]);
      sum += digit * (i % 2 === 0 ? 3 : 1);
    }
    const expected = (10 - (sum % 10)) % 10;

    expect(checkDigit).toBe(expected);
  });

  it('is deterministic and unique per sequence', () => {
    expect(makeEan13(3)).toBe(makeEan13(3));
    expect(makeEan13(3)).not.toBe(makeEan13(4));
  });
});
