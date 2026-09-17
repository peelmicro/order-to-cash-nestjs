import { currencyExponent } from './currency-exponent.js';

/**
 * Renders an integer minor-units money amount with its currency's ISO 4217
 * minor-unit exponent (`currencyExponent`) — grouped integer part, a `.`
 * decimal separator, exactly `exponent` fraction digits (none at all when
 * the exponent is 0), a space, then the ISO code:
 * `formatMoney(9245, 'EUR')` -> `"92.45 EUR"`, `formatMoney(5000, 'JPY')`
 * -> `"5 000 JPY"`, `formatMoney(12345, 'BHD')` -> `"12.345 BHD"`. Integer
 * arithmetic only — the split is done on the digit STRING, by slicing,
 * never by a floating-point division — and no locale-dependent grouping
 * (a single hard-coded ASCII space).
 *
 * This is the ONE place this rendering is implemented. Every
 * server-written human-readable rendering of a money amount in this
 * repository — the Projector's timeline summaries
 * (`apps/projector/src/domain/money-format.ts`), the Seed's timeline
 * fixtures (`apps/seed/src/data/sagas.data.ts`) and Notifications' email
 * bodies (`apps/notifications/src/infrastructure/templates/notification-format.ts`)
 * — calls through here, so a seeded document, a projected document and a
 * notification email read alike for the same amount by construction
 * (backlog id 100, `timeline_money_reads_as_minor_units`).
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const sign = minorUnits < 0 ? '-' : '';
  let digits = Math.trunc(Math.abs(minorUnits)).toString();

  if (digits.length <= exponent) {
    digits = digits.padStart(exponent + 1, '0');
  }

  const splitAt = digits.length - exponent;
  const integerDigits = digits.slice(0, splitAt);
  const fractionDigits = digits.slice(splitAt);

  const groupedInteger = integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const fraction = exponent > 0 ? `.${fractionDigits}` : '';

  return `${sign}${groupedInteger}${fraction} ${currency}`;
}
