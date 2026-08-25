import { describe, expect, it } from 'vitest';
import { formatMinorUnits } from './money-format';

describe('money-format — integer-only, currency-suffixed, never converted to major units', () => {
  it('formats a USD amount, grouping the thousands with a space', () => {
    expect(formatMinorUnits(24900, 'USD')).toBe('24 900 USD');
  });

  it('formats a EUR amount — design.md §4\'s own worked example', () => {
    expect(formatMinorUnits(24900, 'EUR')).toBe('24 900 EUR');
  });

  it('formats a GBP amount', () => {
    expect(formatMinorUnits(105, 'GBP')).toBe('105 GBP');
  });

  it('formats zero', () => {
    expect(formatMinorUnits(0, 'USD')).toBe('0 USD');
  });

  it('formats a negative amount with a leading sign, on the grouped digits', () => {
    expect(formatMinorUnits(-1500, 'EUR')).toBe('-1 500 EUR');
  });

  it('never renders a decimal point — the value is minor units, not major units', () => {
    expect(formatMinorUnits(124250, 'USD')).not.toContain('.');
  });
});
