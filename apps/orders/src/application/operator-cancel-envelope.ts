// SA-4 (`specs/shared/saga.md` §4.3, "A credit approval that arrives after
// the cancellation") — the ONE content test for "this `saga_commands` row
// was enqueued by an operator cancellation", written once and shared by the
// only two places that may ask the question:
//
//   - `cancel-order.handler.ts`, which BUILDS the synthetic envelope
//     (`buildTriggeringEnvelope`), and
//   - `drizzle-saga-command-store.ts`, which READS it back
//     (`hasAcceptedOperatorCancel`).
//
// Kept in one module deliberately: two independently-maintained copies of
// the same literal is exactly how the writer and the reader drift apart,
// and nothing downstream would notice — the reader would simply answer
// "no operator cancel was ever accepted" for every order.
//
// CONTENT, never position and never the command name, is what decides.
// `credit.release` and `stock.release` rows are BOTH enqueued by the
// fact-driven flow too (R27's automatic `credit_rejected` compensation
// enqueues `stock.release`, and `stock.released.v1`'s own
// `credit_approved`/`confirmed` variant enqueues `credit.release`), and
// those rows carry a REAL fact's envelope. Only the operator-cancel path
// writes an envelope whose `eventType` is this synthetic value — which is
// deliberately NOT one of the fourteen real wire fact types (asyncapi.yaml).
import type { Envelope } from '@otc/contracts';

/** The synthetic `eventType` `CancelOrderHandler.buildTriggeringEnvelope` stamps on the row it enqueues — the single source of truth for both the writer and the reader. */
export const OPERATOR_CANCEL_EVENT_TYPE = 'orders.cancel.requested';

/** `true` only for the synthetic operator-cancel envelope — a real fact's envelope (any of the fourteen wire fact types), a malformed row, or a missing envelope all answer `false`. */
export function isOperatorCancelEnvelope(envelope: Envelope | null | undefined): boolean {
  return typeof envelope === 'object' && envelope !== null && envelope.eventType === OPERATOR_CANCEL_EVENT_TYPE;
}
