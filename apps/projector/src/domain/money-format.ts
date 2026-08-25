// Integer-only rendering of an integer-minor-units amount together with its
// currency code (design.md §4, PR16). Deliberately DOES NOT convert to
// major units (no `/100`, no `.toFixed`, no `Intl` on a float) — the
// timeline is a projection of the domain's own facts, and every payload
// amount in this system already IS integer minor units (CLAUDE.md § Money);
// converting it here would be a lossy, currency-blind operation this
// service has no business performing. Grouped with a thin-space-free ASCII
// space as the thousands separator purely for human readability, e.g.
// `formatMinorUnits(24900, 'EUR')` -> `"24 900 EUR"` (design.md §4's own
// worked example).
export function formatMinorUnits(minorUnits: number, currency: string): string {
  const sign = minorUnits < 0 ? '-' : '';
  const digits = Math.trunc(Math.abs(minorUnits)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${grouped} ${currency}`;
}
