import { describe, expect, it } from 'vitest';

import { GLN, InvalidGlnError } from './gln.js';

// --- Independent oracle -----------------------------------------------
//
// R4 requires the *real* GS1 mod-10 algorithm, proved with real valid GLNs.
// Rather than trust GLN.computeCheckDigit() to validate itself, the two
// valid GLNs below are derived by hand, following domain-model.md §2.4
// literally:
//
//   "Multiply digits 1..12 alternately by 3 and 1 starting from the right
//    of the 12-digit body (i.e. position 12 x 3, position 11 x 1, ...),
//    sum the products, and the check digit is (10 - (sum mod 10)) mod 10."
//
// Body "123456789012", digits from the right (d0 = rightmost):
//   d0=2*3=6  d1=1*1=1  d2=0*3=0  d3=9*1=9  d4=8*3=24 d5=7*1=7
//   d6=6*3=18 d7=5*1=5  d8=4*3=12 d9=3*1=3  d10=2*3=6 d11=1*1=1
//   sum = 6+1+0+9+24+7+18+5+12+3+6+1 = 92
//   check digit = (10 - (92 mod 10)) mod 10 = (10 - 2) mod 10 = 8
//   => GLN "1234567890128" (a well-known GS1 worked example).
//
// Body "000000000000", every weighted product is 0:
//   sum = 0 => check digit = (10 - 0) mod 10 = 10 mod 10 = 0
//   => GLN "0000000000000" (boundary: sum mod 10 = 0).
const VALID_GLN = '1234567890128';
const VALID_GLN_ALL_ZEROS = '0000000000000';

describe('GLN — R4: exactly 13 digits with a valid GS1 mod-10 check digit', () => {
  it('accepts a hand-computed valid GLN (independent oracle)', () => {
    const gln = GLN.of(VALID_GLN);

    expect(gln.value).toBe(VALID_GLN);
  });

  it('accepts the all-zeros boundary case where sum mod 10 = 0', () => {
    const gln = GLN.of(VALID_GLN_ALL_ZEROS);

    expect(gln.value).toBe(VALID_GLN_ALL_ZEROS);
  });

  it('computeCheckDigit() reproduces the hand-computed check digits', () => {
    expect(GLN.computeCheckDigit('123456789012')).toBe(8);
    expect(GLN.computeCheckDigit('000000000000')).toBe(0);
  });

  it('computeCheckDigit() refuses a body that is not exactly 12 digits', () => {
    expect(() => GLN.computeCheckDigit('12345')).toThrow(InvalidGlnError);
    expect(() => GLN.computeCheckDigit('12345678901a')).toThrow(InvalidGlnError);
  });

  it('refuses a value that is not exactly 13 digits', () => {
    expect(() => GLN.of('123456789012')).toThrow(InvalidGlnError); // 12 digits
    expect(() => GLN.of('12345678901288')).toThrow(InvalidGlnError); // 14 digits
    expect(() => GLN.of('')).toThrow(InvalidGlnError);
  });

  it('refuses a value containing non-digit characters', () => {
    expect(() => GLN.of('123456789012a')).toThrow(InvalidGlnError);
    expect(() => GLN.of('12345 6789012')).toThrow(InvalidGlnError);
    expect(() => GLN.of('123456789012-')).toThrow(InvalidGlnError);
  });

  it('refuses a value whose final digit is not the correct GS1 check digit', () => {
    // Flip the check digit of the valid GLN to every other possible digit.
    const body = VALID_GLN.slice(0, 12);
    const correctCheckDigit = VALID_GLN[12];

    for (let candidate = 0; candidate <= 9; candidate++) {
      const candidateDigit = String(candidate);
      if (candidateDigit === correctCheckDigit) continue;
      expect(() => GLN.of(`${body}${candidateDigit}`)).toThrow(InvalidGlnError);
    }
  });

  it('rejects every single-digit mutation of a valid GLN (systematic invalidity)', () => {
    for (let position = 0; position < VALID_GLN.length; position++) {
      const originalDigit = VALID_GLN[position];
      for (let replacement = 0; replacement <= 9; replacement++) {
        const replacementDigit = String(replacement);
        if (replacementDigit === originalDigit) continue;

        const mutated =
          VALID_GLN.slice(0, position) + replacementDigit + VALID_GLN.slice(position + 1);

        expect(
          () => GLN.of(mutated),
          `mutating position ${position} of ${VALID_GLN} to ${replacementDigit} should be rejected`,
        ).toThrow(InvalidGlnError);
      }
    }
  });

  it('is equal by value', () => {
    expect(GLN.of(VALID_GLN).equals(GLN.of(VALID_GLN))).toBe(true);
    expect(GLN.of(VALID_GLN).equals(GLN.of(VALID_GLN_ALL_ZEROS))).toBe(false);
  });

  it('toString() returns the 13-digit value', () => {
    expect(GLN.of(VALID_GLN).toString()).toBe(VALID_GLN);
  });
});
