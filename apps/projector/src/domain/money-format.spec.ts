import { describe, expect, it } from 'vitest';
import { formatMinorUnits } from './money-format';

// Backlog id 100 (`timeline_money_reads_as_minor_units`) — the maintainer
// saw "Credit hold of 9 245 EUR approved" on a €92.45 order's timeline.
// Whole-string assertions only: grouped integer part, a `.` decimal
// separator, exactly the currency's ISO 4217 exponent worth of fraction
// digits (none at all for a 0-exponent currency), a space, the code.
describe('formatMinorUnits — scales by the currency\'s own ISO 4217 minor-unit exponent, never floats', () => {
  it('renders a 2-exponent currency (EUR) — the maintainer\'s own reported defect', () => {
    expect(formatMinorUnits(9245, 'EUR')).toBe('92.45 EUR');
  });

  it('groups the integer part in threes with a single ASCII space', () => {
    expect(formatMinorUnits(1613000, 'EUR')).toBe('16 130.00 EUR');
  });

  it('renders a 0-exponent currency (JPY) with no decimal point at all', () => {
    expect(formatMinorUnits(5000, 'JPY')).toBe('5 000 JPY');
  });

  it('renders zero for a 0-exponent currency', () => {
    expect(formatMinorUnits(0, 'JPY')).toBe('0 JPY');
  });

  it('renders a 3-exponent currency (BHD)', () => {
    expect(formatMinorUnits(12345, 'BHD')).toBe('12.345 BHD');
  });

  it('pads a sub-unit 3-exponent amount', () => {
    expect(formatMinorUnits(5, 'BHD')).toBe('0.005 BHD');
  });

  it('renders a negative amount with the sign before the grouped digits', () => {
    expect(formatMinorUnits(-150, 'EUR')).toBe('-1.50 EUR');
  });

  it('renders zero for a 2-exponent currency', () => {
    expect(formatMinorUnits(0, 'EUR')).toBe('0.00 EUR');
  });

  it('renders -1 minor unit', () => {
    expect(formatMinorUnits(-1, 'EUR')).toBe('-0.01 EUR');
  });

  it('renders a JS-safe-integer-scale amount without truncation', () => {
    // 9 007 199 254 740 991 = Number.MAX_SAFE_INTEGER — the JS equivalent
    // of .NET's `long.MaxValue` (which has no exact JS representation).
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER, 'EUR')).toBe('90 071 992 547 409.91 EUR');
  });

  it('renders a JS-safe-integer-scale amount for a 0-exponent currency', () => {
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER, 'JPY')).toBe('9 007 199 254 740 991 JPY');
  });

  it('groups a value above 32-bit int range without truncation', () => {
    expect(formatMinorUnits(2147483648, 'EUR')).toBe('21 474 836.48 EUR');
  });

  // Backlog id 100, fix round 1 — D2: the shared-kernel's own large-value
  // case (kills the floating-point-division mutation that survived the
  // pre-existing MAX_SAFE_INTEGER case, which happens to round the same
  // way under float division). Kept here too because this spec keeps its
  // own large-value cases.
  it('renders a value one below MAX_SAFE_INTEGER without the float-division rounding error (D2)', () => {
    expect(formatMinorUnits(9007199254740990, 'EUR')).toBe('90 071 992 547 409.90 EUR');
  });

  it('renders MAX_SAFE_INTEGER for a 3-exponent currency without the float-division rounding error (D2)', () => {
    expect(formatMinorUnits(9007199254740991, 'BHD')).toBe('9 007 199 254 740.991 BHD');
  });

  it('is insensitive to the runtime locale — Intl is used only to read the EXPONENT, never to format the amount', () => {
    // formatMinorUnits never calls `Intl.NumberFormat(...).format()` on the
    // amount itself, so there is no locale to vary here; this pins that by
    // asserting the ASCII-space grouping regardless of which currency's
    // Intl-resolved exponent was used.
    expect(formatMinorUnits(16130, 'EUR')).toBe('161.30 EUR');
    expect(formatMinorUnits(1000000, 'USD')).toBe('10 000.00 USD');
  });
});
