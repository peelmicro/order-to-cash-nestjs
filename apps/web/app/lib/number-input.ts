import { currencyExponent, decimalStringToMinorUnits } from '@/lib/money';

/**
 * Number boxes hold the text the user typed (`type="text"` + `inputmode`),
 * never `type="number"`: Chromium reports `value === ""` for text it cannot
 * parse (`"1-2"`, `"12e"`, `"19.99-"`), which a page cannot tell from an
 * empty box, so the typed text was silently lost (see
 * `progress/impl_web_number_inputs.md`). These functions read that raw text
 * and answer with the sentence the page shows when it must refuse it.
 * `undefined` means "acceptable"; nothing here ever substitutes a default.
 */

/** The on-screen keyboard a currency box asks for: digits only for a 0-exponent currency, digits and a point otherwise. */
export function currencyInputMode(currency: string): 'decimal' | 'numeric' {
  return currencyExponent(currency) === 0 ? 'numeric' : 'decimal';
}

/** Why `text` is not an acceptable whole number of at least `min` (a quantity, a unit count), or `undefined` when it is. */
export function wholeNumberProblem(text: string, label: string, min: number): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return `${label} is required: enter a whole number of ${min} or more.`;
  if (!/^\d+$/.test(trimmed)) return `${label} must be a whole number of ${min} or more, but "${text}" is not.`;
  // Well formed but too large to be held exactly: its own sentence, not "must be digits".
  if (!Number.isSafeInteger(Number(trimmed))) return `${label} is too large: "${text}" is above the largest whole number this page can send exactly (${Number.MAX_SAFE_INTEGER}).`;
  if (Number(trimmed) < min) return `${label} must be a whole number of ${min} or more, but "${text}" is not.`;
  return undefined;
}

/** Why `text` is not an acceptable amount in `currency` (digits, and a point with up to the currency's decimals), or `undefined` when it is. */
export function amountProblem(text: string, currency: string, label: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return `${label} is required: enter an amount in ${currency}.`;
  const exponent = currencyExponent(currency);
  const wellFormed = exponent > 0 ? new RegExp(`^\\d+(?:\\.\\d{1,${exponent}})?$`) : /^\d+$/;
  if (wellFormed.test(trimmed)) {
    // Well formed but not a safe integer in minor units: too large, said so.
    if (decimalStringToMinorUnits(trimmed, currency) === undefined) return `${label} is too large: "${text}" ${currency} is above the largest amount this page can send exactly.`;
    return undefined;
  }
  const shape = exponent === 0 ? `a whole number (${currency} has no decimals)` : `digits with up to ${exponent} decimal${exponent === 1 ? '' : 's'}, like 19.${'9'.repeat(exponent)}`;
  return `${label} must be ${shape}, but "${text}" is not.`;
}

/** Like `amountProblem`, for a box that may be left empty (a unit price override, a line discount): empty is "not typed" and fine, any other text must be an amount. */
export function optionalAmountProblem(text: string, currency: string, label: string): string | undefined {
  return text.trim() === '' ? undefined : amountProblem(text, currency, label);
}
