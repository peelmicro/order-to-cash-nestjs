// The notification-sender port (feature 23's seam) — mirrors the
// port-plus-two-adapters shape
// apps/billing/src/application/ports/credit-decision.port.ts establishes:
// ONE interface, swappable by a single provider binding in app.module.ts.
// `ConsoleNotificationSender` (infrastructure/notification/
// console-notification-sender.ts) is bound in every automated test and by
// default; `SmtpNotificationSender` (same folder) is bound only when
// smtp.config.ts finds a valid-looking, complete SMTP credential pair —
// provider-neutral by construction (Mailpit locally, any SMTP host,
// Mailtrap included, elsewhere; see docker-compose.infra.yml's `mailpit`
// service header).
//
// Unlike `CreditDecisionPort`, this port performs real I/O (an SMTP
// round-trip, or a console write) — there is no in-transaction/no-I/O
// constraint here, because this service has no unit of work, no aggregate
// and no row lock to run inside (see notification-facts.controller.ts's
// header for why this service consumes without a database at all).
export const NOTIFICATION_SENDER = Symbol('NotificationSender');

export interface NotificationMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * N4 (notifications_service re-review) — `<eventId>@order-to-cash`, set
   * by `NotificationDispatchService.dispatch` from the fact's own
   * `eventId`. DEFENCE IN DEPTH ONLY, never the dedup mechanism (that is
   * the durable `processed_events` ledger, N1/N2): it makes each of the
   * seven sends individually attributable in the inbox (Mailpit locally),
   * and any duplicate visible to a human at a glance, but it prevents
   * nothing by itself — SMTP has no dedup and Mailpit does not enforce
   * uniqueness on this header either.
   */
  readonly messageId?: string;
  /**
   * R58 closeout (design.md §4.4, Phase 25 traceability audit
   * `progress/review_traceability_audit.md` §3) — the fact's own
   * `correlationId`, set by `NotificationDispatchService.dispatch` from
   * the same envelope `messageId` above is built from. This is the ONLY
   * way `degrading-notification-sender.ts`'s own structured log (fired on
   * a permanent SMTP failure) can carry a `correlationId`: `send`'s own
   * signature carries no envelope, only this message, mirroring
   * `messageId`'s existing "defence in depth" precedent above rather than
   * widening the port to accept a whole `Envelope` for one field.
   */
  readonly correlationId?: string;
}

export interface NotificationSender {
  send(message: NotificationMessage): Promise<void>;
}
