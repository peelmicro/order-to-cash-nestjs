import { describe, expect, it } from 'vitest';
import { amountProblem, currencyInputMode, wholeNumberProblem } from './number-input';

describe('wholeNumberProblem', () => {
  it.each(['1', '3', '007', '120', ' 7 '])('accepts %j', (text) => {
    expect(wholeNumberProblem(text, 'Units', 1)).toBeUndefined();
  });
  it.each(['1-2', '12e', '5-', '1.5', '0', 'abc', '-4', '1e3', '1e-2'])('refuses %j, naming the field and quoting the text', (text) => {
    expect(wholeNumberProblem(text, 'Units', 1)).toBe(`Units must be a whole number of 1 or more, but "${text}" is not.`);
  });
  it('refuses empty text as required, not as zero', () => {
    expect(wholeNumberProblem('  ', 'Units', 1)).toBe('Units is required: enter a whole number of 1 or more.');
  });
  it('says "too large" (not "must be digits") for well-formed digits above the largest safe integer, and accepts that integer itself', () => {
    expect(wholeNumberProblem('99999999999999999999', 'Units', 1)).toBe('Units is too large: "99999999999999999999" is above the largest whole number this page can send exactly (9007199254740991).');
    expect(wholeNumberProblem('9007199254740993', 'Units', 1)).toContain('is too large');
    expect(wholeNumberProblem('9007199254740991', 'Units', 1)).toBeUndefined();
  });
});

describe('amountProblem', () => {
  it.each([['19.99', 'EUR'], ['0.29', 'EUR'], ['5', 'EUR'], ['1.005', 'BHD'], ['24999', 'JPY']])('accepts %j in %s', (text, currency) => {
    expect(amountProblem(text, currency, 'Amount')).toBeUndefined();
  });
  it.each(['1-2', '12e', '19.99-', '5-', '19.999', 'abc', '1,5', '-1', '1e3', '1e-2'])('refuses %j in EUR, naming the field and the shape', (text) => {
    expect(amountProblem(text, 'EUR', 'Amount')).toBe(`Amount must be digits with up to 2 decimals, like 19.99, but "${text}" is not.`);
  });
  it('names a whole number for a 0-exponent currency and refuses a fraction', () => {
    expect(amountProblem('1.5', 'JPY', 'Amount')).toBe('Amount must be a whole number (JPY has no decimals), but "1.5" is not.');
  });
  it('says "too large" for a well-formed amount above the largest safe integer in minor units, and accepts the largest one', () => {
    expect(amountProblem('90071992547409.92', 'EUR', 'Amount')).toBe('Amount is too large: "90071992547409.92" EUR is above the largest amount this page can send exactly.');
    expect(amountProblem('9007199254740992', 'JPY', 'Amount')).toContain('is too large');
    expect(amountProblem('90071992547409.91', 'EUR', 'Amount')).toBeUndefined();
  });
  it('refuses empty text as required', () => {
    expect(amountProblem('', 'EUR', 'Amount')).toBe('Amount is required: enter an amount in EUR.');
  });
});

describe('currencyInputMode', () => {
  it.each([['EUR', 'decimal'], ['BHD', 'decimal'], ['JPY', 'numeric']])('%s asks for the %s keyboard', (currency, mode) => {
    expect(currencyInputMode(currency)).toBe(mode);
  });
});
