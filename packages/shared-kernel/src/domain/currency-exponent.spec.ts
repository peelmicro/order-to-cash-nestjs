import { describe, expect, it } from 'vitest';
import { currencyExponent } from './currency-exponent';

describe('currencyExponent — SA-5\'s ISO 4217 minor-unit exponent for a currency code', () => {
  it('is 2 for EUR, USD and GBP', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('GBP')).toBe(2);
  });

  it('is 0 for JPY', () => {
    expect(currencyExponent('JPY')).toBe(0);
  });

  it('is 3 for BHD', () => {
    expect(currencyExponent('BHD')).toBe(3);
  });

  it('is 0 for UYI, the fund code missing from the original table (D1/D3)', () => {
    expect(currencyExponent('UYI')).toBe(0);
  });

  it('falls back to 2 for a code Intl-based lookup would previously have rejected', () => {
    expect(currencyExponent('ZZZ')).toBe(2);
    expect(currencyExponent('EU')).toBe(2);
  });

  it('is case-insensitive', () => {
    expect(currencyExponent('jpy')).toBe(0);
  });

  it('uses the ISO 4217 minor-unit exponent, not CLDR/Intl display digits — HUF, IDR and COP are 2, not 0 (D1)', () => {
    // Node's Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits
    // reports 0 for all of these on Node v24.19.0. ISO 4217 gives each of
    // them 2. This is the exact defect D1 exists to remove.
    expect(currencyExponent('HUF')).toBe(2);
    expect(currencyExponent('IDR')).toBe(2);
    expect(currencyExponent('COP')).toBe(2);
    expect(currencyExponent('AFN')).toBe(2);
    expect(currencyExponent('ALL')).toBe(2);
    expect(currencyExponent('IRR')).toBe(2);
    expect(currencyExponent('KPW')).toBe(2);
    expect(currencyExponent('LAK')).toBe(2);
    expect(currencyExponent('LBP')).toBe(2);
    expect(currencyExponent('MGA')).toBe(2);
    expect(currencyExponent('MMK')).toBe(2);
    expect(currencyExponent('SOS')).toBe(2);
    expect(currencyExponent('SYP')).toBe(2);
    expect(currencyExponent('YER')).toBe(2);
  });

  it('whole-table literal guard (D3) — every non-default row, plus a default-2 control', () => {
    // A countable claim: this is EVERY code the table maps away from 2,
    // plus one control (EUR) proving the default path still answers 2.
    // Armed with a single-row corruption (JOD 3 -> 2) — see the arming
    // table in progress/impl_timeline_money_reads_as_minor_units.md, "Fix
    // round 1".
    const table: Record<string, number> = {
      // Zero decimal digits.
      BIF: 0,
      CLP: 0,
      DJF: 0,
      GNF: 0,
      ISK: 0,
      JPY: 0,
      KMF: 0,
      KRW: 0,
      PYG: 0,
      RWF: 0,
      UGX: 0,
      VND: 0,
      VUV: 0,
      XAF: 0,
      XOF: 0,
      XPF: 0,
      // Three decimal digits.
      BHD: 3,
      IQD: 3,
      JOD: 3,
      KWD: 3,
      LYD: 3,
      OMR: 3,
      TND: 3,
      // Four decimal digits.
      CLF: 4,
      UYW: 4,
      // Fund code.
      UYI: 0,
      // Default-2 control.
      EUR: 2,
    };

    for (const [code, expected] of Object.entries(table)) {
      expect(currencyExponent(code), `currencyExponent(${code})`).toBe(expected);
    }
  });
});
