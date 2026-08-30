# Graceful degradation for permanent send failures — notifications

Not a `feature_list.json` entry (operational hardening task); `feature_list.json` and `specs/` untouched, per the brief's own constraint. No `R<n>` applies, so `specs/shared/test-matrix.md` is unchanged.

## Files touched (`apps/notifications/**` only)

- `apps/notifications/src/infrastructure/notification/send-failure-classifier.ts` (new) — pure classifier, `classifySendFailure(error): 'permanent' | 'transient'`.
- `apps/notifications/src/infrastructure/notification/send-failure-classifier.spec.ts` (new) — 10 unit tests.
- `apps/notifications/src/infrastructure/notification/degrading-notification-sender.ts` (new) — the `NotificationSender` decorator that acts on the classification.
- `apps/notifications/src/infrastructure/notification/degrading-notification-sender.spec.ts` (new) — 7 unit tests, three layers (isolation, composed with the real `FactRetryDispatcher`, composed with the real `NotificationDispatchService`).
- `apps/notifications/src/app.module.ts` (edited) — `NOTIFICATION_SENDER` factory wraps `MailtrapNotificationSender` in `DegradingNotificationSender` with `ConsoleNotificationSender` as the fallback, when Mailtrap is bound. Console-only binding is left unwrapped (nothing to degrade from).

`.env`, `feature_list.json`, `specs/`, and every other service were not touched.

## Classification: what signal, and why it is reliable

Read `node_modules/.pnpm/nodemailer@9.0.5/.../lib/smtp-connection/index.js` directly rather than guessing. Two real, documented fields nodemailer sets on every error it raises (`_formatError`):

- `err.responseCode` — the numeric SMTP reply code, parsed from the server's own response whenever one exists (auth rejection, RCPT TO rejection, DATA rejection...). This is RFC 5321 §4.2.1's OWN classification: `5xx` = Permanent Negative Completion, `4xx` = Transient Negative Completion. Mailtrap's real, currently-observed rejection — `Invalid login: 535 5.7.0 The email limit is reached...` — carries `responseCode: 535`, `code: 'EAUTH'`. A wrong-password rejection (`535 5.7.8 Authentication failed`) is *also* `535`. So one numeric-code rule — `responseCode >= 500 && < 600` → `permanent` — catches "quota exhausted" and "invalid credentials" identically, **without reading the message text at all**. A rejected/malformed recipient (RCPT TO) is likewise `5xx` (`550`/`553`).
- `err.code` — nodemailer's own transport-level error name, present when there was no SMTP response to parse at all: `ETIMEDOUT`/`ESOCKET`/`ECONNECTION` for network-level failures. nodemailer's own internal logging (`_onError`, `transientCodes = ['ETIMEDOUT','ESOCKET','ECONNECTION']`) already treats these as transient — the classifier agrees. `EAUTH` with **no** `responseCode` (e.g. "Missing credentials") means authentication was never attempted at all — not something a retry fixes either — so it is also `permanent`.
- Anything else (no `responseCode`, no recognised `code`) defaults to **`transient`** — an unknown failure is safer retried (visible in the DLQ) than silently treated as unrecoverable.

Rule, in order: `responseCode` present → `5xx` = permanent, else transient. No `responseCode` and `code === 'EAUTH'` → permanent. Everything else → transient.

This is grounded entirely in nodemailer's/SMTP's own real fields, never in matching Mailtrap's prose ("The email limit is reached" never appears in the classifier).

## The degraded path

`DegradingNotificationSender.send`: delegates to the real (Mailtrap) sender; on failure, classifies. **Transient** → rethrows the *original* error unchanged — every caller above it (`NotificationDispatchService`'s N6 compensation, `FactRetryDispatcher`'s retry-then-DLQ) behaves exactly as before. **Permanent** → logs one structured line (`event: 'notification.send.degraded'`, the `to`/`subject`/`messageId`, and the underlying `reason` — message, `code`, `responseCode`), then calls the (console) fallback with the same message, and **returns normally** — no throw, so nothing above it retries or dead-letters; the fact is acknowledged exactly as if the send had succeeded.

## Armed-test evidence (verbatim)

**Classifier flipped** (`responseCode >= 500 && < 600 ? 'transient' : 'permanent'`, and `EAUTH → 'transient'`) — 8 tests failed with real messages, e.g.:

```
FAIL  send-failure-classifier.spec.ts > classifySendFailure > R-degrade — a real Mailtrap quota-exhausted rejection (535, EAUTH) classifies as permanent
AssertionError: expected 'transient' to be 'permanent'

FAIL  degrading-notification-sender.spec.ts > ... > a permanent failure resolves normally (does not rethrow), renders to fallback, and logs loudly with the underlying reason
AssertionError: promise rejected "Error: Invalid login: 535 5.7.0 The email…" instead of resolving

FAIL  degrading-notification-sender.spec.ts > ... > a permanent send failure: dispatch resolves (no throw), the idempotency row is NOT compensated/deleted, and the fallback received the message
Error: Invalid login: 535 5.7.0 The email limit is reached...
```

Restored; `vitest run` on both spec files → 17/17 passing again.

**Suppress-branch deleted** (commented out the `if (classifySendFailure(error) === 'transient') { throw error; }` guard — i.e. degrade on *every* failure, the exact "trap" the brief warns about) — 2 tests failed:

```
FAIL  degrading-notification-sender.spec.ts > DegradingNotificationSender — in isolation > rethrows a transient failure UNCHANGED and never calls fallback
AssertionError: promise resolved "undefined" instead of rejecting

FAIL  degrading-notification-sender.spec.ts > DegradingNotificationSender composed with the real FactRetryDispatcher — transient path is UNCHANGED > a transient send failure retries 3x with backoff and dead-letters on exhaustion — same as before this feature
AssertionError: expected "vi.fn()" to be called 3 times, but got 1 times
```

Restored; `vitest run` → 7/7 (and 17/17 combined) passing again.

## Live observation on the running stack

Rebuilt (`docker compose build notifications`) and restarted `otc-notifications` — quota genuinely exhausted, real Mailtrap creds in `.env` unchanged. Published a real, valid `order.placed.v1` envelope directly onto `otc.orders.facts.v1` (kafkajs, `localhost:9092`) to trigger a real SMTP attempt. Container log, verbatim:

```
{"level":"error","message":"notifications: email delivery degraded — permanent send failure, will NOT retry or dead-letter; rendering to console and acknowledging the fact","event":"notification.send.degraded","to":"carrefoures@retailer.order-to-cash.example","subject":"[order-to-cash] Order ORD-LIVE-DEGRADE-01 placed (correlationId: ee75b5b1-7dcb-4685-8390-8240fae529fb)","messageId":"15f09d51-ef75-41ee-b6ff-995f14b277e4@order-to-cash","reason":{"message":"Invalid login: 535 5.7.0 The email limit is reached. Please upgrade your plan https://mailtrap.io/billing/plans/testing","code":"EAUTH","responseCode":535}}
{"level":"info","message":"notifications: console adapter — would have sent an email","to":"carrefoures@retailer.order-to-cash.example","subject":"[order-to-cash] Order ORD-LIVE-DEGRADE-01 placed (correlationId: ee75b5b1-7dcb-4685-8390-8240fae529fb)"}
```

No `fact-retry-dispatcher: exhausted attempts, fact dead-lettered` line for this eventId, no 3x-retry delay — a single attempt, immediately degraded and acknowledged. Container stayed `healthy` throughout (`docker ps`). Before this fix, the SAME live quota exhaustion produced the observed baseline (also captured live, from `otc-notifications`'s prior logs, before rebuild): 15+ `fact-retry-dispatcher: exhausted attempts, fact dead-lettered` lines, one per fact, 3 attempts each.

## Metrics — proposed, not implemented

`otc_notifications_degraded_total` (a counter, incremented once per degrade) would be the natural Prometheus panel. Not implemented: `apps/notifications` currently has **no metrics/OTel pipeline at all** (unlike `apps/orders`/`apps/gateway`, which already carry `infrastructure/observability/metrics.ts` + an OTel `MeterProvider`) — standing one up from scratch (SDK, exporter wiring in `main.ts`, a new port) is not "genuinely cheap" for one counter, and is out of this task's `apps/notifications/**`-only, single-purpose scope. The structured log carries a stable `event: 'notification.send.degraded'` field specifically so a log-based metric (Loki/Promtail count, or a simple `grep`-based alert) can be wired without touching this code.

## Verification

- `vitest run` (classifier + wrapper specs, isolated): 17/17 passing.
- `apps/notifications` full unit suite (`pnpm --filter @otc/notifications run test`): 23 files, 105 tests passing (was 88 before this feature's 17 new tests).
- `apps/notifications` integration suite (`pnpm --filter @otc/notifications run test:integration`, real Testcontainers Kafka + MySQL): 3 files, 5 tests, exit 0 — includes `notification-dead-letter.integration.spec.ts`, proving the malformed-envelope retry-then-DLQ path is genuinely unmodified end-to-end.
- `pnpm --filter @otc/notifications run typecheck`: clean.
- `pnpm --filter @otc/notifications exec eslint ...` on every touched/new file: clean, no output.
- `pnpm quality`, run twice:
  - Run 1: **exit 1**
  - Run 2: **exit 1**
  - Both failures are the SAME pre-existing `apps/web` flake (`Hook timed out in 10000ms` inside `@nuxt/test-utils`' `setupNuxt()`, in `app/lib/problem.spec.ts`, `app/pages/login.spec.ts`, `app/pages/orders/place.hydration.spec.ts`) — unrelated to `apps/notifications`. In both runs, `apps/notifications typecheck: Done` and `apps/notifications test:coverage: Test Files 23 passed (23) / Tests 105 passed (105)`, coverage 92.62% statements / 77.39% branches (above the 80%/60% gates).
- `./init.sh`: not re-run (no infra/schema change; the 19-container stack was rebuilt/restarted for `notifications` only and left healthy, verified via `docker ps`).

## What was not done, and why

- No `specs/`/`feature_list.json`/test-matrix change — the brief explicitly scopes this to `apps/notifications/**` and this task carries no `R<n>`.
- Metrics counter — proposed above, not implemented (see "Metrics" section).
- Did not touch `.env` or attempt to "fix" the Mailtrap quota — per the brief, that decision is the human's.

## Surprises

- SMTP's own `5xx`/`4xx` split (RFC 5321 §4.2.1) turned out to be the exact signal the brief asked for — it classifies "quota exhausted" and "invalid credentials" identically and correctly (both `535`) without ever inspecting Mailtrap's message text, which the brief specifically warned would change.
- The live stack still had the OLD image running the pre-fix behaviour when I started; capturing its baseline DLQ storm (`docker logs otc-notifications`, 15+ dead-lettered facts, all `535`) before rebuilding gave a genuine before/after comparison, not just a simulated one.
