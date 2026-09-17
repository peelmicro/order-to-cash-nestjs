import { formatMoney } from '@otc/shared-kernel';

// Integer-only rendering of an integer-minor-units amount together with its
// currency code (design.md §4, PR16; backlog id 100,
// `timeline_money_reads_as_minor_units`) — the maintainer saw "Credit hold
// of 9 245 EUR approved" on a €92.45 order's timeline. Delegates entirely
// to `@otc/shared-kernel`'s `formatMoney`, the ONE implementation this
// repository's timeline summaries, seed fixtures and notification emails
// all share, so they read alike by construction rather than by three
// implementations kept in sync by hand.
export function formatMinorUnits(minorUnits: number, currency: string): string {
  return formatMoney(minorUnits, currency);
}
