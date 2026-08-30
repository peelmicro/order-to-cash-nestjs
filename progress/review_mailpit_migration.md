# Review — Mailtrap → Mailpit migration

**Verdict: APPROVED**, with two documentation defects (D1, D2) that the leader can sweep itself before the commit — neither is behavioural, neither warrants a round-trip to the implementer.

Reviewed against `progress/impl_mailpit_migration.md` and the degradation design it builds on (`progress/impl_notification_degradation.md`). This is not a `feature_list.json` feature — it is an operational migration touching feature 23's adapter — so no feature status changes and `feature_list.json` was not edited by this review.

## Scope of what I actually verified vs. re-ran

I did not take the implementer's transcript for anything load-bearing. Independently executed:

- placed my **own** order (`ORD-000010`) through the real Gateway and read Mailpit's API myself;
- ran my **own** `nodemailer` probe against a closed port and a blackhole IP to establish the error shape the ESOCKET ruling rests on;
- armed **three** mutation probes on the classifier and the degradation guard, and restored byte-exactly (md5 confirmed);
- diffed **every** test title in `apps/notifications` at `HEAD` against the working tree, and diffed the renamed spec files against their pre-rename originals;
- read the DLQ records off the broker and identified which order they belong to;
- re-ran `pnpm quality` in full, because that specific claim (exit 0) contradicted the previous session's known `apps/web` flake and was therefore worth the cost;
- ran `./init.sh`.

I did **not** re-run the `apps/notifications` Testcontainers integration suite. The migration changes no consumer, no persistence and no messaging code (proved below: every non-renamed source change is comment-only), so that suite's claims are not under test here. Everything else in the report I checked directly.

## 1. A real email genuinely arrives — CONFIRMED, on my own order

I logged in as the operator, placed a fresh order through `POST /orders` on the Gateway, and got `ORD-000010`, `X-Correlation-Id: 5374ca73-ba5d-4067-9283-2854052f9611`.

Mailpit's API (`http://localhost:8025/api/v1/search?query=ORD-000010`) returned **4 messages within 1 second of polling**, one per fact, correlationId in every subject and identical to the HTTP response header:

- `[order-to-cash] Order ORD-000010 placed (correlationId: 5374ca73-…)`
- `[order-to-cash] Order ORD-000010 confirmed (correlationId: 5374ca73-…)`
- `[order-to-cash] Order ORD-000010 despatched (DES-000009) (correlationId: 5374ca73-…)`
- `[order-to-cash] Invoice INV-000009 issued (correlationId: 5374ca73-…)`

All four carry `From: no-reply@order-to-cash.example`, `To: carrefoures@retailer.order-to-cash.example`. I fetched the `order.placed` message body in full — real rendered HTML **and** a real text alternative, not a stub:

```
<p>Order <strong>ORD-000010</strong> has been placed.</p>
<ul><li>Retailer: CarrefourEs</li><li>Company: IBERFOODS</li><li>Total: 749.97 EUR</li>…
```

Money renders as `749.97 EUR` from an `initialAmount` of `74997` — minor units preserved to the presentation boundary, per `CLAUDE.md`.

The claim the whole migration rests on holds, verified on an order the implementer never placed.

## 2. No test was weakened by the rename — CONFIRMED

**Title-level census.** 93 `it()` titles at `HEAD`, 93 now. The diff is **8 titles, all 1:1 renames**, no deletion, no addition:

- 5 in `smtp.config.spec.ts` — `MAILTRAP_USER/PASSWORD/HOST/PORT` → `SMTP_*`, `binds Mailtrap` → `binds SMTP`;
- 1 in `send-failure-classifier.spec.ts` — `a real Mailtrap quota-exhausted rejection` → `an SMTP quota-exhausted rejection`.

(93 titles vs 105 tests is table-driven cases, unchanged in both trees.)

**Assertion-level.** Diffing the renamed specs against their pre-rename originals shows only identifier and fixture-host substitutions. In `send-failure-classifier.spec.ts` the only content change is deleting `https://mailtrap.io/billing/plans/testing` from an error *message string* that nothing asserts on — every assertion is still `expect(classifySendFailure(error)).toBe(…)` against `{ code, responseCode }`. Same in `degrading-notification-sender.spec.ts`. The protocol assertions are untouched: `535`+`EAUTH` → permanent, `550`+`EENVELOPE` → permanent (any 5xx, regardless of code), `450` → transient, `ESOCKET`/`ETIMEDOUT`/`ECONNECTION` → transient, unknown → transient.

**Non-vacuity, proved by mutation rather than by reading.** Three probes, each armed and restored:

| Probe | Mutation | Result |
|---|---|---|
| A | classifier default `'transient'` → `'permanent'` (the exact ESOCKET path) | **7 failed** — the 3 connection-code tests, the 2 unknown-error defaults, plus both composed degradation tests: `rethrows a transient failure UNCHANGED…` (`promise resolved "undefined" instead of rejecting`) and `…retries 3x with backoff and dead-letters on exhaustion` (`expected "vi.fn()" to be called 3 times, but got 1 times`) |
| B | RFC 5321 split inverted (`5xx ? 'transient' : 'permanent'`) | **7 failed**, incl. `promise rejected "Error: Invalid login: 535 5.7.0 The email…" instead of resolving` |
| C | the `if (classifySendFailure(error) === 'transient') { throw error; }` guard commented out | **2 failed** — the two transient-path contract tests |

Probe A is the one that matters for this review: it proves the ESOCKET-is-transient tests are not decorative. If anyone "fixes" the classifier to match the brief's prediction, the suite goes red in two places, including the load-bearing composed retry-then-DLQ guard. Restored files: md5 `5c1fd1dc…` and `d9f2a60c…`, identical to pre-probe.

`105/105` passing, `23` files. Coverage `92.62%` stmts / `77.39%` branch / `93.06%` lines — above the `80%` domain / `60%` overall gates. `typecheck` clean, `eslint apps/notifications` exit 0. **`pnpm quality` → exit 0, zero failures** (the `apps/web` `setupNuxt()` hook flake recorded in `impl_notification_degradation.md` did not recur). `./init.sh` → exit 0.

**Source-side non-regression.** Filtering the diff of `main.ts`, `notification-format.ts`, `console-notification-sender.ts`, `notification-sender.port.ts` and `degrading-notification-sender.ts` down to non-comment lines returns **nothing at all** — those five files changed in comments only. `smtp.config.ts` and `smtp-notification-sender.ts` are pure `MAILTRAP_*`→`SMTP_*` / `Mailtrap*`→`Smtp*` substitutions with the binding kind `'mailtrap'`→`'smtp'`; every guard (partial-pair refusal, missing host/from/port, non-integer port) survives verbatim. The classifier is byte-identical in behaviour. This migration changes zero runtime logic outside configuration.

## 3. The rename is complete and consistent — CONFIRMED, one miss (D1)

`MAILTRAP_*` survives as a **live identifier nowhere**: a repo-wide grep for `MAILTRAP_` outside `progress/` returns zero non-comment hits, and no code path reads those variables.

Every remaining `Mailtrap` mention is deliberate prose — the rationale header in `docker-compose.infra.yml`, the historical incident note and the swappable-provider instructions in `.env.example`, the "one option among many" paragraph in `README.md`, and provider-independence illustrations in `send-failure-classifier.ts`/`smtp.config.ts`/`smtp-notification-sender.ts`. That is exactly the "documented as an option, not a dependency" outcome the brief asked for. `specs/` contains no Mailtrap reference at all, so `specs/shared/` stays stack-agnostic for #8 and #9.

**The two permitted files were touched for Mailtrap text only, and nothing else:**

- `CLAUDE.md` — **exactly one line** changed (line 63): `Mailtrap adapter` → `SMTP adapter (Mailpit locally)` in the Clean Architecture `infrastructure/` listing. No convention, rule or gate was altered.
- `feature_list.json` — **exactly two lines**: feature 23's `title` and its first acceptance line. **Feature 23's `status` is still `"done"`.** No other feature, field or ordering changed. Backlog census: 39 `done`, 2 `pending`, **0 `in_progress`**, all statuses valid, ids unique.

**D1 (defect, documentation).** `http/services.http:31` still reads `### Notifications — Mailtrap/console notification port (feature 23).` This is a live, developer-facing file outside `progress/`, and it is a stale *label* for the adapter — not "Mailtrap documented as an option", which is what the other survivors are. It now contradicts `feature_list.json`, which this same change updated to "SMTP (Mailpit)". One line, no behaviour. `http/` is outside `apps/`/`packages/`, so the leader may fix it directly.

## 4. The containerised path genuinely needs no `.env` edit — CONFIRMED

Two paths, both verified:

- **Current repo state** (`.env` has `MAILTRAP_*`, no `SMTP_*`): `docker inspect otc-notifications` shows `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_USER=mailpit`, `SMTP_PASSWORD=mailpit`, `SMTP_FROM_EMAIL=no-reply@order-to-cash.example` — supplied entirely by `docker-compose.apps.yml`'s `${SMTP_*:-default}` fallbacks. And it demonstrably works: my `ORD-000010` delivered four emails through it.
- **Fresh clone** (`cp .env.example .env`): I rendered the merged config with `docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml --env-file .env.example config notifications` and got the same five values. `.env.example` §SMTP now ships real, working defaults (`localhost`/`1025`/`mailpit`/`mailpit`), **not** `replace_me` placeholders — which matters, because `replace_me` would have flipped `resolveNotificationSenderBinding` to the console adapter and silently produced no mail on a fresh clone. It does not.

The `SMTP_HOST: mailpit` override follows the file's own established `NOTIFICATIONS_DB_HOST`/`KAFKA_BROKERS` "outside vs inside compose" pattern, and `depends_on: mailpit: service_healthy` is correct — `mailpit` is a default-profile service in `docker-compose.infra.yml`, and every `dc:up:apps*` script passes both compose files.

The `.env` edit is genuinely needed only for bare-metal `pnpm dev:notifications` (which uses `dotenv -e ../../.env`), exactly as the report states. **I did not touch `.env`** — its mtime is unchanged at `15:35:36`, before this review began.

## 5. Mailpit's service definition — CONFIRMED, one convention gap (D2)

- **Exact pinned tag**: `axllent/mailpit:v1.27.5`. Consistent with every other image in the file, and added to `README.md`'s pinning sentence.
- **Healthcheck in the file's existing style**: `["CMD", "wget", "--spider", "-q", "http://localhost:8025/readyz"]` — byte-for-byte the shape used by `kafka-console`, `kafka-exporter`, `nats`, `jaeger`, `prometheus`, `grafana` and `n8n`. Interval/timeout/retries/start_period match the file's norms. `otc-mailpit` is `healthy`.
- **On `otc-net`**: confirmed via `docker inspect`.
- **README UI table**: `| Mailpit (notification emails) | http://localhost:8025 |` present. The container count `11 → 12` is arithmetically right — default-profile services went `11 → 12` including the `kafka-init` one-shot, and `dc:up:infra` adds `n8n`.
- **No persistent volume**: correct for a demo mail sink; `MP_MAX_MESSAGES` caps it at 500.

**D2 (defect, convention).** `docker-compose.infra.yml` introduces three new knobs — `MAILPIT_SMTP_HOST_PORT`, `MAILPIT_UI_HOST_PORT`, `MAILPIT_MAX_MESSAGES` — and **none is documented in `.env.example`**. Every other host-published port in this repo is: `MYSQL_HOST_PORT`, `MONGO_HOST_PORT`, `KAFKA_HOST_PORT`, `REDPANDA_CONSOLE_HOST_PORT`, `NATS_CLIENT_HOST_PORT`, `NATS_MONITOR_HOST_PORT`, `OTEL_COLLECTOR_*_HOST_PORT`, `JAEGER_UI_HOST_PORT`, `PROMETHEUS_HOST_PORT`, `GRAFANA_HOST_PORT`, `N8N_HOST_PORT`, `SONARQUBE_HOST_PORT`. An undocumented knob is documentation debt, and `8025`/`1025` are common ports for a developer to already have bound. Defaults work, so nothing is broken. `.env.example` is outside `apps/`/`packages/` — the leader may fix it directly.

## 6. Recovery — CONFIRMED independently

Broker-side DLQ offsets right now:

```
otc.orders.facts.v1.dlq:3:2    otc.fulfillment.facts.v1.dlq:3:1    otc.billing.facts.v1.dlq:3:1
```

All other 15 partitions at `0`. Total **4** — exactly the implementer's reported down-state count, and **unchanged by my own `ORD-000010`**, which added zero dead letters while delivering four emails. Recovery is real, not asserted.

I consumed the orders DLQ to confirm what is in it: `order.placed.v1` and `order.confirmed.v1`, both `correlationId 4cedecfc-…`, both `payload.orderReference = ORD-000008` — the Mailpit-down test order, envelope intact and readable. Dead letters here are genuinely replayable in principle. See the caveat under the ruling below.

---

# The ESOCKET / transient ruling

## The technical fact, established independently

I did not take this on the report's word. I ran my own `nodemailer` probe from the `apps/notifications` workspace against the installed version:

```
closed-port    {"code":"ESOCKET","errno":-111,"syscall":"connect","message":"connect ECONNREFUSED 127.0.0.1:1099"}
blackhole-ip   {"code":"ETIMEDOUT","message":"Connection timeout"}
```

`responseCode` is **absent** in both. Both codes are in nodemailer's own `transientCodes` list. So `classifySendFailure` returns `'transient'` by its own documented default, `DegradingNotificationSender` rethrows unchanged, `FactRetryDispatcher` retries and dead-letters. The implementer's account is accurate in every particular, and the behaviour is byte-identical to pre-migration — this would have happened with Mailtrap unreachable too.

## Ruling: the code is right, the prediction was wrong. Do not change the classifier.

I agree with the human's own instinct and with the implementer's refusal to force the predicted result. Three reasons, in order of weight.

**1. A connection failure carries no evidence of permanence, and the classifier's only job is to answer "can a retry possibly succeed?"** For `ECONNREFUSED` the answer is *yes* — and it demonstrably was yes, twice: `docker start otc-mailpit` and both `ORD-000009` and my `ORD-000010` delivered cleanly. The 5xx/EAUTH rule is narrow precisely because those are the only cases where a *server* has explicitly told us it refuses. Nothing told us that here; we never got to speak to a server at all.

**2. Reclassifying it permanent is not "degrading", it is silent, irreversible mail loss.** The permanent branch does not merely log — it calls the console fallback and **returns normally**, so the fact is acknowledged and the idempotency row committed. There is no second chance: the email is gone forever and the ledger says it was handled. Making every network blip take that branch means the system quietly console-logs its way through a real outage while reporting success — the exact failure `impl_notification_degradation.md` says the design exists to prevent. Dead-lettering, by contrast, is loud, bounded and keeps the original envelope.

**3. It would gut the tests the brief forbade weakening.** Mutation probe A is the proof: flipping the default to permanent fails not only the three connection-code unit tests but both *composed* contract tests, including `a transient send failure retries 3x with backoff and dead-letters on exhaustion — same as before this feature`. That test is the written guarantee that the degradation feature did not disturb the pre-existing transient path. You cannot make the brief's prediction come true without deleting that guarantee.

## Is there a gap now the provider is local? Yes — but it is in the retry budget, not the classifier

The human's intuition is right that a stopped container and a remote SaaS blip differ. But they differ in **expected outage duration**, not in **permanence**. The classifier answers permanence. Duration is answered by the retry policy — and that is where the actual gap sits, currently unmeasured:

`DEFAULT_FACT_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 500 }` (`fact-retry-dispatcher.ts`, per `OR1`). Three attempts with 500 ms doubling is roughly **1.5 seconds** of total tolerance. Every real SMTP restart — local container or remote provider — exceeds that. So the system's operational definition of "transient" is "recovers inside 1.5 seconds", which almost nothing does.

That gap is **pre-existing and provider-independent**. Mailpit did not create it; Mailpit made it observable, because a container you can `docker stop` is the first SMTP outage anyone in this repo could actually stage. Moving container-stop into the "permanent" bucket would be fixing a duration problem by changing semantics — and would take the loss-shaped branch to do it.

## Recommendation (not implemented — this is the human's call)

**Primary: leave it. Dead-lettering is the honest, recoverable outcome, and it should stay.** I verified this is not a slogan: the DLQ holds the **unmodified original envelope** with `DeadLetterHeaders` (`x-original-topic`, `x-attempts`, `x-error`, `x-first-failed-at`, `x-failed-at`, trace context) per `OR1`; I read `ORD-000008`'s facts back off the broker with payloads intact; the original message is acknowledged so no partition blocks; and DLQ depth is already a panel on the provisioned Grafana dashboard, so the outage is visible without anyone reading logs. That is a strictly better outcome than a console line nobody can replay.

**Against the circuit-breaker option, specifically.** A breaker that degrades to console after N consecutive connection failures makes things *worse*, not better: it converts recoverable, replayable dead letters into unrecoverable console lines, and it does so precisely during the longest outages — the ones where the most mail is at stake and the loss is largest. It also drags cross-message state into a decorator that is currently a pure per-message function, which is what makes it cheap to test. I would not build it.

**If the human wants to close the duration gap, the right lever already exists and needs no new code.** `FACT_RETRY_MAX_ATTEMPTS` and `FACT_RETRY_BACKOFF_MS` are env-tunable by design (`OR1`). Raising notifications' budget to, say, 6 attempts / 1000 ms base gives roughly 31 seconds of tolerance — enough to ride out a container restart — with zero change to classification and zero test churn. **The honest caveat that makes this a real decision rather than a free win:** this is an *in-line* retry inside the Kafka consumer, so a longer budget holds the partition for that duration and eats into `max.poll.interval.ms`. Tens of seconds is the defensible ceiling; minutes is not. That trade — partition head-of-line blocking against outage tolerance — is the actual question, and it is a tuning question, not a classification one.

**The one thing genuinely missing is the replay path.** "Dead letters are replayable" is true of the data and false of the tooling: there is no `pnpm dlq:replay`, no script under `scripts/`, and no documented procedure anywhere in the repo. If the human wants exactly one improvement out of this finding, that is the highest-value one — it is what makes "dead-lettering is the honest outcome" true in operation rather than only on paper. It is also generic (any consumer's DLQ, not just notifications) and ports cleanly to #8 and #9.

**Worth recording in `.env.example` regardless of the decision:** a one-line note next to the SMTP block that an SMTP outage longer than the `FACT_RETRY_*` budget dead-letters rather than degrading to console, and that this is deliberate. The current comments state the degradation design but leave a reader to infer this case — which is exactly why the brief predicted the wrong outcome.

---

# CHECKPOINTS walk

## C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (6 definitions).
- [x] Every agent definition declares its model or documents deliberate inheritance — `init.sh` confirms all 6.
- [x] `./init.sh` exits 0.

## C2 — State is coherent
- [x] At most one feature `in_progress` — zero.
- [x] Every status in `rules.valid_status`.
- [x] Every `done` feature has passing tests — feature 23's suite is 105/105 green after the rename.
- [ ] `progress/current.md` describes the active session — **it does not.** It still describes `web_app` (id 29) as `in_progress` with "30/41 features done", while `feature_list.json` has zero in_progress and 39/41 done. **Pre-existing, not introduced by this migration** (D4 below).
- [x] Every `blocked` feature records why — none blocked.

## C3 — Architecture is respected
- [x] No framework import inside any `domain/` folder — `eslint apps/notifications` exit 0 with the `no-restricted-imports` rule in force; this change touches no `domain/` file.
- [x] No cross-service database access — unchanged; Mailpit is a sidecar, not a datastore.
- [x] No shared runtime code beyond `shared-kernel` and `contracts` — unchanged.
- [x] `packages/shared-kernel` still dependency-free — untouched.
- [x] Every interaction classifiable as Kafka-fact or NATS-RPC — unchanged. SMTP is an outbound infrastructure adapter behind `NotificationSender`, not an inter-service interaction; nothing new crosses a service boundary.
- [x] No stray debug logging, no context-free TODOs — the added comments are all substantive rationale.

## C4 — Verification is real
- [x] `pnpm quality` passes — **re-run in full by this review: exit 0**, no failures.
- [x] Domain tests pure — the classifier spec imports only `vitest` and the unit under test; `smtp-notification-sender.spec.ts` opens no socket (injected fake transporter factory).
- [x] Integration tests use Testcontainers — unchanged by this migration; not re-run, and not a claim under test here.
- [x] Coverage thresholds met — notifications 92.62% stmts / 77.39% branch, above the 80%/60% gates; all packages green in the full run.
- [x] No Jest anywhere — Vitest 4.1.11 only.

## C5 — The session closed cleanly
- [x] No suspicious untracked files — one untracked file, `progress/impl_mailpit_migration.md`, which is the expected artefact. My own probe script was written outside the repo and the one file copied in was removed; `git status` is identical to the pre-review snapshot.
- [n/a] `progress/history.md` entry with effort record — **not applicable**: no `feature_list.json` feature closes here, matching the precedent set by `impl_notification_degradation.md`. Effort record for this work is below, for the leader to fold into history if it wants one.
- [x] `feature_list.json` reflects true state — feature 23 remains `done`, title/acceptance now describe what actually ships.
- [ ] The human has been told what was done and how to test it manually — **the leader's step, not done yet.** The manual test is: `pnpm dc:up:apps`, place an order via `http/gateway.http` §3, open `http://localhost:8025`, expect four emails.
- [x] Claude did not commit — no `git commit`, no `git push`, working tree byte-identical to how I found it.

## C6 — Spec-Driven Development
- [n/a] This is not an `sdd: true` feature and mints no `R<n>`. `specs/` is untouched — correctly, since no shared requirement changes. Feature 23 is `sdd: false`.

## C7 — Trilogy reusability
- [x] `specs/shared/` contains no Mailtrap, Mailpit or SMTP-vendor specifics — grep confirms zero hits anywhere under `specs/`. #8 and #9 start from it unchanged.
- [x] `n8n/workflows/*.json` reference only the Gateway REST API — untouched by this change.
- [x] `progress/history.md` effort records complete and honest — unchanged; see the C5 note on why no entry is added.

# Requirement traceability

This migration mints no requirement. It preserves the two it inherits, both re-verified by mutation rather than by reading:

| Requirement | Test | Verified how |
|---|---|---|
| `OR1` (retry-then-DLQ, 3 attempts / 500 ms doubling, unmodified envelope to `<topic>.dlq`, then ack) | `degrading-notification-sender.spec.ts` › *a transient send failure retries 3x with backoff and dead-letters on exhaustion — same as before this feature* | Mutation probes A and C both kill it (`expected "vi.fn()" to be called 3 times, but got 1 times`). Confirmed live on the broker: `ORD-000008`'s facts sit in three DLQ topics with intact payloads. |
| Degradation rule (permanent → console + ack; transient → rethrow unchanged) | `send-failure-classifier.spec.ts` (10 cases) + `degrading-notification-sender.spec.ts` (7 cases, three composition layers) | Mutation probe B (invert the 5xx/4xx split) fails 7; probe A (flip the default) fails 7; probe C (delete the transient guard) fails 2. All restored, md5-verified. |
| Feature 23 acceptance — *"real email verified in the Mailpit inbox for each notified fact"* | Live, not a unit test | My own `ORD-000010`: 4 facts → 4 rendered emails in Mailpit, correct `From`/`To`, correlationId in every subject matching the response header. |

# Defects

| # | Severity | Where | Why it matters |
|---|---|---|---|
| **D1** | Minor, docs | `http/services.http:31` — `### Notifications — Mailtrap/console notification port (feature 23).` | The single stale *label* left outside `progress/`. Every other surviving mention is deliberate "Mailtrap is one option" prose; this one names the adapter after a provider the repo no longer uses, and now contradicts `feature_list.json`, which this same change updated. One line. `http/` is leader-editable. |
| **D2** | Minor, convention | `.env.example` — `MAILPIT_SMTP_HOST_PORT`, `MAILPIT_UI_HOST_PORT`, `MAILPIT_MAX_MESSAGES` are read by `docker-compose.infra.yml` but documented nowhere | Every other host-published port knob in this repo has a documented entry (12 of them). `8025` and `1025` are commonly already bound on a developer machine, and the remap knob exists but is invisible. Defaults work, so nothing is broken. `.env.example` is leader-editable. |
| **D3** | Blocking for the *security* goal, correctly out of scope for the implementer | `.env` still holds `MAILTRAP_USER=3dc913cec525d9` / `MAILTRAP_PASSWORD=d9ca6660f98729`, and `env_file: [.env]` still injects both into `otc-notifications` — I confirmed via `docker inspect` | The code no longer reads them, so this is inert. But the migration's stated purpose includes removing a leaked secret, and that is **not achieved until the human edits `.env`**. The implementer was right not to touch it and documented the exact rename. Flagging so it is not forgotten at commit time — the migration is not "done" in the sense the brief meant until this happens. |
| **D4** | Pre-existing, not this change | `progress/current.md` describes `web_app` as the active `in_progress` feature; `feature_list.json` has none and shows 39/41 done | C2 coherence. Noted, not attributed to this work. |
| **D5** | Pre-existing, context | There is no `progress/review_notification_degradation.md` | The degradation design this migration builds on was never independently reviewed. Its logic is untouched here and I mutation-probed it anyway, so it is now covered in substance — but the gap is worth recording. |

# What I recommend before the commit

1. Fix **D1** and **D2** — two text edits, both in leader-editable files, no implementer round-trip needed.
2. Do **D3** (the `.env` rename) as the human action the migration is waiting on. Until then the secret the migration set out to remove is still on disk and still in the container's environment.
3. Take the ESOCKET decision above, and — whichever way it goes — record it in `.env.example` next to the SMTP block, because the brief's wrong prediction is direct evidence that the current behaviour is not discoverable from the comments.

# Effort record for this review

**1 review pass (APPROVED).** Wall-clock ≈ **17:52 → 18:2x, ≈35 min** (local CEST, 2026-08-30), spent on: one real order placed through the Gateway and its four emails read out of Mailpit's API including a full body fetch; an independent `nodemailer` error-shape probe against a closed port and a blackhole IP; three armed mutations with byte-exact md5-verified restores; a `git archive` of `HEAD` to diff all 93 test titles and both renamed spec files against their originals; a `docker compose config` render against `.env.example` to simulate the fresh-clone path; a broker-side DLQ offset read plus a console-consumer read of the dead-lettered envelopes; a full `pnpm quality` run (exit 0); `./init.sh`; and a `docker inspect` of the running container's real environment. Working tree confirmed identical to the pre-review snapshot; `.env` untouched (mtime `15:35:36`, predating the review); 19 containers, 0 unhealthy.

**Verdict: APPROVED** — 2026-08-30. Feature 23 stays `done`; no `feature_list.json` edit was made or needed.
