// The ISO 4217 minor-unit exponent of a currency code — EUR, GBP and USD
// are 2, JPY is 0, BHD is 3. `openapi.yaml`'s Money section (SA-5) names
// exactly this as the source clients format money from: no REST response
// carries an exponent, because it is a property of the currency code
// itself.
//
// Backlog id 103 (D1/D7 of review_timeline_money_and_stock_names.md): this
// used to read the exponent through `Intl.NumberFormat(...)
// .resolvedOptions().maximumFractionDigits`, which is ICU/CLDR's DISPLAY
// precision, not the ISO 4217 minor-unit exponent — the two disagree for
// about fifteen codes (IQD: `Intl` says 0, ISO says 3; HUF, IDR, COP and
// eleven others: `Intl` says 0, ISO says 2), so this module both
// mis-FORMATTED and mis-PARSED amounts in those currencies. Fixed by
// importing `currencyExponent` from `@otc/shared-kernel` — the same
// hand-written ISO 4217 literal table the backend services and
// `packages/shared-kernel/src/domain/currency-exponent.ts` already carry —
// rather than keeping a second local copy in this app: `@otc/shared-kernel`
// is already a workspace dependency of every backend service (`apps/orders`,
// `apps/billing`, `apps/fulfillment`, `apps/gateway`, `apps/notifications`,
// `apps/projector`, `apps/seed`), so this app importing it too keeps a
// single definition instead of a third copy plus a parity test to keep it
// honest — pnpm's workspace resolution and pnpm's default topological
// build order (`pnpm -r run build` builds `packages/shared-kernel` before
// `apps/web`) already make that safe, proven by `pnpm build` (see
// progress/impl_web_currency_exponent_is_cldr_not_iso4217.md, #8 repo).
import { currencyExponent } from '@otc/shared-kernel';

export { currencyExponent } from '@otc/shared-kernel';

/**
 * The HTML `step` for a currency amount input — one minor unit of
 * `currency` (`"0.01"` for EUR, `"1"` for JPY, `"0.001"` for BHD).
 */
export function currencyInputStep(currency: string): string {
  const exponent = currencyExponent(currency);
  return exponent === 0 ? '1' : `0.${'1'.padStart(exponent, '0')}`;
}

/**
 * Formats an integer-minor-units amount for humans, scaling by the
 * currency's own ISO 4217 exponent (see `currencyExponent`). The scaling is
 * a division by an exact power of ten for display only; nothing parsed or
 * sent to the server ever passes through it. `minimumFractionDigits` /
 * `maximumFractionDigits` are pinned to that same exponent — left to
 * `Intl`'s own default, HUF (ISO exponent 2) would display with CLDR's 0
 * DISPLAY digits and silently round away the fraction (id 103, D1).
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(minorUnits / 10 ** exponent);
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
 * decimal string by a power of ten first pushes the value through IEEE 754
 * float arithmetic before rounding, and that arithmetic is not always
 * benign — e.g. `1.005 * 100` is `100.49999999999999` in JS, not `100.5`, so
 * `Math.round` on that lands one cent short of the mathematically intended
 * `101` — and for large amounts (`"82718514212381.37"`) even rounding lands
 * one minor unit off, because the product exceeds float precision. Here the whole and fractional digits are concatenated as TEXT (the
 * fraction right-padded to the currency's exponent) and converted to an
 * integer once, so no fractional float is ever touched for any input.
 *
 * Returns `undefined` for an empty/blank string (meaning "nothing entered")
 * and for anything that is not a valid non-negative decimal amount with at
 * most as many fractional digits as `currency` has minor units — none at all
 * for a 0-exponent currency such as JPY (including an in-progress typed
 * value, e.g. a trailing `"."` with no digits after it yet). Callers keep the
 * input bound to the user's own raw typed string, not to this function's
 * return value, so an in-progress/invalid intermediate keystroke never gets
 * silently coerced or reformatted out from under the user while typing.
 */
export function decimalStringToMinorUnits(value: string, currency: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const exponent = currencyExponent(currency);
  const pattern = exponent > 0 ? new RegExp(`^(\\d+)(?:\\.(\\d{1,${exponent}}))?$`) : /^(\d+)$/;
  const match = pattern.exec(trimmed);
  if (!match) return undefined;
  const [, wholePart = '', fractionPart = ''] = match;
  const minorUnits = Number(`${wholePart}${fractionPart.padEnd(exponent, '0')}`);
  return Number.isSafeInteger(minorUnits) ? minorUnits : undefined;
}

/**
 * The inverse of `decimalStringToMinorUnits` — formats an integer
 * minor-units amount as the decimal major-unit string a human-editable
 * currency input should display, e.g. `24999, "EUR" -> "249.99"`,
 * `24999, "JPY" -> "24999"`, `24999, "BHD" -> "24.999"`. Built digit-wise
 * rather than with `toFixed`, so it is exact for every safe integer.
 */
export function minorUnitsToDecimalString(minorUnits: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const sign = minorUnits < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(minorUnits)).toString();
  if (exponent === 0) return `${sign}${digits}`;
  const padded = digits.padStart(exponent + 1, '0');
  return `${sign}${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
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
