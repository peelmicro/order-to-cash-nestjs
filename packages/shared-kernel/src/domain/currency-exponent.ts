// ISO 4217's minor-unit exponent for a currency code — SA-5
// (specs/shared/openapi.yaml's Money section): "Formatting for humans
// happens ... from the currency's ISO 4217 minor-unit exponent (EUR, GBP
// and USD are 2; JPY is 0; BHD is 3). No response carries that exponent: it
// is a property of the currency code itself."
//
// Ported-idiom ledger (corrected, backlog id 100 fix round 1 — D1). This
// function previously read ICU's currency-display-digits table through
// `Intl.NumberFormat(locale, { style: 'currency', currency })
// .resolvedOptions().maximumFractionDigits`, reusing the idea already used
// for the same question at `apps/web/app/lib/money.ts:22` (SA-5, id 97).
// That was a defect: `Intl`'s `maximumFractionDigits` is CLDR's DISPLAY
// convention, not the ISO 4217 minor-unit exponent, and the two disagree
// for several currencies. Measured on Node v24.19.0:
//
//   AFN ALL IRR KPW LAK LBP MGA MMK SOS SYP YER HUF COP IDR
//
// all report 0 fraction digits under `Intl` while ISO 4217 gives each of
// them 2 — a 100x misread for a plausible B2B currency (HUF, IDR, COP).
// `Intl` only happened to answer correctly for the two currencies this
// feature's original acceptance examples probed (JPY, BHD).
//
// Fixed by replacing the `Intl` lookup with the identical hand-written ISO
// 4217 literal table #8's `src/SharedKernel/CurrencyExponent.cs` already
// carries — the zero-, three- and four-decimal currency sets the ISO 4217
// maintenance agency publishes (and that are commonly reproduced, e.g.
// Wikipedia's "ISO 4217" article, Active codes table, "Minor unit"
// column). Every currency not listed defaults to 2. Kept as one
// `["XXX"] = n,`-shaped entry per line (readable one-to-one against #8's
// table, and against id 103's web parity test, which reads both).
const DEFAULT_EXPONENT = 2;

// Currencies whose ISO 4217 minor-unit exponent is NOT 2 — every other
// code defaults to DEFAULT_EXPONENT. This table is a countable claim
// (D3): guarded by currency-exponent.spec.ts's whole-table literal test.
const NON_DEFAULT_EXPONENTS: Readonly<Record<string, number>> = {
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

  // Fund codes with a published ISO 4217 minor-unit exponent of zero
  // (backlog id 100, fix round 1 — D1/D3): UYI was missing from the
  // original table.
  UYI: 0,
};

export function currencyExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  return NON_DEFAULT_EXPONENTS[code] ?? DEFAULT_EXPONENT;
}
