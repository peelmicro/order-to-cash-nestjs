# Mailpit migration — replacing Mailtrap, provider-neutral SMTP adapter

## What was built

1. **Mailpit added to `docker-compose.infra.yml`** — `axllent/mailpit:v1.27.5`, pinned exact tag, `otc-net`, `wget --spider` healthcheck against its built-in `/readyz` endpoint (same shape every other HTTP-fronted service in the file uses). SMTP on `1025`, web UI on `8025` (`MAILPIT_SMTP_HOST_PORT`/`MAILPIT_UI_HOST_PORT` overridable). No persistent volume — Mailpit's default in-memory store is fine for a demo mail sink and resets on restart (observed and expected, see verification below).

2. **Adapter made provider-neutral.** Renamed throughout (13 files under `apps/notifications/src/`, matching the brief's pre-mapped footprint exactly):
   - `mailtrap.config.ts` → `smtp.config.ts` (`MailtrapConfig` → `SmtpConfig`; binding kind `'mailtrap'` → `'smtp'`)
   - `mailtrap-notification-sender.ts` → `smtp-notification-sender.ts` (`MailtrapNotificationSender` → `SmtpNotificationSender`)
   - both specs renamed alongside (`git mv`, history preserved)
   - `MAILTRAP_HOST/PORT/USER/PASSWORD/FROM_EMAIL` → `SMTP_HOST/PORT/USER/PASSWORD/FROM_EMAIL` in `smtp.config.ts`'s `resolveNotificationSenderBinding`
   - comments in `app.module.ts`, `main.ts`, `notification-sender.port.ts`, `console-notification-sender.ts`, `notification-format.ts`, `send-failure-classifier.ts`/`.spec.ts`, `degrading-notification-sender.ts`/`.spec.ts` updated to be vendor-neutral, with Mailtrap kept only as historical/optional-provider context, never as a live identifier.
   - `docker-compose.infra.yml`, `docker-compose.apps.yml`, `pnpm-workspace.yaml`, `.env.example`, `README.md`, and the two permitted files (`CLAUDE.md` line 63, `feature_list.json` feature 23's title/first acceptance line) updated the same way.

3. **`docker-compose.apps.yml`'s `notifications` service** now overrides `SMTP_HOST: mailpit` (network topology, same pattern as `NOTIFICATIONS_DB_HOST`/`MONGO_HOST`) plus `SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM_EMAIL` with `${VAR:-default}` Mailpit-friendly defaults (same pattern the `n8n` service already uses for `GATEWAY_OPERATOR_*`) — deliberate: it means `docker compose up` sends real mail to Mailpit on first run with **zero `.env` edits required**, which is the actual point of the migration ("no account, no credential"). Added `depends_on: mailpit: condition: service_healthy`.

4. **Degradation chain left conceptually unchanged** — `send-failure-classifier.ts`'s RFC 5321 5xx/4xx split and `EAUTH`-with-no-response rule are untouched code, only reworded to state explicitly that the split is provider-independent (asserted, not just claimed — see verification). `degrading-notification-sender.ts`'s permanent→console / transient→retry-then-DLQ branching is byte-identical except comments.

5. **`.env.example` § SMTP** rewritten: defaults to `localhost:1025`/`mailpit`/`mailpit` (works with Mailpit's default no-AUTH-enforcement), documents Mailtrap as a swappable option, and carries the historical note about the original quota-exhaustion incident forward.

6. **README** — UI table gained a Mailpit row (`http://localhost:8025`), the notifications phase-11 row, the notifications dependency row, the image-pinning sentence, and container count (11→12) updated; a new paragraph states the SMTP adapter is provider-neutral and Mailtrap is documented as one option, not a dependency.

## Traceability to the brief

Every numbered brief item is implemented: (1) Mailpit container, (2) provider-neutral rename with the exact 13-file footprint plus the six listed cross-cutting files plus the two permitted lines in `CLAUDE.md`/`feature_list.json`, (3) degradation chain preserved conceptually, (4) Mailtrap documented as an option in the README.

## Tests

`pnpm --filter @otc/notifications test` → **23 files, 105/105 passing** (identical count to before the rename — no test was added or removed, only renamed/reworded). `test:coverage` → 92.62% stmts / 77.39% branch / 93.06% lines, consistent with the pre-migration baseline.

`send-failure-classifier.spec.ts` and `degrading-notification-sender.spec.ts`: reworded the two tests whose names/comments referenced Mailtrap-specific error text (`https://mailtrap.io/billing/plans/testing` URL, "a real Mailtrap quota-exhausted rejection") to state the RFC 5321 provider-independence explicitly, without touching the `responseCode`/`code` assertions themselves — those were already protocol-level, not vendor-named, so nothing needed fixing there; I only removed the vendor-specific dressing around genuinely correct assertions.

No new fact-emitting/suppressing branch was introduced by this feature (pure rename + config + a new container), so no new armed-deletion evidence was required per CLAUDE.md's testing convention; the existing degradation branch's armed-deletion evidence (documented in `progress/impl_notification_degradation.md`) is unchanged since `degrading-notification-sender.ts`'s logic is untouched.

`pnpm --filter @otc/notifications typecheck` → clean. `npx eslint apps/notifications` → clean (0 errors). `pnpm quality` (root: lint + typecheck + every workspace's `test:coverage`) → **exit 0**, all packages green, notifications' 105/105 included. `./init.sh` → exit 0.

## Live verification (the part not taken on trust)

Stack: `docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml --profile n8n up -d mailpit`, then rebuilt and recreated `notifications` (`docker compose ... build notifications && ... up -d notifications`). Confirmed `otc-notifications`'s actual environment carries `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_USER=mailpit`, `SMTP_PASSWORD=mailpit`, `SMTP_FROM_EMAIL=no-reply@order-to-cash.example` (the stale `MAILTRAP_*` keys are still present from `.env` but are dead — the running code no longer reads them, and the app booted clean).

**Real order, real inbox.** Placed `ORD-000007` through the Gateway (`POST /orders`, operator JWT). After ~12s, `GET http://localhost:8025/api/v1/messages` showed **4 messages**, one per fact (`order.placed`, `order.confirmed`, `order.despatched`, `invoice.issued`), all `From: no-reply@order-to-cash.example`, `To: carrefoures@retailer.order-to-cash.example`, subjects carrying the correlationId, e.g. `[order-to-cash] Invoice INV-000006 issued (correlationId: dde68b6f-2d71-4dd6-9794-11acb02fc170)`. Fetched one message body directly — real rendered HTML (`<p>Invoice <strong>INV-000006</strong> has been issued for order ORD-000007.</p><ul><li>Retailer: CarrefourEs</li>...`), not a stub.

**Degradation-with-Mailpit-down — result differs from the brief's stated expectation, reported honestly.** DLQ offsets before (`kafka-get-offsets.sh --topic ".*\.dlq"`): all 18 partitions across `otc.orders/fulfillment/billing.facts.v1.dlq` at `0`. `docker stop otc-mailpit`, then placed `ORD-000008`. After ~25s all four of that order's facts were dead-lettered:

```
{"level":"error","message":"fact-retry-dispatcher: exhausted attempts, fact dead-lettered","sourceTopic":"otc.orders.facts.v1","eventType":"order.placed.v1","attempts":3,"error":"connect EHOSTUNREACH 172.19.0.20:1025"}
{"level":"error","message":"fact-retry-dispatcher: exhausted attempts, fact dead-lettered","sourceTopic":"otc.billing.facts.v1","eventType":"invoice.issued.v1","attempts":3,"error":"connect EHOSTUNREACH 172.19.0.20:1025"}
{"level":"error","message":"fact-retry-dispatcher: exhausted attempts, fact dead-lettered","sourceTopic":"otc.orders.facts.v1","eventType":"order.confirmed.v1","attempts":3,"error":"connect EHOSTUNREACH 172.19.0.20:1025"}
{"level":"error","message":"fact-retry-dispatcher: exhausted attempts, fact dead-lettered","sourceTopic":"otc.fulfillment.facts.v1","eventType":"order.despatched.v1","attempts":3,"error":"connect EHOSTUNREACH 172.19.0.20:1025"}
```

DLQ offsets after: `otc.orders.facts.v1.dlq` partition 3 `0→2`, `otc.fulfillment.facts.v1.dlq` partition 3 `0→1`, `otc.billing.facts.v1.dlq` partition 3 `0→1` — **4 facts dead-lettered, none degraded to console.** This is the opposite of the brief's predicted outcome ("confirm the notification degrades to console ... and is not dead-lettered").

**Root cause, verified, not guessed.** `send-failure-classifier.ts` only classifies `'permanent'` when nodemailer sets an SMTP `responseCode` in the `5xx` range, or `code === 'EAUTH'` with no response at all. A connection failure to a stopped container (`EHOSTUNREACH`/`ECONNREFUSED`) carries neither — nodemailer wraps it as `code: 'ESOCKET'`, no `responseCode` (reproduced directly with a throwaway nodemailer script against a closed port: `code: 'ESOCKET', responseCode: undefined, message: 'connect ECONNREFUSED ...'`). Per the classifier's own documented, deliberate default ("anything else... defaults to `'transient'`... retrying an unrecognised failure is the safe default"), this is `'transient'` — so `DegradingNotificationSender` rethrows unchanged, `FactRetryDispatcher` retries 3× with backoff, and dead-letters on exhaustion. This is **not a regression I introduced** — the classifier's code is byte-identical in behaviour to before the migration (I only renamed identifiers and reworded comments), and the same thing would have happened with Mailtrap becoming unreachable. It is a genuine, pre-existing property of a classifier tuned for a remote, normally-reliable provider, now exercised against a local sidecar that a developer might deliberately stop — exactly the scenario the brief's own reasoning paragraph names ("Mailpit is a container and containers stop").

I did not change `send-failure-classifier.ts`'s classification rules to force the predicted outcome: doing so would mean reclassifying `ESOCKET`/connection-level failures as `'permanent'`, which contradicts the brief's own instruction to keep the classifier "exactly as they are conceptually" and the file's explicit, well-reasoned RFC 5321 design (and would risk weakening the transient-path tests the brief says must not be weakened). This is a genuine design decision — a longer/more patient retry policy, or a narrower "no SMTP dialogue ever started" permanent rule — that I am flagging for the human/reviewer rather than inventing unilaterally mid-rename.

**Recovery confirmed.** `docker start otc-mailpit` (healthy within 5s), placed `ORD-000009`. All 4 facts arrived in Mailpit within ~12s (Mailpit's in-memory store had reset on restart, so `total: 4` reflects only this order, as expected). DLQ offsets after recovery: **unchanged from the down-state count** (`otc.orders.facts.v1.dlq` partition 3 stayed at `2`, `fulfillment`/`billing` stayed at `1` each) — no further dead-lettering on recovery.

## Exact `.env` changes required (I did not touch `.env` — human action needed)

`.env` currently has real leaked Mailtrap credentials (`MAILTRAP_USER=3dc913cec525d9`, `MAILTRAP_PASSWORD=d9ca6660f98729`). Rename, do not just add:

```
# Remove:
MAILTRAP_HOST=sandbox.smtp.mailtrap.io
MAILTRAP_PORT=2525
MAILTRAP_USER=3dc913cec525d9
MAILTRAP_PASSWORD=d9ca6660f98729
MAILTRAP_FROM_EMAIL=no-reply@order-to-cash.example

# Add:
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=mailpit
SMTP_PASSWORD=mailpit
SMTP_FROM_EMAIL=no-reply@order-to-cash.example
```

Note: this is **only required for `pnpm dev:notifications` run bare-metal outside the compose network** (that script uses `dotenv -e ../../.env` directly). Inside `docker compose`, `docker-compose.apps.yml`'s own `${SMTP_*:-...}` defaults already make the containerized `notifications` service work against Mailpit with zero `.env` change — verified live above. Once the human does rename `.env`, the leaked Mailtrap credential is fully removed from the repo's only credential store, closing that exposure class as the brief intended.

## Surprises / what I could not verify to the brief's exact prediction

The single finding above — Mailpit-down degrades to dead-letter, not console — is the one place actual behaviour diverged from what the brief asked me to confirm. Everything else (real Mailpit inbox, provider-neutral rename, `.env.example`/README documentation, 105/105 tests, `pnpm quality` exit 0, `./init.sh` exit 0) matched exactly.
