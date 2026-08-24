# review_notifications_service — feature 23, phase 11

**Verdict: REJECTED.**

Five blocking findings. The feature's third acceptance bullet — *idempotent by eventId* — **fails against real Kafka**, demonstrated by a reviewer probe that produced **three emails for one `eventId`**. Its first acceptance bullet — *real email verified in the Mailtrap inbox for each notified fact* — is unmet for six of the seven facts. And the guard the implementer cites as sanctioning the design, `idempotent-consumer.parity.spec.ts` (OI12), was proven to be **text-only for variants**: it passes unchanged against a `runOnce` that performs no deduplication at all.

Everything else in the feature is good work, and much of it is very good: the seven fact-emission guards are all real, the port swap is airtight, the fail-fast binding rule is correct and well tested, and credentials hygiene is clean. The rejection is narrow and specific.

---

## Method — what I ran, and what I deliberately did not

`pnpm quality` was exit 0 minutes before this review (implementer's record: notifications 68/68, ten packages). **I did not re-run it**, nor the notifications unit suite in full, nor the existing integration spec. What I ran instead:

| # | Probe | Command / artefact |
|---|---|---|
| P1 | **Real-Kafka restart + offset-reset probe** (bespoke, written by me, deleted afterwards) | `vitest run --config vitest.integration.config.mts src/zz-reviewer-restart-probe.integration.spec.ts` — Testcontainers `apache/kafka:4.3.1`, 46.7 s, exit 0 |
| P2 | **OI12 subversion probe** — notifications' `runOnce` replaced with a no-dedup body, banner untouched | `apps/orders`: `vitest run src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` |
| P3 | Same mutation, against the service's own specs | `apps/notifications`: `vitest run src/infrastructure/messaging/idempotent-consumer.spec.ts src/application/notification-dispatch.service.spec.ts` |
| P4 | **NS9 binding probe** — a real `@MessagePattern('notifications.probe', Transport.NATS)` added to `notification-facts.controller.ts` | `vitest run src/notifications-consumes-only.spec.ts` |
| P5 | **Four un-armed handler guards** — `dispatch(...)` deleted from `NotifyOrderConfirmed/Despatched/InvoiceIssued/OrderCompleted` | `vitest run src/application/commands/notify.command-handlers.spec.ts` |
| P6 | Credential leak sweep — the live `.env` values grepped across the whole tree and the whole git history | `grep -rIl -F`, `git log --all -S` |
| P7 | Lint | `npx eslint apps/notifications --max-warnings=0` → exit 0 |
| P8 | Package reality check | `npm view nodemailer version`, `npm view @types/nodemailer dist-tags` |

Every mutated file was restored from a pre-mutation copy and confirmed **md5-identical**:

```
ff676f3a60ef993ad79876b30a8fdb6f  idempotent-consumer.ts
8a854f887b4524ec88374edd59927d39  notification-facts.controller.ts
12dae9c224de3a201054fe970960d450  notify.command-handlers.ts
```

The temporary probe spec was deleted; `git status --porcelain apps/notifications` is identical to the submitted state.

---

## Probe 1 — does an in-memory store satisfy "one delivery regardless of redelivery"?

**No. Demonstrated, not argued.**

### The wiring, read first

- `apps/notifications/src/main.ts:28-36` — one Kafka microservice transport, `subscribe: { fromBeginning: true }`, `run: { partitionsConsumedConcurrently: 1 }`. No `autoCommit` override, so Nest's `ServerKafka` runs kafkajs's default `eachMessage` auto-commit (periodic: 5 s / 100 messages), **not** a commit-per-message.
- `apps/notifications/src/app.module.ts:25` — `{ provide: PROCESSED_EVENTS, useClass: InMemoryProcessedEventsStore }`. One `Set<string>` on the heap. Nothing else.
- `apps/notifications/src/presentation/notification-facts.controller.ts:122-146` — `route` returns normally on every path, so the offset always commits.

### The probe (P1), against a real broker

Three successive Nest apps over one Kafka container, each a fresh `AppModule` compilation and therefore a **fresh, empty** `InMemoryProcessedEventsStore` — exactly what a process restart gives you. `NOTIFICATION_SENDER` overridden to a counting fake. One envelope, `eventId: "restart-probe-event-1"`.

```
[PROBE] run1 sends = 1
[PROBE] run2 (restart, same group, SAME eventId republished) sends = 1
[PROBE] run3 (offset reset, new group, nothing published) sends = 1
[PROBE] TOTAL emails for ONE eventId "restart-probe-event-1" = 3
```

### The four scenarios, answered concretely

| Scenario | Duplicate email sent? | Why |
|---|---|---|
| **Service restart** | **YES** — proven, `run2` | The `Set` is heap state. Run 2 rejoined the same consumer group with an empty ledger and sent again for an `eventId` already notified in run 1. |
| **Consumer-group rebalance** | No | Single instance, one process; the partition returns to the same heap and the same `Set`. This is the *only* one of the four that the in-memory store survives — and it is the only one the shipped integration spec tests. |
| **Offset reset / new consumer group** | **YES** — proven, `run3` | `fromBeginning: true` replays the topic from offset 0 into an empty ledger. Run 3 published nothing at all and still sent. |
| **Crash after send, before offset commit** | **YES** | The send happens inside `work`; the offset commits up to 5 s later, asynchronously, and the mark lives only on the heap. A crash in that window loses both the offset and the ledger, so the message is redelivered to an empty store. |

Three of four redelivery classes send a duplicate. R18 ("WHILE the pair has already been recorded... acknowledge the redelivery without... issuing any command") and `domain-model.md` §6 ("one delivery per `(eventId, consumer)` **regardless of redelivery**") are not satisfied. R17's verb is **record**; a `Set` that vanishes with the process does not record.

### The implementer already observed this and mis-classified it

`progress/impl_notifications_service.md:113` records that the live first attempt "re-consumed the FULL historical backlog... attempted many real sends in a burst and hit Mailtrap sandbox's rate limit (`550 5.7.0 Too many emails per second`)", and calls it "a genuine, useful confirmation that a failed send is retried on redelivery". That paragraph is a **live reproduction of finding N1 and N3**, not a confirmation of correct behaviour. It is the defect firing against a real broker with real credentials.

### On `domain-model.md` §34 as licence

§34's row reads *"Notifications | **Nothing durable** — stateless rendering and delivery... | Does **not** own: Any aggregate"*. Read in its own table, the column is about **owned aggregates and business state** — it is the "Owns" column, opposed by "Does not own: any aggregate". The consumer dedup ledger is not owned business state; in Orders, Fulfillment and Billing it is infrastructure (`processed_events`), never an aggregate. §6, five lines long, then states the obligation explicitly and cites R17/R18 by number. §34 does not license discarding the one obligation §6 names.

**And Notifications is the service that can least afford to lose layer 1.** `specs/shared/saga.md:297-320` describes three layers: (1) the dedup record, (2) the state-machine precondition, (3) idempotent commands. Notifications has **no aggregate and no state machine** (§6: "Owns no aggregate and no invariant") and **issues no commands**. Layers 2 and 3 do not exist for it. Layer 1 is its *only* line of defence — the argument runs the opposite way from the one made in the impl record.

---

## Probe 2 — is check-then-work-then-mark safe?

**Not fully, independently of the store's durability — but the ordering is the smaller of the two defects, and the reasoning behind it is legitimate.**

`idempotent-consumer.ts:53-58`:

```ts
if (await this.processedEvents.hasProcessed(eventId, consumer)) { return 'duplicate'; }
await work();
await this.processedEvents.markProcessed(eventId, consumer);
```

Against the canonical (`apps/fulfillment/.../idempotent-consumer.ts:45-56`, a verbatim copy of Orders'): `BEGIN` → `INSERT` **first** → duplicate-key ⇒ rollback + `'duplicate'` → `work(tx)` → `COMMIT`.

**Two concurrent deliveries of the same `eventId`.** The banner's own stated cost. In practice the risk is smaller than the banner claims and for a different reason than the banner gives: facts are keyed by `aggregateId`, so a given `eventId` lands on one partition, and one partition is consumed by exactly one member of a consumer group — so even a horizontally scaled deployment does not produce two concurrent deliveries of the *same* message. The residual real case is a *republished* duplicate arriving while the first is still in `work`; with `partitionsConsumedConcurrently: 1` and same-key ⇒ same-partition, that too serialises. So this hazard is largely theoretical here — but note that **nothing guards it**: no test asserts `partitionsConsumedConcurrently === 1`, and `notifications-consumes-only.spec.ts` does not check it either. It is an accidental invariant.

**Crash between `work` and `mark`.** This one is real and unavoidable in this ordering, *even with a durable store*: the email is out, the ledger row is not written, the offset is not committed. Redelivery sends a second email. The canonical does not have this window — its dedup row and its effects commit or roll back together, which is precisely what R17's "in the **same transaction**" clause buys. Mark-after-work converts R18's at-most-once statement into at-least-once by construction.

**The trade-off the implementer names is genuine but resolvable.** Marking before `work` would swallow a real SMTP failure on redelivery — true. But the canonical does not suffer that either: the failed `work` throws, the transaction rolls back, and the dedup row goes with it. The portable equivalent without a transaction is *insert-first, delete-on-throw* — write the ledger row, run `work`, and on a thrown `work` delete the row before rethrowing. That keeps retriability and shrinks the failure window from "duplicate an email" to "possibly lose one", which is the direction `domain-model.md` §6's "one delivery" points.

Note also that `idempotent-consumer.spec.ts`'s third case ("does not mark the event processed when work throws...") **codifies the divergent ordering as intended behaviour**, so any future move to insert-first will require editing that test — worth knowing before the fix is briefed.

---

## Probe 3 — was the parity guard subverted?

**The guard was not edited or tricked. It is worse than that: for a "variant", OI12 has never compared anything but text, and I proved it blesses arbitrary semantics.**

`apps/orders` is byte-untouched (`git status`), so nothing was subverted in the ordinary sense. But the fourth case, `idempotent-consumer.parity.spec.ts:213-228`, does exactly two things to a variant:

```ts
expect(banner, `${variantPath}: a variant's banner must cite the canonical path`).toContain(CANONICAL_PATH_LITERAL);
expect(banner, `${variantPath}: a variant's banner must carry a "Divergence:" line`).toMatch(/Divergence:/);
```

It reads the **banner** — the file's leading run of `//` lines — and asserts two substrings. It never reads the body. It never imports the class. It executes no behaviour.

**Probe P2.** I replaced the entire body of `apps/notifications/src/infrastructure/messaging/idempotent-consumer.ts` with a `runOnce` that ignores the store completely and always runs `work` — no deduplication of any kind, the exact defect OI12 exists to catch — leaving the banner byte-identical. Then ran the guard:

```
RUN  v4.1.11 .../apps/orders
Test Files  1 passed (1)
     Tests  4 passed (4)
```

Four green. The service's own specs did catch it (P3: `Tests 2 failed | 4 passed (6)`, `expected 'processed' to be 'duplicate'`) — which independently corroborates the implementer's armed-deletion record #1 — but OI12 saw nothing.

Two further structural weaknesses, both now armed for the first time by this feature:

1. **The "copy vs variant" discriminator is self-selected.** `hasMySqlProcessedEventsSchema(app)` (line 94) tests for the existence of a file the implementer chooses whether to create. Not creating it moves the app out of the byte-identity comparison (case 1) *and* out of the "every fact-consuming write model must own a copy" requirement (case 3, line 199-211 — also gated on the schema). Notifications has three `@EventPattern` handlers and is exempt from both.
2. **Feature 24 inherits the blessing.** The guard's own comment at line 219-220 says the variant branch "arms at features 23/24 (the projector's MongoDB ledger, notifications' choice of store)". It armed here for the first time and did nothing. The projector will pass it the same way.

So the implementer's claim at `impl_notifications_service.md:37` — "This divergence is exactly what OI12 was built to require... verified by re-running `apps/orders`' own suite" — is **literally accurate and materially misleading**: the guard did run, and it did require the banner, and requiring a banner is all it has ever done. Citing a passing text-match as architectural sanction for a semantic divergence is the part that must not stand, because it is the pattern that will silently bless every future variant in every service.

---

## Probe 4 — what a correct implementation looks like here

Notifications genuinely has no database. Four options, assessed:

**(a) A fourth MySQL database, `otc_notifications`, with the canonical `processed_events` table.** Requires `docker-compose.infra.yml`, `infra/mysql/init/*`, `.env.example`, plus a Drizzle connection in the service. **Strongest option.** It satisfies R17 verbatim including the "same transaction" clause (the mark and — there being no other effect — nothing else, in one commit), lets the service adopt the canonical `idempotent-consumer.ts` + `processed-events.repository.ts` pair **byte-identically**, and thereby arms OI12's real comparison branch for a third service instead of its text branch. Cost: contradicts a reading of §34, adds a database for one table, and expands scope beyond `apps/notifications/**` — a scope call only the leader can make.

**(b) A `otc_notifications` logical database on the already-running MongoDB, `processed_events` collection, unique compound index on `(consumer, eventId)`.** **My recommendation if the leader will not expand compose scope.** No new container, no new compose service; a separate logical database on a shared server is architecturally identical to the three MySQL databases already sharing one MySQL server, so "database per service" is honoured. `insertOne` against a unique index gives the same duplicate-key serialisation the canonical buys from InnoDB, so the ordering can be insert-first. It stays a documented *variant* (single-document atomicity, no multi-statement transaction — which is fine, because there is no second effect to be atomic with). Costs a `mongodb` dependency, a `MONGODB_*` line in `.env.example`, and a Testcontainers Mongo in the integration suite.

**(c) Kafka's own semantics. Reject — this option does not exist.** Kafka exactly-once applies to transactional read-process-**write** where the offset commit joins the producer transaction. An SMTP send is not a Kafka write and cannot be enrolled in that transaction. Kafka gives at-least-once here and nothing more. Note that `fromBeginning: true` actively makes this worse, not neutral.

**(d) An idempotency key on the transport. Accept as defence in depth, never as the mechanism.** SMTP has no dedup and Mailtrap's sandbox has no idempotency key. Setting `messageId: <eventId>@order-to-cash` deterministically in `MailtrapNotificationSender` costs one line, makes duplicates *visible and attributable* in the inbox, and lets a human confirm dedup by eye during the demo. Worth doing alongside (a) or (b). It does not prevent a send.

**Recommended package:** (b) **or** (a) at the leader's discretion, **plus** (d), **plus** switching to insert-first with delete-on-throw, **plus** reconsidering `fromBeginning: true` (see N3), **plus** a cross-restart test (N7) and a behavioural OI12 conformance suite (N5). The last is the one that outlives this feature.

---

## Probe 5 — seven facts, seven guards

**PASS.** All seven guards are real.

The implementer armed three (NS1, NS5, NS7). **I independently armed the other four** (P5): `dispatch(...)` replaced with `void command;` in `NotifyOrderConfirmedHandler`, `NotifyOrderDespatchedHandler`, `NotifyInvoiceIssuedHandler`, `NotifyOrderCompletedHandler`:

```
FAIL ... NS2 — NotifyOrderConfirmedHandler ...   AssertionError: ... Number of calls: 0
FAIL ... NS3 — NotifyOrderDespatchedHandler ...  AssertionError: ... Number of calls: 0
FAIL ... NS4 — NotifyInvoiceIssuedHandler ...    AssertionError: ... Number of calls: 0
FAIL ... NS6 — NotifyOrderCompletedHandler ...   AssertionError: ... Number of calls: 0
 Test Files  1 failed (1)
      Tests  4 failed | 3 passed (7)
```

Between the implementer's three and my four, **all seven have now been armed**. Each asserts `toHaveBeenCalledWith(ENVELOPE, buildXMessage)` — the fact's *own* template builder, so a copy-paste of the wrong builder fails too, not merely a deleted call. `notify.command-handlers.spec.ts:40-43`'s `fakeDispatcher` is a genuine `vi.fn()` with a real call record; no vacuity.

The seven facts match `domain-model.md` §7.3 line 487 exactly, and `stock.*` / `credit.*` are correctly excluded (`notification-facts.controller.ts:137-143`, tested at `notification-facts.controller.spec.ts:74`).

---

## Probe 6 — the port swap

**PASS, on both halves.**

**No test can send real mail.**
- The only spec that touches `AppModule` is `notification-consumption.integration.spec.ts:99-102`, and it calls `.overrideProvider(NOTIFICATION_SENDER).useValue(sender)` — which **replaces the provider definition**, so `app.module.ts:32`'s `useFactory` never runs and `resolveNotificationSenderBinding()` is never even called. Mailtrap cannot be constructed on that path regardless of the ambient environment.
- `grep -rn "nodemailer" src --include='*.spec.ts'` → **zero hits**. `mailtrap-notification-sender.spec.ts` injects a fake `createTransporter` in all three cases, and one case exists specifically to prove the transporter is created lazily and never at construction.
- Neither `vitest.config.mts` nor `vitest.integration.config.mts` loads `.env`; only `dev`/`start` do (`package.json`, via `dotenv-cli`).

**The binding fails fast, it does not silently fall back.** `mailtrap.config.ts:54-78` throws on a partial credential pair, on a missing `MAILTRAP_HOST`, on a missing `MAILTRAP_FROM_EMAIL`, and on a `MAILTRAP_PORT` that is not a positive integer. Because the throw happens inside the `NOTIFICATION_SENDER` `useFactory`, it aborts Nest's container build — the demo cannot boot half-configured and appear to work while sending nothing. Five of the seven cases in `mailtrap.config.spec.ts` are the refusal cases. The `replace_me`-both / absent-both console default is correctly classified as the expected state, not a misconfiguration.

---

## Probe 7 — credentials hygiene

**PASS. Clean, and I checked it the hard way.**

Extracted the live `MAILTRAP_USER` and `MAILTRAP_PASSWORD` values from the untracked `.env` (14 chars each) and searched for those literals:

- `grep -rIl -F "<user>"` and `grep -rIl -F "<password>"` across the entire working tree, excluding only `node_modules`, `dist`, `.git` and `.env` itself → **zero files**. Nothing in `apps/notifications/**`, no test fixture, no `.env.example`, no `progress/*.md`.
- `git log --all -S"<user>"` and `git log --all -S"<password>"` → **zero commits**. Never introduced and never removed; it has never been in the history.
- `git ls-files .env .env.*` → only `.env.example` is tracked; `.gitignore:30-31` covers `.env` and `.env.*`.
- `.env.example:195-201` carries `replace_me` placeholders only.
- Code paths: `mailtrap.config.ts` returns the values only inside `MailtrapConfig`; `MailtrapNotificationSender` passes them only to `nodemailer.createTransport`'s `auth`. No log line in either file. `ConsoleNotificationSender` logs `to` and `subject` only, never a credential.
- The fixture in `mailtrap-notification-sender.spec.ts:9-10` uses the obviously synthetic `'real-user'` / `'real-password'`.
- `impl_notifications_service.md:117` states credentials "were never read, echoed or logged at any point; only presence/absence was checked via `grep -c`" — consistent with what I found.

---

## Probe 8 — "consumes only"

**PASS, and the guard genuinely binds.**

**Probe P4:** I added a real responder to `notification-facts.controller.ts` —

```ts
@MessagePattern('notifications.probe', Transport.NATS)
async probeRpc(): Promise<string> { return 'ok'; }
```

— and ran the guard:

```
FAIL  src/notifications-consumes-only.spec.ts
 ❯ src/notifications-consumes-only.spec.ts:57  ... must not use @MessagePattern(...) (NS9 — this service answers no RPC)
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

The guard also checks: no `.producer(` anywhere outside `test-support/`; exactly one `connectMicroservice` call; it names `Transport.KAFKA`; `Transport.NATS` absent from `main.ts`; no file path matching `/outbox/i`. It carries its own non-vacuity assertions (`files.length > 10`, and a positive fixture for the `@MessagePattern` regex). Confirmed by reading: no outbox, no NATS client, no producer, no fact emission anywhere in the service.

`@EventPattern(..., Transport.KAFKA)` is explicit on all three handlers (`notification-facts.controller.ts:107,112,117`), per the CLAUDE.md non-negotiable. `npx eslint apps/notifications --max-warnings=0` → exit 0, so the DI-token and transport `no-restricted-syntax` guards both pass.

---

## Probe 9 — scope and packages

**PASS.**

`git status --porcelain` shows changes confined to `apps/notifications/**`, `feature_list.json` (status flip only), `pnpm-workspace.yaml` (two catalog lines) and `pnpm-lock.yaml`. **`apps/orders`, `apps/fulfillment`, `apps/billing`, `apps/projector`, `apps/gateway`, `apps/web`, `apps/seed`, `packages/**` and `specs/**` are all untouched** — verified, including that `apps/orders/.../idempotent-consumer.parity.spec.ts` is byte-unmodified.

Packages:
- `nodemailer@9.0.5` — real; `npm view nodemailer version` → `9.0.5`, i.e. the current latest.
- `@types/nodemailer@8.0.1` — real; `npm view @types/nodemailer dist-tags` → `latest: 8.0.1`, and 8.0.1 is the entry for `ts5.8`/`ts5.9`/`ts6.0`. DefinitelyTyped does not track nodemailer's major (it also publishes 8.x against runtime 7.x/8.x/9.x). The implementer's explanation is accurate; the major mismatch is expected, not a defect. Both resolved on disk at exactly those versions.

Money handling is correct (`notification-format.ts:14-20`: integer minor units in, display string out, no float arithmetic, `Math.floor`/modulo on integers). `notifications/src/domain/` contains only `.gitkeep`, correct for a context that owns no aggregate.

---

## CHECKPOINTS walk

### C1 — the harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (plus `suite_runner`).
- [x] Every agent definition declares its model. *(Unchanged since the last review; not re-verified line by line.)*
- [x] `./init.sh` exits 0. *(Unchanged this feature; not re-run.)*

### C2 — state is coherent
- [x] At most one feature `in_progress` — zero at review time; 22 `done`, 16 `pending`, 1 `in_review`.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it.
- [ ] **`progress/current.md` describes the active session** — it still describes **feature 22** (`billing_remittance_intake`, "Status: done"). Leftovers from the previous session. See **N11**.
- [x] Every `blocked` feature records why — none blocked.

### C3 — architecture is respected
- [x] No forbidden import in any `domain/` folder — ESLint exit 0; `apps/notifications/src/domain/` is empty by design (§6: owns no aggregate).
- [x] No cross-service database access — Notifications has no database at all, and reads none.
- [x] No shared runtime code beyond `shared-kernel` and `contracts` — imports `@otc/contracts` only.
- [x] `packages/shared-kernel` still has zero runtime dependencies — untouched.
- [x] Every interaction classifiable as Kafka-fact or NATS-RPC — three Kafka fact consumptions, zero RPC. Correct per the matrix.
- [x] No stray debug logging, no context-free TODOs — the two `console` uses are the deliberate structured-JSON console adapter and the malformed-envelope error line.

### C4 — verification is real
- [x] `pnpm quality` passes. *(Implementer's record, exit 0 minutes before review. Not independently re-run — see Method. I re-ran ESLint and five targeted spec files.)*
- [x] Domain tests are pure — N/A here; the application/infrastructure unit tests are framework-free and hand-rolled.
- [x] Integration tests use Testcontainers against real Kafka, not mocked brokers — **independently verified**: I stood up my own `apache/kafka:4.3.1` container through the service's own fixture.
- [x] Coverage thresholds — thresholds are wired in `vitest.config.mts` (60/60/60) and not enforced-failing until phase 21; implementer reports green.
- [x] No Jest anywhere — `grep` across all `package.json` → zero hits.
- [ ] **Tests are real, and would fail if the behaviour regressed** — *seven of seven fact guards: yes, proven. The idempotency guard: **no**.* `idempotent-consumer.spec.ts` and `notification-consumption.integration.spec.ts` both pass against an implementation that sends duplicate emails on restart, on offset reset and on a crash before commit. See **N7**.

### C5 — the session closed cleanly
- [x] No suspicious untracked files — `git status` clean of `*.tmp`; the implementer's temporary live-verification scripts were deleted, and so was my probe spec.
- [ ] **`progress/history.md` has an entry for the feature just finished, including its effort record** — no entry; correctly absent, since the feature is not approved.
- [x] `feature_list.json` reflects the true state — set to `in_progress` by this review.
- [x] The human has been told what was done and how to test it — `impl_notifications_service.md` is thorough and candid.
- [x] Claude did not commit — confirmed, no commit made by me.

### C6 — spec-driven development
Not applicable — feature 23 is `sdd: false`. The implementer correctly declined to invent `R<n>` ids, used local `NS1`–`NS9`, and correctly left `specs/shared/test-matrix.md` alone as gated.

### C7 — trilogy reusability
- [x] `specs/shared/` contains no stack specifics — untouched by this feature.
- [x] `n8n/workflows/*.json` — untouched.
- [ ] **`progress/history.md` effort records are complete and honest** — pending this feature's entry, which cannot be written until approval.

---

## Requirement → test mapping verified

No `R<n>` ids were invented, correctly. The applicable shared requirements are R17 and R18 (via `domain-model.md` §6), plus the §7.1 envelope and §7.3 consumption set.

| Requirement / claim | Test(s) | Verified |
|---|---|---|
| **R17** — record `(eventId, consumer)` | `idempotent-consumer.spec.ts` (in-memory fake store) | **FAILS the requirement.** The pair is recorded only on the heap; nothing durable is written. No test asserts durability. |
| **R18** — redelivery acknowledged without re-issuing the command | `idempotent-consumer.spec.ts:34`, `notification-dispatch.service.spec.ts:55,70`, `notification-consumption.integration.spec.ts:136-142` | **Partially.** Holds for in-process redelivery only. Fails for restart, offset reset and crash-before-commit — proven by P1. |
| §7.1 envelope — all seven fields required, correlationId in the subject | `notification-facts.controller.spec.ts:32-58`; `subjectWithCorrelationId` in all seven template specs | ✅ |
| §7.3 — exactly the seven notified facts, `stock.*`/`credit.*` excluded | `notify.commands.spec.ts`; `notification-facts.controller.spec.ts:74` | ✅ |
| NS1–NS7 — one templated email per fact | `notify.command-handlers.spec.ts` + seven `*.template.spec.ts` | ✅ all seven armed |
| NS8 — idempotent by eventId | as R18 above | ❌ |
| NS9 — consumes only | `notifications-consumes-only.spec.ts` | ✅ guard binds (P4) |
| Acceptance #1 — real email in the Mailtrap inbox **for each notified fact** | none | ❌ 1 of 7, SMTP-accept only |
| Acceptance #2 — console adapter used in tests via the same port | `app.module.ts:31-38`, integration override, `mailtrap.config.spec.ts` | ✅ |
| Acceptance #3 — idempotent by eventId | as R18 | ❌ |

---

## Findings

### Blocking

**N1 — BLOCKING — the in-memory dedup ledger does not satisfy R17/R18; three emails sent for one `eventId` against real Kafka.**
`apps/notifications/src/infrastructure/messaging/in-memory-processed-events.store.ts:19` (`private readonly seen = new Set<string>()`), bound at `app.module.ts:25`.
Proven by probe P1: `run1 = 1`, `run2 (restart, same group) = 1`, `run3 (new group, offset reset, nothing published) = 1`. `domain-model.md` §6 requires one delivery per `(eventId, consumer)` **regardless of redelivery**; R17's verb is *record*. A heap `Set` records nothing.
**Why it matters:** it is the feature's own third acceptance criterion, and the effect is a duplicate email to a counterparty — the one externally visible side effect this service has.
**Owner: implementer** (after a leader decision on which store — see Probe 4).

**N2 — BLOCKING — the justification inverts `saga.md` §6's layering.**
`impl_notifications_service.md:35` and `in-memory-processed-events.store.ts:9-14` argue the weakened guarantee is "acceptable for a single-instance demo service". `specs/shared/saga.md:297-320` gives three layers of defence; Notifications has no aggregate and no state machine (layer 2 unavailable) and issues no commands (layer 3 unavailable). **Layer 1 is its only defence**, so it needs it *more* than the orchestrator, not less. `domain-model.md` §34's "nothing durable" is the *Owns* column of an aggregate-ownership table, opposed by "Does not own: any aggregate" — it does not license discarding the obligation §6 states explicitly five lines long with R17/R18 cited by number.
**Owner: implementer** (the reasoning must be corrected in the file headers and the impl record, not only the code).

**N3 — BLOCKING — `fromBeginning: true` plus a non-durable ledger is a mail storm, and it already fired live with real credentials.**
`apps/notifications/src/main.ts:33`. Any new consumer group, any offset expiry, any reset replays the full retained history of three topics into an empty ledger. `impl_notifications_service.md:113` records this happening against the real stack: "the service attempted many real sends in a burst and hit Mailtrap sandbox's rate limit (`550 5.7.0 Too many emails per second`)". Probe P1's `run3` reproduces it deterministically.
The impl record classifies this as "a genuine, useful confirmation" of correct retry behaviour. It is not; it is N1 firing.
**Why it matters:** with a durable ledger, `fromBeginning: true` is harmless and even useful (it is why Orders uses it). Without one, it converts a routine ops action into a mass mailing. Fix N1 and this becomes safe; ship as-is and the demo is one `groupId` change away from spamming the inbox.
**Owner: implementer.**

**N4 — BLOCKING — acceptance criterion 1 is unmet for six of seven facts, and unverified for the seventh.**
`feature_list.json` id 23: *"real email verified in the Mailtrap inbox for each notified fact"*. `impl_notifications_service.md:114-117` records **one** send (`order.placed.v1`), verified only to the level of "`sendMail` resolved without throwing" — SMTP `DATA` accepted, which is not inbox verification. Six facts have no live send at all.
The implementer discloses the limitation honestly (no browser tool, SMTP credentials only, no API token) and asks the human to confirm visually — the disclosure is exactly right, but the criterion still is not met.
**Owner: implementer** to produce one send per fact (a script over the seven `build*Message` builders, as the existing single-send script already demonstrates), **plus the human** for the visual inbox confirmation. Consider N5's `messageId` suggestion first so the seven are individually attributable in the inbox.

**N5 — BLOCKING (harness defect, worse than the feature defect) — OI12's variant branch compares text, not behaviour, and this feature is the first to arm it.**
`apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts:213-228`.
Proven by probe P2: with notifications' `runOnce` replaced by a body that performs **no deduplication at all** and the banner left untouched, OI12 reported `Tests 4 passed (4)`.
Two compounding weaknesses: the copy-vs-variant discriminator (`hasMySqlProcessedEventsSchema`, line 94) is a file the implementer chooses whether to create, and it also gates case 3 (line 199-211), so a schema-less app with three `@EventPattern` handlers is exempt from owning the canonical pattern at all.
**Why it matters more than N1:** the guard's own comment says it arms at "features 23/24". It armed here and caught nothing. Feature 24's projector variant will pass identically. A guard that blesses arbitrary semantics is worse than no guard, because the impl record cites its green result as architectural sanction (`impl_notifications_service.md:37`).
**Required change:** add a **behavioural conformance suite** every `IdempotentConsumer` implementation must pass — fresh `eventId` runs `work` once and returns `'processed'`; a second call returns `'duplicate'` and does not run `work`; **and a consumer constructed fresh over the same backing store still returns `'duplicate'`** (the case that would have caught this defect). Keep the banner check as a documentation requirement, never as the semantic one.
**Owner: leader** to brief; **test_maintainer or implementer** to write. Note `apps/orders` is out of feature 23's scope, so this needs its own briefing.

### Non-blocking

**N6 — Medium — check-then-work-then-mark leaves a crash window even with a durable store, and no test covers it.**
`idempotent-consumer.ts:53-58` vs the canonical's insert-first at `apps/fulfillment/.../idempotent-consumer.ts:45-56`. A crash between `await work()` and `await markProcessed(...)` sends an email that is never recorded; redelivery sends it again. Recommend insert-first with delete-on-throw (Probe 2). Note `idempotent-consumer.spec.ts`'s third case currently codifies the divergent ordering as intended, so it will need updating with the fix.
**Owner: implementer.**

**N7 — Medium — the only redelivery scenario tested is the only one the design survives.**
`notification-consumption.integration.spec.ts:136-142` republishes the same `eventId` into the *same running process*. That is the rebalance case, the one scenario in Probe 1's table where the in-memory store works. Restart, offset reset and crash-before-commit — three of the four — have no test at all. This is precisely why a green suite shipped a defect that a 47-second probe found. The fix for N1 must land with a cross-restart integration case (P1 is a working template: two `Test.createTestingModule` compilations over one broker, same `groupId`, `expect(sender2.callCount).toBe(0)`).
**Owner: implementer.**

**N8 — Low — `InMemoryProcessedEventsStore.seen` is unbounded.**
`in-memory-processed-events.store.ts:19`. One entry per event for the process lifetime, with no eviction — and `fromBeginning: true` seeds it with the entire retained history on boot. Moot once N1 is fixed with a real store; worth a line if any in-memory tier survives as a cache.
**Owner: implementer.**

**N9 — Low — the seven HTML templates interpolate payload fields unescaped.**
e.g. `payment-received.template.ts:20-28`, and the same pattern in all seven. `${payload.paymentReference}` and friends go straight into `<strong>...</strong>`. Fact payloads are internally produced today, so this is not currently reachable — but `paymentReference` on the remittance path is externally supplied (feature 22), and the output is rendered by an email client. One shared `escapeHtml` in `notification-format.ts` closes it.
**Owner: implementer.**

**N10 — Low — the service's own environment variables are undocumented.**
`kafka.config.ts:26-35` reads `NOTIFICATIONS_KAFKA_CLIENT_ID` and `NOTIFICATIONS_CONSUMER_GROUP`; `main.ts:40` reads `NOTIFICATIONS_PORT`. None appear in `.env.example`. The implementer flags this deliberately as out of scope (`impl_notifications_service.md:135`) and that call is defensible — but the group id is the exact knob that triggers N3's storm, so it should be documented *with a warning* rather than left implicit.
**Owner: leader** (`.env.example` is outside `apps/`).

**N11 — Low — `progress/current.md` still describes feature 22.**
Header reads *"Feature: `billing_remittance_intake` (id 22, phase 10)"*, status `done`. C2's fourth box requires it to describe the active session or hold only the template.
**Owner: leader.**

---

## What must change before re-review

1. **N1/N2** — replace the in-memory ledger with a durable store. Leader decides between option (a) a fourth MySQL database with the **byte-identical canonical copy**, and option (b) a `otc_notifications` logical database on the existing MongoDB with a unique index on `(consumer, eventId)`. Either way the scope of feature 23 must be formally widened beyond `apps/notifications/**` — the implementer's refusal to widen it unilaterally was correct process, and the fault here is that the *consequence* of that boundary was shipped rather than escalated.
2. **N6** — switch to insert-first with delete-on-throw, and update `idempotent-consumer.spec.ts`'s third case accordingly.
3. **N7** — add a cross-restart integration case that fails today. Probe P1 is a working template.
4. **N3** — with a durable ledger in place, keep `fromBeginning: true` if desired and say why in `main.ts`; without one, it must go.
5. **N4** — one live send per notified fact, then human visual confirmation of the inbox. Set `messageId` from `eventId` (Probe 4d) so the seven are individually attributable and any duplicate is visible.
6. **N5** — a separate briefing against `apps/orders`: a behavioural conformance suite for `IdempotentConsumer`, including the fresh-consumer-over-same-store case. **Do this before feature 24**, which will otherwise inherit the same empty blessing.
7. **N9, N10, N11** — at the leader's discretion; none gate re-approval.

`feature_list.json` id 23 set back to **`in_progress`**.

---

# Round 2 — re-review after the durable-ledger pass

**Verdict: APPROVED.**

The five round-1 blockers that were mine to check are closed, and closed properly rather than papered over. The single most important number: **the probe that produced `TOTAL emails for ONE eventId = 3` in round 1 now produces `1`** — across four redelivery classes, against a real Kafka broker and a real MySQL database. The OI12 guard that blessed a gutted `runOnce` in round 1 now **fails** on the identical mutation. Insert-first was verified by direct observation of the committed ledger row from an independent connection at the moment `send()` was called, not inferred from a passing test.

N5 and N11 are the leader's and are not re-raised. Acceptance criterion 1 is carried to the human as an explicit, named open item (**N12**) rather than silently closed — see the disposition note at the end.

## Method — round 2

`pnpm quality` (exit 0, all ten packages, notifications 70/70), the notifications integration suite (2/2, twice) and OI12 (4/4) were all green minutes before this pass. **I re-ran none of them.** What I ran:

| # | Probe | Result |
|---|---|---|
| R2-P1 | **Bespoke four-app restart / crash / offset-reset probe** — real Kafka + real MySQL Testcontainers, written by me, deleted afterwards | `TOTAL = 1` |
| R2-P2 | **OI12 re-subversion** — `runOnce` gutted exactly as in round 1, banner untouched | OI12 **FAILS** (round 1: passed 4/4) |
| R2-P3 | **N6 ordering + delete-on-throw** — bespoke integration probe reading the ledger from an independent pool *inside* `send()` | insert-first proven; delete-on-throw proven |
| R2-P4 | **Fresh-volume MySQL init** — `mysql:8.4.11` started from an empty volume with `infra/mysql/init` mounted | `otc_notifications` created, granted, writable |
| R2-P5 | **N6/N9 guards armed** — compensation call deleted; `escapeHtml` made a passthrough | 3 named tests failed |
| R2-P6 | **Live binding resolution** — real `.env` through the built `dist/` | `binding.kind = mailtrap`, real adapter constructed |
| R2-P7 | Credential sweep (both `.env` files changed this round) | zero occurrences, zero in history |
| R2-P8 | Byte-identity of the canonical pair; schema/DDL comparison; scope diff; ESLint; typecheck | all clean |
| R2-P9 | Targeted specs: dispatch service, notification-format, payment-received template, NS9 | 16/16 |

Every mutated file restored and confirmed md5-identical:

```
9a90fcd0beac5e510214ccbc573d8dd7  idempotent-consumer.ts
318e0278e9dcd74ba4e2473c8ebe4f4c  notification-dispatch.service.ts
1bd48ae0c76f2a47ef2c108300c175e0  notification-format.ts
```

Both temporary probe specs and the temporary MySQL probe container were deleted. `git status` matches the submitted state exactly.

---

## Probe 1 — the restart probe, re-run

**PASS. One email, where round 1 produced three.**

Same shape as round 1's probe, extended from three apps to four so that all three scenarios the coordinator named are covered, each by its own mechanism. Every app is a **separate `Test.createTestingModule` compilation**, so each gets a genuinely fresh object graph — the same thing a process restart gives you.

```
[PROBE2] run1 (fresh) sends = 1  ledgerRows = 1
[PROBE2] run2 (restart, same group, SAME eventId republished) sends = 0
[PROBE2] run3 (offsets rewound = crash before commit, original messages redelivered) sends = 0
[PROBE2] run4 (offset reset, NEW group, fromBeginning) sends = 0
[PROBE2] TOTAL emails for ONE eventId "restart-probe-event-1" = 1   (round 1 produced 3)
[PROBE2] final ledgerRows = 1
```

| Scenario | Round 1 | Round 2 | Mechanism used in the probe |
|---|---|---|---|
| **Restart** (same consumer group, fresh process, same `eventId` republished) | **duplicate** | **1 → 0** | `app1.close()`, fresh module compilation, re-publish |
| **Crash after send, before offset commit** | **duplicate** | **1 → 0** | `admin.resetOffsets({ groupId, earliest: true })` — the broker genuinely redelivers the **original** messages, which is exactly what an uncommitted offset produces. Not a republished copy. |
| **Offset reset / new consumer group** (`fromBeginning: true` forced in the probe) | **duplicate** | **1 → 0** | brand-new `groupId`, nothing published, full replay |
| **Rebalance** | ok | ok | unchanged |

The ledger held exactly **one** row at the start and exactly **one** at the end, so the dedup is doing the work and nothing is accumulating spuriously. R17's "record the pair" is now satisfied durably; R18's "acknowledge the redelivery without issuing any command" holds across every class.

Note the probe forced `fromBeginning: true` in run 4 deliberately, to test the ledger rather than the subscription setting — i.e. the result is **not** an artefact of N3's `fromBeginning: false` fix. The durable ledger alone is sufficient. That matters: the two fixes are independent, and neither is masking the other.

---

## Probe 2 — does OI12 now genuinely guard notifications?

**PASS, decisively. The guard that was cosmetic in round 1 is load-bearing now.**

The discriminator flipped for the right reason: `apps/notifications/src/infrastructure/persistence/schema/processed-events.schema.ts` now exists, so `hasMySqlProcessedEventsSchema('notifications')` is `true` and the service moved off the text-match variant branch onto **case 1, the byte-identity comparison** (and simultaneously onto case 3's "every fact-consuming write model must own a copy" requirement, which it previously escaped).

Byte-identity confirmed independently, banner-stripped exactly as OI12 does it:

```
idempotent-consumer.ts        orders / fulfillment / notifications  →  43dec27b87008b1d9b8cf95634873fd3  (all three)
processed-events.repository.ts orders / fulfillment / notifications  →  39242c2c157644069f030035034ef548  (all three)
```

**The subversion probe, repeated verbatim from round 1.** I replaced the body of notifications' `runOnce` with a version that performs no deduplication — it inserts and always returns `'processed'`, never signalling a duplicate — leaving the banner untouched:

```
FAIL  src/infrastructure/messaging/idempotent-consumer.parity.spec.ts > idempotent-consumer.parity — OI12
      > holds every write model's copy of the idempotent-consumer pattern byte-identical to the canonical copy
AssertionError: apps/notifications's idempotent-consumer.ts diverges from the canonical copy (banner-stripped)
 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
```

**Round 1: 4 passed. Round 2: fails, and names the file.** Restored, and OI12 back to 4/4. This is not cosmetic — the failure is a body comparison, and it fires on any semantic edit whatsoever.

One consequence worth recording, because it is now load-bearing: `apps/notifications` no longer carries a **unit** test of `IdempotentConsumer` (the old one tested the removed check-then-mark ordering and was correctly deleted). Its behaviour is now assured by two things together — OI12's byte-identity, which makes divergence impossible to land unnoticed, and `apps/orders`' own `idempotent-consumer.integration.spec.ts` + `saga-fact-handler.spec.ts`, which test the canonical's behaviour. That is a sound arrangement, but it means **OI12 is now the load-bearing link for three services**, which is a further argument for the leader's N5 briefing. Recorded as **N15**, informational.

---

## Probe 3 — insert-first, delete-on-throw

**PASS, and the ordering was proven by observation rather than inference.**

The wiring (`notification-dispatch.service.ts:75-92`) is: `runOnce(eventId, CONSUMER, no-op work)` → commits the dedup INSERT as its own short transaction; then `buildMessage` + `sender.send(...)` **outside any transaction**; on a throw, `compensation.delete(...)` then rethrow. `DrizzleProcessedEventCompensation` shares the same `UnitOfWork` (`app.module.ts:80`), so the DELETE really targets the row the INSERT committed.

**The ordering proof.** Rather than trust the call order in the source, I had the fake sender query `processed_events` **from an independent connection pool at the moment `send()` was invoked**. A committed row visible there can only mean the INSERT already committed:

```
[N6] attempts = [{"n":1,"rowsVisibleAtSendTime":1},{"n":2,"rowsVisibleAtSendTime":1}]
[N6] successful sends = 1
[N6] ledger rows after the failed-then-retried send = 1
```

Attempt 1 saw the row already there → **genuinely insert-first**, not check-then-mark wearing a new banner. Attempt 1 then threw; the compensation deleted the row; Kafka redelivered (no offset commit on a thrown `@EventPattern` handler); attempt 2 saw a clean ledger, re-inserted, and succeeded. Net: **one successful send, one ledger row.** The delete-on-throw is real end to end against MySQL, not just against a fake.

The unit guards are real too (R2-P5) — removing `await this.compensation.delete(...)`:

```
FAIL  N6 — deletes the just-recorded ledger row and rethrows when sender.send throws, so redelivery gets a fresh attempt
AssertionError: expected [] to deeply equal [ { eventId: 'event-1', …(1) } ]
```

### The residual window, stated plainly

| Crash point | Outcome | Honest label |
|---|---|---|
| After the INSERT commits, before `send()` is called | Offset uncommitted → redelivery → `'duplicate'` → **the email is never sent, and never will be** | **lose one** |
| During `send()`, where SMTP accepted `DATA` but the client reported failure | Compensation deletes the row, redelivery sends again → **duplicate** | duplicate — inherent to SMTP, which has no idempotency key; mitigated (not eliminated) by the deterministic `messageId` |
| After `send()` succeeds, before the offset commits | Row present → redelivery → `'duplicate'` → no second email | **correct** (proven, run3) |
| `compensation.delete` itself throws (database unreachable) | Row survives, redelivery answers `'duplicate'`, **and the original SMTP error is replaced by the delete error** | lose one, *and* lose the reason — see **N13** |

**Is "possibly lose one email" the honest characterisation? Yes, with one qualification.** It is exactly right for rows 1 and 4. It is not the whole story for row 2: a duplicate remains possible in the narrow ambiguity where the SMTP server accepted the message but the client saw a failure. No consumer-side ledger can close that — it is a property of SMTP, not of this design — and the deterministic `messageId: <eventId>@order-to-cash` is precisely the right mitigation, since a duplicate then arrives bearing the same `Message-Id` and is attributable (and collapsible by a well-behaved client). The trade was made in the direction `domain-model.md` §6 points, and the code says so in its own headers rather than only in the progress file.

---

## Probe 4 — `fromBeginning`

**PASS. Changed to `false`, and the reasoning is sound for this consumer specifically.**

`main.ts:47` now sets `subscribe: { fromBeginning: false }`, with a long comment explaining why it is the **opposite** of Orders' `true`. The argument, which I agree with: the saga orchestrator *must* replay, because it owns a state machine and an order that predates it still has to reach a terminal state; Notifications owns no aggregate and no state machine, so a fact it never saw is simply a fact that gets no email — an omission, not an inconsistency.

The distinction it draws is the one that matters, and it is correct: the durable ledger prevents a **duplicate** send for a fact already processed, but it cannot prevent a **first** send for a fact this service has genuinely never encountered. Those are different failure modes, and only `fromBeginning: false` addresses the second. Without it, pointing this service at topics carrying months of history would mail every historical order once — legitimately, by the ledger's own logic, which is what makes it dangerous rather than merely wasteful.

Cross-checked against my own probe: run 4 forced `fromBeginning: true` and still sent zero, so the two fixes are genuinely independent and the ledger is not leaning on the subscription setting.

The integration spec keeps `fromBeginning: true` for a stated local reason (brand-new topics, publishing only after group readiness, so the value is unobservable) and says so inline. Correct — a test that silently depended on production's setting would be the worse choice.

---

## Probe 5 — credentials hygiene, re-run

**PASS. Both `.env` files changed this round; the sweep is clean.**

Live `MAILTRAP_USER` / `MAILTRAP_PASSWORD` values (14 chars each, never printed) searched for as literals:

- Whole working tree excluding `node_modules`, `dist`, `.git` and `.env` itself → **zero files**.
- `apps/notifications/**` specifically, including the new `drizzle/0000_sharp_rattler.sql`, `drizzle/meta/*`, `drizzle.config.ts`, `db-config.ts` and the Testcontainers fixture → **zero**.
- `git log --all -S<user>` and `-S<password>` → **zero commits**. Never introduced, never removed.
- `progress/impl_notifications_service.md` → **0 occurrences** of each.
- `git ls-files .env .env.*` → only `.env.example` is tracked; `.env.example:213-217` still carries `replace_me` placeholders.
- The new `.env.example` MySQL and Kafka additions are config keys and hostnames only — `MYSQL_DB_NOTIFICATIONS=otc_notifications`, `NOTIFICATIONS_DB_HOST=localhost`, `NOTIFICATIONS_KAFKA_CLIENT_ID`, `NOTIFICATIONS_CONSUMER_GROUP`. No secret material.

The N10 warning added at `.env.example:124-131` is accurate: it names the consumer-group knob as the trigger of the historical incident, and correctly states that the durable ledger now prevents a duplicate send even so, without overclaiming that changing it is therefore routine.

---

## Probe 6 — infra scope, and the fresh-volume question

**PASS on both halves.**

**Scope.** `git status --porcelain` is confined to exactly the granted set: `apps/notifications/**`, `feature_list.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `docker-compose.infra.yml`, `infra/mysql/init/01-create-databases.sh`, `.env.example`, `progress/`. Explicitly checked and **empty**: `apps/orders`, `apps/fulfillment`, `apps/billing`, `apps/projector`, `apps/gateway`, `apps/web`, `apps/seed`, `packages/`, `specs/`, `n8n/`. The OI12 spec in `apps/orders` is byte-unmodified — which matters, because it is the guard that now judges this service.

**The fresh-volume question — verified empirically, not by reading.** The coordinator is right that the live container's initialised volume never re-runs init scripts, so the live database being correct proves nothing about a clean clone. I therefore started a **disposable `mysql:8.4.11` container from an empty volume** with `infra/mysql/init` mounted at `/docker-entrypoint-initdb.d`, using the same environment `docker-compose.infra.yml` passes:

```
=== databases ===                     === app user grants ===
otc_billing                           GRANT ALL PRIVILEGES ON `otc_notifications`.* TO `otc_app`@`%`
otc_fulfillment                       (plus orders, fulfillment, billing, n8n)
otc_notifications
otc_orders
n8n
=== app user can create the ledger table in otc_notifications ===
rows_ok
1
```

The database is created, the grant is applied, and `otc_app` can create, insert, select and drop in it. **A clean clone — and assessments #8 and #9 — will get a working `otc_notifications` with no manual step.** The container was removed afterwards; the user's live MySQL volume was never touched.

The migration is also proven against a from-empty database independently of the live one: both of my integration probes ran `runNotificationsMigrations` against a brand-new Testcontainers MySQL and then read and wrote `processed_events` successfully.

**The table itself does not diverge.** `apps/notifications/drizzle/0000_sharp_rattler.sql` is byte-identical to the `processed_events` block of `apps/fulfillment/drizzle/0000_nappy_mad_thinker.sql` (`diff` → no output), and the Drizzle schema file's **code** is identical to Fulfillment's once comments are stripped (only the banner prose differs, which is correct and expected). Same `char(36)` ids, same `varchar(50)` consumer, same `uq_processed_events_event_consumer` unique constraint on `(event_id, consumer)` — and that unique index is what makes the canonical's insert-first serialisation work here exactly as it does in the other three services.

---

## Probe 7 — acceptance criterion 1, and whether the seven sends were real

**PASS on the honesty question. PASS on the "real adapter" question, verified independently.**

**Is the progress file plain enough?** Yes — it is stated three times and cannot be skim-read as satisfied:

- `impl:186` — the API-token search is reported as a *negative* result up front: "**no API token is reachable from this environment**".
- `impl:200` — "This is SMTP-acceptance evidence only... **Acceptance criterion 1 ... remains UNVERIFIED by me**", in bold, immediately under the table of seven, with the explicit instruction that the human must open the sandbox inbox.
- `impl:277-279` — a dedicated `### What remains unmet` section at the end of the document.

The seven subjects and seven `messageId`s are listed in full, so the human has exact search keys. That is the right shape for a carried item.

**Did the seven sends exercise the real adapter, or a stub?** The script itself is deleted, so I verified the *mechanism* it claims to have used, through the built `dist/` the script imported from:

```
binding.kind = mailtrap
host = sandbox.smtp.mailtrap.io | port = 2525 | fromEmail = no-reply@order-to-cash.example
user present: true | password present: true   (values not printed)
adapter a script would construct: MailtrapNotificationSender

placeholder binding.kind = console
```

So a script following the described path — real `.env` → `resolveNotificationSenderBinding` → construct the adapter — provably gets a real `MailtrapNotificationSender` over `sandbox.smtp.mailtrap.io:2525`, **not** the console stub; and the same function correctly returns `console` for the `.env.example` placeholders. Combined with `messageId` being genuinely forwarded to nodemailer's `sendMail` (`mailtrap-notification-sender.ts:36`, guarded by its own named test), the seven reported `messageId` values are values that really would have gone on the wire.

What remains genuinely unverifiable by any agent here: **arrival in the inbox**. Carried as **N12**.

**The N4 mitigation is fully wired.** `messageId` is set once, centrally, in `NotificationDispatchService.dispatch` (`:88`) rather than in seven templates; the `NotificationMessage` port carries it as optional (`:32`); the Mailtrap adapter forwards it only when present; and a named test asserts the exact `<eventId>@order-to-cash` form.

---

## Round-1 findings — disposition

| # | Round-1 finding | Status | Evidence |
|---|---|---|---|
| **N1** | In-memory ledger; 3 emails for one `eventId` | **CLOSED** | R2-P1: `TOTAL = 1` across four redelivery classes, real Kafka + real MySQL |
| **N2** | Reasoning inverted `saga.md` §6's layering | **CLOSED** | Durable ledger adopted; `impl:141-166` restates the reasoning correctly; the `§34 licence` argument is gone from the file headers |
| **N3** | `fromBeginning: true` + non-durable ledger = mail storm; mischaracterised in the record | **CLOSED** | `main.ts:47` → `false`, with a sound service-specific rationale; `impl:113` corrected **in place with the wrong sentence struck through, not deleted** — the right way to correct a record |
| **N4** | 1 of 7 facts, SMTP-accept only | **CLOSED as far as an agent can take it** | All seven sent; real adapter independently confirmed; `messageId` wired. Inbox verification carried → **N12** |
| **N5** | OI12 variant branch is text-only | **Leader's, not re-raised.** Note it is now load-bearing for three services (**N15**) | — |
| **N6** | check-then-work-then-mark | **CLOSED** | R2-P3: insert-first proven by observing the committed row from an independent pool inside `send()`; delete-on-throw proven end to end |
| **N7** | No cross-restart test | **CLOSED** | A `cross-restart (N7)` block now exists and was proven non-vacuous by the implementer's armed deletion (`expected 1 to be +0`); independently corroborated by R2-P1 |
| **N8** | Unbounded `Set` | **CLOSED** | The in-memory store is deleted |
| **N9** | Unescaped HTML | **CLOSED** | `escapeHtml` used in all seven templates (6-8 call sites each); armed (R2-P5) — passthrough kills two named tests, including the `paymentReference` case I specifically named |
| **N10** | Env vars undocumented | **CLOSED** | `.env.example:121-131`, with the warning |
| **N11** | `current.md` describes feature 22 | **Leader's, not re-raised.** Still open — see the C2 note | — |

---

## CHECKPOINTS re-walk (boxes that were empty in round 1)

- [x] **C4 — "tests would fail if the behaviour regressed."** Round 1's failing box. Now: OI12 fails on a gutted `runOnce`; the cross-restart integration test fails when the dedup branch is deleted; the N6 compensation and N9 escaping guards each fail when armed. Four independent guards, all confirmed non-vacuous, three of them by me directly.
- [x] **C5 — `progress/history.md` has an entry including the effort record.** Written by this review on approval.
- [x] **C7 — effort records complete and honest.** Both rounds recorded, including the mtime disclosure for the files my restores touched.
- [x] **C3 — architecture.** Database-per-service preserved: `otc_notifications` is its own logical database, one table, no cross-database access, no FK across a boundary. The leader's reasoning for choosing MySQL over my MongoDB suggestion is better than my suggestion was — R54 makes the projector the sole writer of the read model, and putting a dedup ledger on the Mongo server immediately before feature 24 would have blurred exactly that boundary. Domain purity intact (`domain/` is empty by design). ESLint exit 0, so the DI-token and explicit-`Transport` guards both hold on the new persistence wiring.
- [x] **C4 — integration tests hit real containers.** Verified by running my own: real Kafka *and* real MySQL, both Testcontainers, never mocked.
- [ ] **C2 — `progress/current.md` describes the active session.** Still describes feature 22 (**N11**, leader's). Not a feature defect and not a blocker on id 23, but the session cannot be *closed* cleanly until the leader resets it — flagging it here so it is not lost between the approval and the wrap-up commit.

`pnpm quality` was not re-run (implementer's record: exit 0, ten packages, notifications 70/70). I ran ESLint (exit 0) and `tsc --noEmit` (exit 0) on `apps/notifications` after restoring my mutations, plus 16 targeted unit tests, plus three bespoke integration probes.

---

## Findings surviving round 2

None blocking. Four items, all recorded for the leader rather than gating approval.

**N12 — Low, owner: the human. Acceptance criterion 1 needs a pair of eyes on the inbox.**
All seven facts were sent to `sandbox.smtp.mailtrap.io:2525` through a provably real `MailtrapNotificationSender`, and all seven were accepted at the SMTP level. Arrival in the sandbox inbox has not been confirmed, and cannot be by any agent in this environment (SMTP credentials only, no API token, no browser). The seven subjects and seven `messageId`s are listed at `impl:190-198` as search keys. **This must be checked before the wrap-up commit.** Approving with this open is a deliberate call: everything reachable by an agent is done and independently verified, the limitation is disclosed in three places, and the remaining step requires a human. It is carried, not closed.

**N13 — Low, owner: implementer (or a later hardening pass). A failing compensation masks the error that caused it.**
`notification-dispatch.service.ts:89-92`:
```ts
} catch (error) {
  await this.compensation.delete(envelope.eventId, CONSUMER);
  throw error;
}
```
If `compensation.delete` itself throws — database unreachable at exactly the moment the SMTP send failed, which is not an implausible correlation — that error propagates *instead of* `error`, and the ledger row survives. The consequences compound: the email is lost permanently (redelivery answers `'duplicate'`), and the operator sees a MySQL error in the logs where the real cause was SMTP. One `try`/`catch` around the delete that logs the compensation failure and rethrows the **original** error would fix both halves. Not blocking: the window is narrow and the outcome is a lost notification, not a lost fact.

**N14 — Informational. A stale comment.**
`apps/notifications/src/infrastructure/persistence/schema/processed-events.schema.ts:19-20` still describes the ledger as "append-only (a row is written once and never mutated)" — inherited from the services where that is true. In *this* service N6's compensating DELETE contradicts it. One line, but it is exactly the sort of inherited comment that misleads a later reader about an invariant they might then rely on.

**N15 — Informational. OI12 is now load-bearing for three services.**
`apps/notifications` deliberately has no unit test of `IdempotentConsumer` — the old one tested the removed ordering and was correctly deleted. The class's behaviour is now assured by OI12's byte-identity (divergence cannot land unnoticed) plus `apps/orders`' own tests of the canonical. That is a sound arrangement and I am not asking for a redundant copy. But it does mean the guard the leader is already briefing under N5 now carries the correctness of three services, and the case my round-1 report suggested — *a consumer constructed fresh over the same backing store still returns `'duplicate'`* — is precisely the property this feature depends on. Worth stating in that briefing.

**N5, N11** — the leader's, untouched, not re-raised as blockers per instruction.

---

## Verdict

**APPROVED.** `feature_list.json` id 23 → `done`. Entry appended to `progress/history.md` with the effort record for both rounds.

The thing worth keeping from this feature: **the round-1 defect and the round-1 guard failure had the same root cause** — a divergence was documented instead of being made impossible. The fix was not "write a better comment", it was to make the service structurally eligible for the comparison that already existed. A guard you can opt out of by not creating a file is a guard that will be opted out of.
