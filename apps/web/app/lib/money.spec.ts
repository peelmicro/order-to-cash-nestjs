// @vitest-environment node
//
// SA-5 (backlog id 97): `openapi.yaml`'s Money section says clients format
// money from the currency's ISO 4217 minor-unit exponent. These tests pin a
// 0-, a 2- and a 3-exponent currency (JPY, EUR, BHD) through every function
// that scales by it, so a hard-coded `100` fails here rather than in a
// browser that happens to show a non-2-decimal currency.
//
// Backlog id 103 (D1/D7): the exponent now comes from `@otc/shared-kernel`'s
// `currencyExponent`, an ISO 4217 literal table — not from `Intl`'s CLDR
// DISPLAY digits, which disagree with ISO 4217 for about fifteen codes.
// HUF and IQD are the two cases this file adds: `Intl.NumberFormat('en',
// {style:'currency', currency:'HUF'}).resolvedOptions().maximumFractionDigits`
// is 0 on this runtime, while ISO 4217's published minor-unit exponent for
// HUF is 2 (same divergence for IQD: `Intl` 0, ISO 3).
import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  currencyInputStep,
  decimalStringToMinorUnits,
  formatMoney,
  minorUnitsToDecimalString,
} from './money';

/** `formatMoney` uses the runtime's default locale, so expectations are rendered in that same locale from the major-unit value, with the fraction digits pinned to `exponent` explicitly (never left to `Intl`'s own CLDR default, which disagrees with ISO 4217 for HUF/IQD/etc — id 103, D1). */
function expectedFormat(major: number, currency: string, exponent: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(major);
}

describe('currencyExponent — ISO 4217 minor-unit exponent', () => {
  it.each([
    ['EUR', 2],
    ['GBP', 2],
    ['USD', 2],
    ['JPY', 0],
    ['BHD', 3],
    ['jpy', 0],
    ['HUF', 2],
    ['IQD', 3],
  ])('%s has exponent %i', (currency, exponent) => {
    expect(currencyExponent(currency)).toBe(exponent);
  });

  it('falls back to 2 for a currency code not in the ISO 4217 table (a half-typed "EU")', () => {
    expect(currencyExponent('EU')).toBe(2);
    expect(currencyExponent('')).toBe(2);
  });

  it('HUF and IQD use their ISO 4217 exponent, not the 0 Intl reports for them', () => {
    expect(new Intl.NumberFormat('en', { style: 'currency', currency: 'HUF' }).resolvedOptions().maximumFractionDigits).toBe(0);
    expect(currencyExponent('HUF')).toBe(2);
    expect(new Intl.NumberFormat('en', { style: 'currency', currency: 'IQD' }).resolvedOptions().maximumFractionDigits).toBe(0);
    expect(currencyExponent('IQD')).toBe(3);
  });
});

describe('formatMoney — scales by the currency exponent, not by 100', () => {
  it('EUR (2): 24999 minor units is 249.99', () => {
    expect(formatMoney(24999, 'EUR')).toBe(expectedFormat(249.99, 'EUR', 2));
  });

  it('JPY (0): 24999 minor units is 24,999 yen, not 249.99', () => {
    expect(formatMoney(24999, 'JPY')).toBe(expectedFormat(24999, 'JPY', 0));
    expect(new Intl.NumberFormat('en', { style: 'currency', currency: 'JPY' }).format(24999)).toBe('¥24,999');
  });

  it('BHD (3): 24999 minor units is 24.999', () => {
    expect(formatMoney(24999, 'BHD')).toBe(expectedFormat(24.999, 'BHD', 3));
  });

  it('HUF (2): 12345 minor units is 123.45, not 12,345 (the CLDR-display-digits bug this feature fixes)', () => {
    expect(formatMoney(12345, 'HUF')).toBe(expectedFormat(123.45, 'HUF', 2));
    expect(formatMoney(12345, 'HUF')).toContain('123.45');
  });

  it('IQD (3): 12345 minor units is 12.345, not 12,345', () => {
    expect(formatMoney(12345, 'IQD')).toBe(expectedFormat(12.345, 'IQD', 3));
    expect(formatMoney(12345, 'IQD')).toContain('12.345');
  });
});

describe('decimalStringToMinorUnits — digit-wise, per-currency exponent', () => {
  it.each([
    ['0.29', 'EUR', 29],
    ['19.99', 'EUR', 1999],
    ['249.99', 'EUR', 24999],
    ['1.5', 'EUR', 150],
    ['20', 'EUR', 2000],
    ['1.005', 'BHD', 1005],
    ['0.29', 'BHD', 290],
    ['19.99', 'BHD', 19990],
    ['24.999', 'BHD', 24999],
    ['1', 'BHD', 1000],
    ['24999', 'JPY', 24999],
    ['0', 'JPY', 0],
    ['123.45', 'HUF', 12345],
    ['12.345', 'IQD', 12345],
  ])('"%s" in %s is %i minor units', (input, currency, expected) => {
    expect(decimalStringToMinorUnits(input, currency)).toBe(expected);
  });

  it.each([
    ['1.005', 'EUR'],
    ['1.5', 'JPY'],
    ['1.', 'JPY'],
    ['1.2345', 'BHD'],
    ['20.', 'EUR'],
    ['-1', 'EUR'],
    ['1e3', 'EUR'],
    ['1,000', 'EUR'],
    ['abc', 'BHD'],
    ['123.456', 'HUF'],
    ['12.3456', 'IQD'],
  ])('"%s" in %s is rejected (undefined), never a wrong number', (input, currency) => {
    expect(decimalStringToMinorUnits(input, currency)).toBeUndefined();
  });

  it('an empty or blank string means "nothing entered"', () => {
    expect(decimalStringToMinorUnits('', 'EUR')).toBeUndefined();
    expect(decimalStringToMinorUnits('   ', 'JPY')).toBeUndefined();
  });

  it('never goes through float multiplication: the classic float traps are exact', () => {
    // The premise: in IEEE 754 these products are not integers, so a
    // truncating parse would lose a minor unit on each.
    expect([Math.trunc(0.29 * 100), Math.trunc(19.99 * 100), Math.trunc(1.005 * 1000)]).toEqual([28, 1998, 1004]);
    expect(decimalStringToMinorUnits('0.29', 'EUR')).toBe(29);
    expect(decimalStringToMinorUnits('19.99', 'EUR')).toBe(1999);
    expect(decimalStringToMinorUnits('1.005', 'BHD')).toBe(1005);
  });

  it('is exact where even Math.round(parseFloat(x) * 100) is not: large safe-integer amounts', () => {
    // The premise: rounding after float multiplication is off by one minor unit here.
    expect(Math.round(Number('82718514212381.37') * 100)).toBe(8271851421238138);
    expect(decimalStringToMinorUnits('82718514212381.37', 'EUR')).toBe(8271851421238137);
    expect(decimalStringToMinorUnits('85802646842329.74', 'EUR')).toBe(8580264684232974);
  });

  it('refuses a value beyond the safe-integer range rather than rounding it', () => {
    expect(decimalStringToMinorUnits('90071992547409.93', 'EUR')).toBeUndefined();
  });
});

describe('minorUnitsToDecimalString — the inverse, per-currency exponent', () => {
  it.each([
    [24999, 'EUR', '249.99'],
    [5, 'EUR', '0.05'],
    [0, 'EUR', '0.00'],
    [24999, 'JPY', '24999'],
    [0, 'JPY', '0'],
    [24999, 'BHD', '24.999'],
    [5, 'BHD', '0.005'],
    [0, 'BHD', '0.000'],
    [12345, 'HUF', '123.45'],
    [12345, 'IQD', '12.345'],
  ])('%i in %s is "%s"', (minorUnits, currency, expected) => {
    expect(minorUnitsToDecimalString(minorUnits, currency)).toBe(expected);
  });

  it.each(['EUR', 'JPY', 'BHD', 'HUF', 'IQD'])('round-trips through decimalStringToMinorUnits in %s', (currency) => {
    for (const minorUnits of [0, 1, 29, 1005, 1999, 24999, 100000]) {
      expect(decimalStringToMinorUnits(minorUnitsToDecimalString(minorUnits, currency), currency)).toBe(minorUnits);
    }
  });
});

describe('currencyInputStep — one minor unit of the currency', () => {
  it.each([
    ['EUR', '0.01'],
    ['JPY', '1'],
    ['BHD', '0.001'],
    ['HUF', '0.01'],
    ['IQD', '0.001'],
  ])('%s steps by %s', (currency, step) => {
    expect(currencyInputStep(currency)).toBe(step);
  });
});
