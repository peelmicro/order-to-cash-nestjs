// Classifies a `NotificationSender.send` failure as either `'permanent'`
// (retrying cannot succeed — degrade to console and acknowledge the fact,
// see `degrading-notification-sender.ts`) or `'transient'` (retry exactly
// as today via `FactRetryDispatcher`, dead-letter on exhaustion).
//
// Grounded in nodemailer's OWN error shape, not vendor prose (the incident
// brief's own instruction — an SMTP server's own error message, e.g. "The
// email limit is reached" or "Authentication failed", is free to change
// wording at any time and is provider-specific; the numeric SMTP reply
// code is not). Two real, documented fields nodemailer's SMTP transport
// sets on every error it raises
// (`node_modules/nodemailer/lib/smtp-connection/index.js`,
// `_formatError`/`_onError`):
//
//   - `err.responseCode` — the numeric SMTP reply code, parsed straight
//     from the server's own response line, whenever the server sent one
//     at all (auth rejections, RCPT TO rejections, DATA rejections...).
//     This is RFC 5321 §4.2.1's OWN classification, not ours, and it is
//     PROVIDER-INDEPENDENT — the 5xx/4xx split does not change because
//     the SMTP host does (Mailpit, Mailtrap, or any other RFC 5321
//     server all agree on this): a `5yz` reply is a "Permanent Negative
//     Completion" — the server has definitively refused the request —
//     and a `4yz` reply is a "Transient Negative Completion" — an
//     explicit "try again later" from the server. A quota-exhausted
//     rejection ("535 5.7.0 The email limit is reached...") and a
//     wrong-password rejection ("535 5.7.8 Authentication failed") are
//     BOTH `535` — both `5xx` — so this one numeric-code rule catches
//     "quota exhausted" and "invalid credentials" identically, without
//     ever reading the message text. A malformed/rejected recipient
//     (RCPT TO) is similarly `5xx` (typically `550`/`553`).
//   - `err.code` — nodemailer's OWN transport-level error name, set when
//     there was no SMTP response to parse a code from at all (a socket
//     failure, a DNS failure, a connection timeout, or an auth attempt
//     that never reached the wire because no credentials were supplied).
//     nodemailer classifies `ETIMEDOUT`/`ESOCKET`/`ECONNECTION` as
//     transient FOR ITS OWN internal logging (see the same file's
//     `_onError`, `transientCodes`) — this classifier agrees. `EAUTH`
//     WITHOUT a `responseCode` means authentication could not even be
//     attempted (e.g. missing credentials) — not something a retry fixes
//     either, so it is treated as permanent on the same reasoning as a
//     535 rejection.
//
// Anything else — no `responseCode`, no recognised `code` — defaults to
// `'transient'`. Retrying an unrecognised failure is the safe default:
// dead-lettering is visible (a row in a DLQ topic, alertable), silently
// swallowing an unknown failure as "permanent" is not.
export type SendFailureClassification = 'permanent' | 'transient';

interface NodemailerLikeError {
  readonly responseCode?: unknown;
  readonly code?: unknown;
}

function asNodemailerLikeError(error: unknown): NodemailerLikeError {
  return typeof error === 'object' && error !== null ? (error as NodemailerLikeError) : {};
}

export function classifySendFailure(error: unknown): SendFailureClassification {
  const { responseCode, code } = asNodemailerLikeError(error);

  if (typeof responseCode === 'number' && Number.isFinite(responseCode)) {
    // RFC 5321 §4.2.1 — 5xx is a Permanent Negative Completion reply,
    // 4xx (and anything else numeric a server might send) is transient.
    return responseCode >= 500 && responseCode < 600 ? 'permanent' : 'transient';
  }

  if (code === 'EAUTH') {
    return 'permanent';
  }

  return 'transient';
}
