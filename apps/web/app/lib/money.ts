/**
 * Formats an integer-minor-units amount for humans. openapi.yaml notes that
 * formatting should derive from `currency.decimalPoints`, which no endpoint
 * in this pass's scope exposes — `Intl.NumberFormat` derives the same
 * fact (EUR/GBP/USD all being 2-decimal minor units) from the ISO 4217 code
 * itself, which is what this system's seeded currencies are, so dividing by
 * 100 is accurate for them. A currency with a different minor-unit exponent
 * would need the real `decimalPoints` value; noted as a simplification.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minorUnits / 100);
}

export interface DraftLine {
  productCode: string;
  quantity: number;
  unitPrice?: number;
  lineDiscount?: number;
}

/**
 * Parses a decimal major-unit amount a human typed into a currency input
 * (e.g. `"249.99"`) into an integer minor-units amount — the wire/domain
 * format this project's Money convention requires everywhere except this one
 * display layer (CLAUDE.md: "Money is integer minor units. Never a float.").
 *
 * Deliberately NOT `Math.round(parseFloat(value) * 100)`: multiplying a
 * decimal string by 100 first pushes the value through IEEE 754 float
 * arithmetic before rounding, and that arithmetic is not always benign —
 * e.g. `1.005 * 100` is `100.49999999999999` in JS, not `100.5`, so
 * `Math.round` on that lands one cent short of the mathematically intended
 * `101`. Parsing the whole/fractional parts directly out of the string as
 * integers never touches a fractional float at all, so this cannot exhibit
 * that class of error for any input.
 *
 * Returns `undefined` for an empty/blank string (meaning "nothing entered")
 * and for anything that is not a valid non-negative decimal amount with at
 * most two fractional digits (including an in-progress typed value, e.g. a
 * trailing `"."` with no digits after it yet) — callers keep the input bound
 * to the user's own raw typed string, not to this function's return value,
 * so an in-progress/invalid intermediate keystroke never gets silently
 * coerced or reformatted out from under the user while they are still typing.
 */
export function decimalStringToMinorUnits(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return undefined;
  const [, wholePart, fractionPart = ''] = match;
  const paddedFraction = fractionPart.padEnd(2, '0');
  return Number(wholePart) * 100 + Number(paddedFraction);
}

/**
 * The inverse of `decimalStringToMinorUnits` — formats an integer
 * minor-units amount as the decimal major-unit string a human-editable
 * currency input should display, e.g. `24999 -> "249.99"`. Display-only; see
 * `formatMoney`'s own comment for the same "2 fractional digits, per this
 * system's seeded ISO 4217 currencies" simplification.
 */
export function minorUnitsToDecimalString(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

/** One line's total, honouring an explicit `unitPrice` override (R42's `.99` affordance) over the catalogue price. */
export function draftLineTotal(line: DraftLine, catalogPrice: number | undefined): number {
  const price = line.unitPrice ?? catalogPrice ?? 0;
  const quantity = Number.isFinite(line.quantity) ? line.quantity : 0;
  return price * quantity - (line.lineDiscount ?? 0);
}

/** The running order total shown live as lines are added — mirrors the aggregate's own `initialAmount − initialDiscount` (invariant O3, R6), computed client-side purely for display; the server always recomputes and owns the authoritative total. */
export function draftOrderTotal(
  lines: DraftLine[],
  priceByProductCode: Map<string, number>,
  orderDiscount: number,
): number {
  const gross = lines.reduce((sum, line) => sum + draftLineTotal(line, priceByProductCode.get(line.productCode)), 0);
  return gross - orderDiscount;
}
