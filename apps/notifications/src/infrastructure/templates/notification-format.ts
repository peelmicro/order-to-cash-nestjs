// Small formatting helpers shared by every fact template
// (infrastructure/templates/*.template.ts) — no framework, no I/O, pure
// functions, so each template stays trivially unit-testable.
import { formatMoney as sharedFormatMoney } from '@otc/shared-kernel';

/**
 * Renders an integer-minor-units amount (CLAUDE.md § Money: "never a
 * float") as a human-readable string for an email body, scaled by the
 * currency's own ISO 4217 minor-unit exponent (SA-5) — e.g.
 * `formatMoney(124250, 'USD')` -> `"1 242.50 USD"`,
 * `formatMoney(5000, 'JPY')` -> `"5 000 JPY"`. Delegates to
 * `@otc/shared-kernel`'s `formatMoney` — the same implementation the
 * Projector's timeline summaries and the Seed's timeline fixtures use, so
 * an email and a timeline entry read alike for the same amount (backlog id
 * 100).
 */
export function formatMoney(amountMinorUnits: number, currency: string): string {
  return sharedFormatMoney(amountMinorUnits, currency);
}

/**
 * Synthesizes a recipient address from `identifier` — normally the
 * retailer's `PartyCode`, but `PaymentReceivedPayload` carries no
 * `retailerCode` at all (`packages/contracts`'s shape is `{orderReference,
 * invoiceReference, paymentReference, currency, amount, valueDate,
 * source}`), so `payment-received.template.ts` passes `orderReference`
 * instead — the best available identifier for that one fact.
 *
 * The domain model carries NO email address for a `PartyCode` anywhere —
 * `Party` is `{ code, name, country, vat?, gln, currency, enabled }`, and no
 * fact payload in `asyncapi.types.ts` carries one either (grepped for
 * `email`, zero hits). This is a demo affordance, not a real address book:
 * Mailpit (the local SMTP sink, docker-compose.infra.yml's `mailpit`
 * service) accepts and captures any address without delivering it
 * externally, so a deterministic, human-readable synthetic address is
 * sufficient to prove "the party for this order was notified" in its inbox
 * — see progress/impl_notifications_service.md.
 */
export function recipientFor(identifier: string): string {
  return `${identifier.toLowerCase()}@retailer.order-to-cash.example`;
}

/** The correlation id belongs in the subject line of every template (feature 23's acceptance list) — one shared formatter so the wording cannot drift between the seven templates. */
export function subjectWithCorrelationId(summary: string, correlationId: string): string {
  return `[order-to-cash] ${summary} (correlationId: ${correlationId})`;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * N9 (notifications_service re-review) — every payload-derived string that
 * lands inside an HTML template must go through this first. Fact payloads
 * are internally produced today, but `paymentReference` on the remittance
 * path (feature 22) is externally supplied and rendered by an email
 * client — an unescaped `<`/`&`/etc. in a business reference would inject
 * markup into the message. The PLAIN TEXT body never needs this (no markup
 * to inject into); only the seven `html` strings do.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}
