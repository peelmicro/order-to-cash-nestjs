// The notification-sender port (feature 23's seam) — mirrors the
// port-plus-two-adapters shape
// apps/billing/src/application/ports/credit-decision.port.ts establishes:
// ONE interface, swappable by a single provider binding in app.module.ts.
// `ConsoleNotificationSender` (infrastructure/notification/
// console-notification-sender.ts) is bound in every automated test and by
// default; `MailtrapNotificationSender` (same folder) is bound only when
// mailtrap.config.ts finds a valid-looking, complete SMTP credential pair.
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
   * seven sends individually attributable in the Mailtrap inbox, and any
   * duplicate visible to a human at a glance, but it prevents nothing by
   * itself — SMTP has no dedup and Mailtrap's sandbox does not enforce
   * uniqueness on this header.
   */
  readonly messageId?: string;
}

export interface NotificationSender {
  send(message: NotificationMessage): Promise<void>;
}
