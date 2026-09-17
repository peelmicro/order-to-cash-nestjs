import { describe, expect, it } from 'vitest';
import { formatMoney } from './money-text';

// Backlog id 100 (timeline_money_reads_as_minor_units) — the ONE
// implementation the Projector, the Seed and Notifications all share.
// Whole-string assertions only.
describe('formatMoney — grouped, exponent-scaled, currency-suffixed rendering', () => {
  it('renders a 2-exponent currency (EUR) — the maintainer\'s own reported defect', () => {
    expect(formatMoney(9245, 'EUR')).toBe('92.45 EUR');
  });

  it('groups the integer part in threes with a single ASCII space', () => {
    expect(formatMoney(1613000, 'EUR')).toBe('16 130.00 EUR');
  });

  it('renders a 0-exponent currency (JPY) with no decimal point at all', () => {
    expect(formatMoney(5000, 'JPY')).toBe('5 000 JPY');
  });

  it('renders a 3-exponent currency (BHD)', () => {
    expect(formatMoney(12345, 'BHD')).toBe('12.345 BHD');
  });

  it('pads a sub-unit amount for a 3-exponent currency', () => {
    expect(formatMoney(5, 'BHD')).toBe('0.005 BHD');
  });

  it('renders a negative amount with the sign before the grouped digits', () => {
    expect(formatMoney(-150, 'EUR')).toBe('-1.50 EUR');
  });

  it('renders zero', () => {
    expect(formatMoney(0, 'EUR')).toBe('0.00 EUR');
    expect(formatMoney(0, 'JPY')).toBe('0 JPY');
  });

  it('renders -1 minor unit', () => {
    expect(formatMoney(-1, 'EUR')).toBe('-0.01 EUR');
  });

  it('renders a JS-safe-integer-scale amount without truncation (the JS equivalent of .NET\'s long.MaxValue)', () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER, 'EUR')).toBe('90 071 992 547 409.91 EUR');
  });

  it('groups a value above 32-bit int range without truncation', () => {
    expect(formatMoney(2147483648, 'EUR')).toBe('21 474 836.48 EUR');
  });

  // Backlog id 100, fix round 1 — D2: a floating-point division
  // (`(Math.abs(minorUnits) / 10 ** exponent).toFixed(exponent)`) survived
  // the existing MAX_SAFE_INTEGER case above (it happens to round to the
  // same string). These two values were computed to disagree with the
  // integer-split algorithm under float division, and kill that mutation.
  it('renders a value one below MAX_SAFE_INTEGER without the float-division rounding error (D2)', () => {
    expect(formatMoney(9007199254740990, 'EUR')).toBe('90 071 992 547 409.90 EUR');
  });

  it('renders MAX_SAFE_INTEGER for a 3-exponent currency without the float-division rounding error (D2)', () => {
    expect(formatMoney(9007199254740991, 'BHD')).toBe('9 007 199 254 740.991 BHD');
  });
});
