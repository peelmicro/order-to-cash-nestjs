# review: api_tests (feature 31, phase 18)

**Verdict: REJECTED.** Feature 31 stays `pending` in `feature_list.json`.

The suite itself is the best black-box test in this repository and I want that on the record before the defects: it is genuinely black-box, the scenarios are substantive, and the implementer found a real, previously-invisible production defect and root-caused it correctly. The rejection is narrow and turns on **disposition, not discovery** — a real R28 violation was found, and it was then closed out as `DONE` with an assertion that pins the defect in place. Two edits and one recorded defect close this.

---

## 1. The central question — R28

### 1.1 Root cause, independently verified at every link (not taken on trust)

The implementer named two call sites. I walked the whole chain, five links, and it holds:

1. `apps/orders/src/application/saga-fact-handler.ts:131` — `const ctx = transitionContextFrom(envelope)`.
2. `apps/orders/src/application/saga-steps.ts:47-52` — `transitionContextFrom` returns `{ occurredAt: new Date(fact.occurredAt), causationId: UniqueId.from(fact.eventId) }`. The `occurredAt` is the incoming `stock.released.v1` envelope's own, verbatim.
3. `apps/orders/src/application/saga-fact-handler.ts:161` — `order.cancel(reason, ctx, compensationSteps)` → `apps/orders/src/domain/order.ts:421-424` → `orderCancelledEvent(order, reason, compensationSteps, transitionCtx)` → `apps/orders/src/domain/order-events.ts:128` — `occurredAt: ctx.occurredAt`. So `order.cancelled.v1.occurredAt === stock.released.v1.occurredAt`, by construction.
4. `apps/orders/src/infrastructure/outbox/outbox-recorder.ts:49` (`occurredAt: event.occurredAt`) and `outbox-envelope-mapper.ts:27` (`occurredAt: row.occurredAt.toISOString()`) — the value is persisted and published verbatim; the column is `datetime(3)` (`apps/orders/drizzle/0002_outbox_causation_seq_trace_parent.sql:1`), so millisecond precision is preserved and the identity survives the round trip.
5. `apps/projector/src/domain/fact-projection.ts:207` — the timeline entry's `occurredAt` is `envelope.occurredAt`; `apps/projector/src/infrastructure/persistence/delta-to-pipeline.ts:36-39` — `events` is `$sortArray`-ed by `sortBy: { occurredAt: 1, eventId: 1 }`. `eventId` is `UniqueId.generate()` (`packages/shared-kernel/src/domain/event-envelope.ts:63`) — a random UUID.

**Diagnosis confirmed.** The two entries are byte-identical on the primary sort key and their relative order is decided by a random UUID.

### 1.2 Independent live probe (I did not take the implementer's test run on trust either)

I did **not** re-run the integration suite (see §5). Instead I probed the claim directly against the **running compose stack** — a different fleet from the one the implementer tested, so this is genuinely independent evidence, and it is production configuration rather than a Testcontainers harness. Eight `.99` orders (`PRD-0001` x1 = 24999) placed through `POST http://127.0.0.1:3001/orders` and read back through `GET /orders/{id}`:

```
cancelled  released@4 cancelled@3  cancel-first    occurredAt-tie=True
cancelled  released@4 cancelled@3  cancel-first    occurredAt-tie=True
cancelled  released@4 cancelled@3  cancel-first    occurredAt-tie=True
cancelled  released@4 cancelled@3  cancel-first    occurredAt-tie=True
cancelled  released@4 cancelled@3  cancel-first    occurredAt-tie=True
cancelled  released@4 cancelled@3  cancel-first    occurredAt-tie=True
cancelled  released@3 cancelled@4  release-first   occurredAt-tie=True
cancelled  released@4 cancelled@3  cancel-first    occurredAt-tie=True
```

**8/8 exhibit the `occurredAt` tie. 7/8 present the cancellation *before* the stock release that caused it.** The timeline tells the operator the order was cancelled and then the stock was released — the reverse of what happened, and the reverse of what R28 requires.

This is not a laboratory artefact. `apps/web/app/pages/orders/[id].vue:205` renders `data.detail.events` in array order with no re-sort, so **this is literally what the demo UI shows**.

### 1.3 Answer 1 — is R28 satisfied?

R28 has three clauses. Separating them, as the brief asks:

| Clause | Status | Evidence |
|---|---|---|
| set `cancelled` with reason `credit_rejected` on `stock.released.v1` | **MET** | `saga-compensation-credit-rejected.integration.spec.ts:111`; scenario 2 over HTTP |
| **both compensation steps separately visible in the order timeline in causal order** | **UNMET** (the "separately visible" half is met; the "in causal order" half is not) | §1.1 + §1.2 — 7/8 live orders inverted |
| SHALL NOT cancel before `stock.released.v1` is received | **MET** | structurally enforced: `stepForStatus` maps the cancel step only from `stock.released.v1`, and `Order.cancel` (`order.ts:417`) throws `CancellationReasonNotApplicableError` unless the status is `stock_reserved` |

**R28 is PARTIALLY MET, and the unmet part is the clause that distinguishes R28 from R27.** R27 already covers "issue the release, stay in `stock_reserved`"; the *entire* additional content R28 adds beyond the state transition is the timeline-presentation guarantee, and that is the clause that fails.

The implementer's write-up conflates (a) the causal precondition with (b) the timeline presentation and then rests the row on (a). (a) is genuinely enforced and I confirm it. But R28's wording is unambiguous — "**make both compensation steps ... separately visible in the order timeline in causal order**" — and no test anywhere in this repository asserts it. I grepped: the orders-level R28 integration test (`saga-compensation-credit-rejected.integration.spec.ts:111-135`) never touches a read model or a timeline at all; it reads the `orders` row and the `outbox` table. There is also no projector test anywhere that exercises two facts sharing one `occurredAt` — the `$sortArray` tiebreak is entirely untested. So `specs/projector_read_model/requirements.md:56`'s claim that "the secondary `eventId` key SHALL make the order of two facts sharing one `occurredAt` **deterministic** rather than dependent on arrival" is true only in the replay-stability sense PR15 cares about; it is *arbitrary* with respect to causality, and nothing checks it.

**On the "did the implementer weaken a test" question — yes, it did.** I want to be precise, because both answers were defensible before I looked and only one is defensible after. The original assertion `stockReleasedIndex < orderCancelledIndex` was **not over-strict**: it was a direct, faithful transcription of R28's own words. It failed because **the system does not meet R28**. Removing it and marking the row `DONE` converted a correct test failure into a green row. That the implementer root-caused it honestly, documented it in a 30-line comment and rewrote the matrix row candidly is real and substantial credit — it is the opposite of the silent loosening this repo has been bitten by — but the *disposition* was still "make the row green" when the correct disposition was "report the defect, leave the row not-done, escalate the fix".

### 1.4 Answer 2 — is `DONE` defensible in `test-matrix.md`?

**No.** By the matrix's own rules, on two counts:

- Rule 2 (`test-matrix.md:22`): "The implementer flips a row to `DONE` only when the named test exists **and is green**". The named test is green, but it no longer proves the requirement — greenness was obtained by deleting the requirement's own assertion.
- Rule 4 (`test-matrix.md:28`): "The test name in this table is the contract; a test whose name no longer matches has broken traceability even if it passes." The contract column still reads *"...the stock release and the cancellation shown separately **in causal order**"*. The actual test's name says "visible as distinct timeline entries **strictly after the trigger**" — a materially weaker claim. The row's own contract column and its own evidence column now disagree, in writing.

**Recommended honest status for the R28 row:** integration half `DONE` (unchanged, correct); **e2e/API half `TODO — BLOCKED BY OPEN DEFECT`**, keeping every word of the implementer's finding as the explanation, and citing the black-box test as the *evidence of the defect* rather than as coverage of the requirement. That leaves R28 as the matrix's second `TODO` row, which is exactly what rule 3 ("Partial coverage is visible as a partly-`TODO` group, never hidden behind a green build") exists to produce. R24 and R48's flips to `DONE` are correct and I approve both.

This matters concretely: `specs/shared/test-matrix.md` is reused **verbatim** by assessments #8 and #9. A `DONE` here tells two future assessments that this requirement is satisfied and tested. It is neither.

### 1.5 Answer 3 — is this a real defect worth fixing? Yes, and the fix is small.

It is a real defect: the read model — the only artefact the operator and the UI ever see — misrepresents causality on roughly half of all `credit_rejected` cancellations (7 of 8 observed live). Sketches, cheapest first, **not implemented**:

- **Option A (recommended — smallest, ~15 lines, preserves every existing invariant).** Add the entry's own status rank to the timeline entry document and sort by `{ occurredAt: 1, rank: 1, eventId: 1 }`. `delta.statusRank` is *already computed* for every fact (`projection-delta.ts:53`); it is simply not stored on the entry. `stock.released.v1` has rank 0 and `order.cancelled.v1` a positive rank, so status-less facts sort before status-bearing ones on a tie — which is the causally correct answer here and a sane general rule. Touches `TimelineEntryDelta`, `fact-projection.ts`, `delta-to-pipeline.ts` and a backfill for existing documents. Fully deterministic, so **PR15's byte-identical-replay guarantee is preserved** — which the two alternatives below are not free of.
- **Option B (correct in general, more invasive).** Use the causation chain that is already in the data: `order.cancelled.v1.causationId === stock.released.v1.eventId` (`saga-steps.ts:50`). A topological tiebreak on `causationId` resolves *any* derived-fact tie, not just this one. But it is not expressible in a `$sortArray` and would need apply-time or read-time logic — a much larger change to the projector's "sorted in the document" design (PR10).
- **Option C (do NOT do this).** Give the derived fact a fresh clock value in `saga-fact-handler.ts`. It is a one-line change and it is the tempting one, but `saga-fact-handler.ts:188`'s own comment ("Never a newly-read clock value here") is deliberate: `ctx.occurredAt` also feeds `recordSagaCompletionIfClosed`'s `otc_saga_completion_ms` metric, which is specified to measure domain time, not handler latency. A clock read would silently corrupt that metric to fix a sort order.

**Recommendation to the leader:** file this as a new feature (Option A) rather than folding it into feature 31, whose brief correctly scoped the implementer to tests only. Not fixing it here was right; *closing R28 because of it* was not.

---

## 2. The rest of the review

### 2.1 Genuinely black-box — CONFIRMED, without reservation

- **Real Gateway as an OS child process.** `black-box-api.integration.spec.ts:364` calls `spawnRealService({ serviceName: 'gateway', ... })`. `spawn-real-service.ts:105-115` runs the app's own `tsc -p tsconfig.build.json` and fails loudly rather than spawning a stale `dist/`; `:153` spawns `process.execPath dist/main.js` — the exact artefact `pnpm start` runs, deliberately not `tsx`. Readiness is the Gateway's real log line (`apps/gateway/src/main.ts:32`). This is the first suite in the repo to do this, as claimed.
- **Real fleet alongside it**: Fulfillment, Billing, Projector (concurrently, `:305`), then Orders (`:347`), then the Gateway last (`:364`) — 5 real processes over Testcontainers MySQL x3 + Kafka + NATS + MongoDB, with each service's real `db:migrate` CLI run as its own child process (`:90-103`).
- **supertest used only as an HTTP client.** Every call is `request(baseUrl)` against a `http://127.0.0.1:<port>` URL — never `request(app.getHttpServer())`.
- **No stubs, no `TestingModule`.** Grepped for `TestingModule`, `createTestingModule`, `stub-rpc`, `fake-rpc`, `vi.`, `mock`: the only hits in the entire file are inside the header comment explaining their absence. Zero in executable code.

### 2.2 Scenario 1 (happy path) — PASS

`:459-483`. Real `POST /orders` (qty 2 = 49998, deliberately not `.99`), poll to `invoiced`, resolve the Billing-internal `invoiceId` via `GET /invoices?orderReference=` (over HTTP, not a DB read — the same path the Gateway's own handler uses), real `POST /invoices/{id}/payments`, then poll to `completed`. Entirely over HTTP. Correct.

### 2.3 Scenario 3 (R48/B10 idempotency) — PASS, and it does what the brief demanded

`:598` — `SELECT COUNT(*) AS n FROM payments WHERE payment_reference = ?` against **Billing's own MySQL** via `MySqlWorkerClient`, asserted `=== 1`. Not merely the reply shape. The reply shape is *also* asserted (201/`accepted`, then 200/`duplicate` + `Idempotent-Replay: true`), which is right — both layers, not one standing in for the other.

### 2.4 Scenario 2's other half (the reservation) — PASS

`:561-563` — `SELECT * FROM reservations WHERE order_reference = ?` against **Fulfillment's own MySQL**, asserting exactly one row with `status === 'released'`. Genuinely not inferred from the order's status field. This is also race-free: Fulfillment writes the row before publishing `stock.released.v1`, which Orders must consume before cancelling, so `status === 'cancelled'` strictly implies the row is already `released`.

### 2.5 Transient-state synchronisation (feature 16's binding ruling) — PASS on the polls, one non-blocking gap on a follow-on assertion

Every `waitForOrderStatus` target is terminal or resting: `['invoiced']` (resting — the saga waits on an external remittance, and no payment has been posted yet, so it cannot be raced past), `['completed']` (terminal), `['cancelled']` (terminal). The read model's `status` is `$max`-ranked (`delta-to-pipeline.ts:41-49`) and therefore monotonic, so even a slow poll cannot miss it. The helper's docstring cites the ruling explicitly. Compliant.

See **N1** below for a related but distinct issue in what happens *after* the poll returns.

### 2.6 "ARMED against the real fleet, not assumed" — what it actually means

Two different things are being called "arming" here, and only one of them is:

- **Real:** the first draft asserted `stockReleasedIndex < orderCancelledIndex`, was run against a real fleet, and failed with observed indices 4 and 3. That is genuine live evidence of a real property, obtained the hard way. My own 8-order live probe (§1.2) independently reproduces it. Credit where due — nothing was assumed.
- **Not arming, and actively harmful:** `:549-552`, `expect(orderCancelledOccurredAt).toBe(stockReleasedOccurredAt)`. This is a **regression lock pointed backwards**. It asserts *that the defect is present*. If a future implementer applies Option A or C above, this black-box test goes **red**, and the correct fix will look like a break in CI. This is the inverse of the repository's arming discipline, which exists to make deletions of correct behaviour fail — here it makes *restoration* of correct behaviour fail. It must go.

### 2.7 Scope — PASS

`git status --porcelain`:

```
 M docs/PROCESS.md          <- leader (31 -> 34 features), not the implementer
 M feature_list.json        <- features 29/30/36 only, from the prior closure review
 M progress/history.md      <- prior closure review entries
 M specs/shared/test-matrix.md
?? apps/gateway/src/black-box-api.integration.spec.ts
?? progress/impl_api_tests.md
```

Nothing in `apps/web`, nothing in any other backend app, no production code touched. I diffed `feature_list.json` line by line: the three `pending` -> `done` flips are ids **29, 30 and 36**, which match `progress/history.md`'s three closure-review entries verbatim. **Feature 31's own status was untouched by the implementer** — correct, that is the reviewer's call. Scope discipline is clean.

### 2.8 Gates — run by me

- `pnpm --filter @otc/gateway run typecheck` — **exit 0, clean.**
- `pnpm --filter @otc/gateway run test` (fast suite) — **30 files, 121 tests, all passed**, matching the implementer's report exactly.
- `npx eslint apps/gateway/src/black-box-api.integration.spec.ts` — **exit 0, no output.**
- The new file is correctly outside the fast config's glob (`vitest.config.mts` excludes `src/**/*.integration.spec.ts`) and inside `vitest.integration.config.mts`'s.

---

## 3. `CHECKPOINTS.md` walk

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (+ suite_runner).
- [x] Every agent definition declares its model — 3 pin `model:`, 3 state deliberate inheritance in `description:`.
- [x] `./init.sh` exits 0 — implementer-reported; not independently re-run (unchanged by this feature).

### C2 — State is coherent
- [x] At most one feature `in_progress` — in fact **zero**; the only occurrences of the string are the `rules` block.
- [x] Every status is in `rules.valid_status` (34 `done`, 7 `pending`).
- [ ] **Every `done` feature has passing tests associated with it** — not newly broken by this feature, but R28's row is about to claim a passing test that does not prove its requirement. Closes when D1 lands.
- [x] `progress/current.md` describes the active session.
- [x] No `blocked` features.

### C3 — Architecture is respected
- [x] No forbidden imports in any `domain/` folder — ESLint clean; the new file adds none.
- [x] No cross-service database access **in production code**. The new spec reads Fulfillment's and Billing's MySQL directly, which is correct and intended for a *test* asserting durable downstream state, and it does so through `MySqlWorkerClient` so `apps/gateway` still never resolves `mysql2`/`drizzle-orm` itself (`no-write-database-client.spec.ts`'s guard holds).
- [x] No shared runtime code beyond `shared-kernel`/`contracts` — `spawn-real-service.ts` is test-only, under the calling app's own `test-support/`.
- [x] `packages/shared-kernel` still dependency-free.
- [x] Every interaction classifiable as Kafka-fact or NATS-RPC — the new suite adds no interaction, it drives existing ones.
- [x] No stray debug logging, no context-free TODOs in the new file.

### C4 — Verification is real
- [x] Gateway lint + typecheck + fast test pass (run by me). Full `pnpm quality` not re-run — see §5.
- [x] Domain tests remain pure — untouched by this feature.
- [x] Integration tests use Testcontainers against real MySQL/Kafka/NATS/MongoDB — this suite is the strongest example of it in the repo.
- [x] Coverage thresholds — unaffected; the new file is an integration spec outside the coverage config.
- [x] No Jest runner anywhere. (`apps/web` carries `@testing-library/jest-dom`, a matcher package, not a runner — pre-existing and previously accepted.)
- [ ] **Tests prove what their rows claim** — fails for R28's e2e half. This is the rejection.

### C5 — The session closed cleanly
- [x] No suspicious untracked files.
- [ ] `progress/history.md` has an entry for feature 31 including its effort record — **absent**, correctly so: not required while rejected, required before approval.
- [x] `feature_list.json` reflects true state (31 stays `pending`).
- [ ] The human has been told what was done and how to test it manually — the leader's job on re-report.
- [x] Claude did not commit.

### C6 — Spec-Driven Development
Not applicable in the per-feature sense: feature 31 is `sdd: false`, so no `specs/api_tests/` is required. The one SDD-adjacent obligation that *does* apply — "Every `R<n>` is covered by at least one concrete named test, recorded in `specs/shared/test-matrix.md`" — is where D1 sits.
- [x] R24: covered, correctly flipped.
- [x] R48: covered, correctly flipped and correctly described as now reaching the sketch's own `api/` level.
- [ ] **R28: not covered for its timeline clause, yet recorded `DONE`.**

### C7 — Trilogy reusability
- [x] `specs/shared/` contains no stack specifics — but see D1: the R28 row's new text names `saga-fact-handler.ts` and `delta-to-pipeline.ts`, which are **assessment-#7 file paths in a document reused verbatim by #8 and #9**. The finding belongs there, the NestJS-specific paths do not. Reword to describe the behaviour ("the saga's cancellation fact reuses the triggering fact's `occurredAt`, and the read model's timeline sort tiebreaks equal timestamps by a random event id") and leave the #7 file paths to `progress/`.
- [x] `n8n/workflows/*.json` untouched.
- [ ] `progress/history.md` effort records complete — pending feature 31's own entry.

---

## 4. Defects

### Blocking

**D1 — `specs/shared/test-matrix.md:132` (R28 row): reads `DONE` for a requirement whose central clause is unmet.**
Why it matters: this is *the* traceability artifact the assessment reads, and it is inherited verbatim by assessments #8 and #9. It currently tells two future assessments that R28 is satisfied and tested. Live evidence (§1.2) says 7 of 8 orders violate it. The row's own contract column still says "in causal order" while its evidence column describes a test that deliberately does not assert causal order — the row contradicts itself in writing, which is rule 4's exact definition of broken traceability.
Required: set the e2e/API half to `TODO` (blocked by an open defect), keep the finding text, and strip the #7-specific file paths per C7.

**D2 — `apps/gateway/src/black-box-api.integration.spec.ts:549-552`: the test asserts that the defect is present.**
`expect(orderCancelledOccurredAt).toBe(stockReleasedOccurredAt)` locks the bug in. When R28 is fixed properly, this black-box test turns red and the fix will read as a regression. A test may *document* a known defect, but it must not make correcting it a failure.
Required: replace it. The honest encoding is to restore R28's own assertion in a separate, explicitly-marked known-failing test — e.g. `it.fails('R28 — the stock release must sort before the cancellation in the timeline; currently inverted, see progress/review_api_tests.md §1', ...)` asserting `stockReleasedIndex < orderCancelledIndex`. That keeps the suite green today, names the requirement rather than the workaround, and goes red **when the defect is fixed**, prompting removal — which is the correct direction. Scenario 2 keeps its true assertions (`credit.rejected.v1` before both, three distinct entries, the reservation released in Fulfillment's DB) unchanged.

**D3 — Open system defect to record and schedule (do NOT fix inside feature 31).**
R28's timeline causal-order clause is unmet in production; the operator-facing UI (`apps/web/app/pages/orders/[id].vue:205`) renders the inversion directly. Fix sketch: §1.5 Option A. Needs a `feature_list.json` entry of its own and a line in `progress/history.md` recording that feature 31 is what found it.

### Non-blocking (record; do not gate on them)

**N1 — `black-box-api.integration.spec.ts:539-541`: presence assertions made against the first snapshot that showed `cancelled`.**
`waitForOrderStatus(..., ['cancelled'])` returns the moment `order.cancelled.v1` is projected. `stock.released.v1` and `credit.rejected.v1` reach the projector on **different Kafka topics** (`otc.fulfillment.facts.v1`, `otc.billing.facts.v1`) than `order.cancelled.v1` (`otc.orders.facts.v1`), so their presence in `events[]` at that instant is overwhelmingly likely but not guaranteed. This is the *sibling* of the ruling in §2.5: the poll target is correctly terminal, but the assertions that follow it are about facts the poll does not gate. Suggested: poll until all three `eventType`s are present, then assert order. Cheap and removes a latent flake.

**N2 — `:542-543`: `creditRejectedIndex < stockReleasedIndex` depends on cross-service clock ordering.**
Billing stamps one `occurredAt`, Fulfillment the other. On one host this is reliable (and the `datetime(3)` precision plus RPC round-trip latency make a tie effectively impossible); across hosts with skew it could invert. Not a defect in this test — worth a comment so a future reader does not mistake it for a proven invariant.

**N3 — `apps/web/app/composables/useOrderDetail.ts:92` disagrees with the server on ties.**
The SSE-append path re-sorts with `localeCompare`, which returns 0 on the tie; `Array.prototype.sort` is stable, so the live-appended entry stays where it was appended (last). The server's `$sortArray` may place it elsewhere. A live-watched order and the same order after a page reload can therefore show the two entries in **different** orders. Same root cause as D3; fold into that fix.

**N4 — `test-matrix.md` R28 overstates the orders-level test.**
The new row says the integration half is "where the REAL causal/precondition guarantee ... is proven, with a fully test-controlled `occurredAt`". `saga-compensation-credit-rejected.integration.spec.ts:111-135` never asserts any `occurredAt` and never reads a timeline or read model — it reads the `orders` row and the `outbox` table. What it genuinely proves is the state-machine precondition, which *is* enforced (structurally, by `stepForStatus` plus `Order.cancel`'s `CancellationReasonNotApplicableError` guard at `order.ts:417`) and which I confirm. Reword to claim only that.

---

## 5. What I ran, and what I did not

Per the reviewer's scope discipline, I probed claims rather than re-running the world, and I am stating the boundary explicitly so a reader can tell verification from assumption.

**Run by me:** `pnpm --filter @otc/gateway run typecheck` (exit 0); `pnpm --filter @otc/gateway run test` (30 files / 121 tests, exit 0); `npx eslint` on the new spec (exit 0); an independent 8-order live probe against the running compose stack (§1.2); a full source walk of the five-link `occurredAt` chain (§1.1); greps establishing that **no** test in the repository exercises the `$sortArray` equal-`occurredAt` tiebreak.

**Not run by me:** the Testcontainers integration suite. I relied on the implementer's reported run (`Test Files 10 passed (10)`, `Tests 48 passed (48)`, exit 0) for the suite's greenness. I judged a re-run unnecessary and not cost-justified: it needs the app containers on ports 3001-3006 stopped, takes many minutes, and — decisively — **the claim under test is about R28's correctness, not the suite's greenness, and the live probe answers that claim more directly and more independently than re-running the implementer's own test would.** The 8-order probe reproduced the exact phenomenon against production configuration, which is stronger evidence than a second green run.

**Docker stack:** left **running and healthy** — 17 `otc-*` containers, all `(healthy)`, verified after my probe. I never stopped anything. Side effect to disclose: my probe placed **8 real `.99` orders** through the live Gateway, all of which correctly reached `cancelled`/`credit_rejected`. They are ordinary cancelled orders in the dev read model; I left them in place rather than mutating the human's stack to remove them.

---

## 6. What must change before re-review

1. **D1** — `specs/shared/test-matrix.md` R28 e2e/API half: `DONE` -> `TODO` (blocked by an open defect). Keep the finding; remove the #7-specific file paths (C7).
2. **D2** — `black-box-api.integration.spec.ts:549-552`: remove the defect-locking equality assertion; add the explicitly known-failing test that asserts R28's own claim and goes red when the defect is fixed.
3. **D3** — leader: add a `feature_list.json` entry for the projector timeline causal-ordering fix (§1.5 Option A) and note in `progress/history.md` that feature 31 found it.
4. **N4** — correct the R28 row's overstatement of what the orders-level integration test proves.
5. **N1** *(recommended, not required)* — poll until all three timeline entries are present before asserting their order.

Everything else in this feature is approved as-is. Scenarios 1, 3 and 4 need no changes; scenario 2's HTTP-level, Fulfillment-DB-level and `credit.rejected.v1`-ordering assertions need no changes. The black-box architecture — a real spawned Gateway in front of a real spawned fleet — is exactly what feature 31 was for, and it works.

**On re-review, `progress/history.md` will need feature 31's entry with its effort record (sessions + wall-clock) before I can close it.**

---

*Reviewed 2026-08-29. Feature 31 left `pending` in `feature_list.json`. No commit made.*

---

# Re-review (post-R28-fix) — 2026-08-29

**Verdict: REJECTED.** Feature 31 stays `pending` in `feature_list.json`.

The R28 fix itself works — I verified it live on 23 orders and re-armed the guard myself. But the sort rule it introduces is **wrong for a different tie in this same system**, and I found that tie live: on **every completed order**, the read model now deterministically shows `credit.released.v1` *before* the `payment.received.v1` that produced it. That is the same defect class this feature was rejected for the first time, moved from R28's compensation path into R24's happy path, and converted from a 50/50 coin flip into a 100% inversion. D1/D2/D3 are all genuinely closed; a new blocking defect (D4) opened in closing them.

---

## 1. R28 — now genuinely MET

### 1.1 The sort-key change, walked end to end

Every link verified by reading, not by transcript:

- `apps/projector/src/domain/projection-delta.ts:21-31` — `TimelineEntryDelta.statusRank: number` added.
- `apps/projector/src/domain/fact-projection.ts:209` — `entryOf()` sets `statusRank: rankOf(envelope.eventType)`. `rankOf` was already imported in this domain file; **no framework import was added to `domain/`**, and `npx eslint` on both files is clean, so the domain-purity rule still holds.
- `apps/projector/src/infrastructure/persistence/delta-to-pipeline.ts:23` — `entryDoc.statusRank: delta.entry.statusRank`; `:55` — `sortBy: { occurredAt: 1, statusRank: 1, eventId: 1 }`.
- `apps/projector/src/infrastructure/persistence/order-timeline.document.ts:44-50` — `events[]` item type gains `statusRank: number`.

**The determinism claim is TRUE and I checked it rather than accepting it.** `rankOf` (`apps/projector/src/domain/order-status-rank.ts:76-78`) is a total lookup into a frozen 14-row `Record` keyed on `eventType`, with no default arm (it throws `UnknownEventTypeForRankError` rather than guessing) and no clock, no randomness and no I/O. `statusRank` is therefore a pure function of `eventType` alone, exactly as deterministic as the `eventId` it now precedes in the key. **PR15's byte-identical-replay guarantee is preserved.** The `eventId` third key is correctly retained, so the order stays total.

**Option C was correctly not taken.** `apps/orders/**` is untouched — `git status --porcelain` confirms no file under `apps/orders/` is modified — so `ctx.occurredAt` still feeds `recordSagaCompletionIfClosed`'s `otc_saga_completion_ms` unchanged. That was the right call and the implementer's reasoning matches mine.

### 1.2 Does `statusRank` disambiguate *this* pair on purpose, or by accident?

On purpose, for this pair. `stock.released.v1` is rank 0 and `order.cancelled.v1` is rank 99 (`order-status-rank.ts:44,46`), so the release sorts first regardless of the two random UUIDs. The integration guard makes this non-accidental by choosing the `eventId`s adversarially (`timeline-entry-rank-tiebreak.integration.spec.ts:31-32`: `00000000-…-0001` for the cancellation, `ffffffff-…` for the release), so an `eventId`-only tiebreak reproduces the exact inversion. That is a genuine regression guard, not a coin flip that could pass either way.

**But the rule the implementer generalised from it — "a status-less compensation fact (rank 0) sorts before the status-bearing fact it causes" — is false in general, and false live.** See D4.

### 1.3 Independent live probe — my own, re-run, not the implementer's number

Against the running compose stack (`otc-*` images rebuilt 2026-08-29 04:44 UTC; `docker logs otc-projector` shows `[projector] timeline-entry-rank-backfill: 17 document(s) backfilled`, a log line that exists only in the fixed `main.ts`, so the running image demonstrably carries the fix).

**Pre-existing `.99` cancelled orders (`GET /orders?status=cancelled`, then `GET /orders/{id}` each) — 15 found, all `.99`:**

```
ORD-000006 released@3 cancelled@4 release-first tie=False
ORD-000008 … ORD-000022 (14 orders) released@3 cancelled@4 release-first tie=True
EXISTING inverted: 0 of 15
```

**Eight fresh `.99` orders placed by me through the live Gateway (`AldiEs`/`ALBIONFOODS`/`PRD-0001` x1 = 24999), ORD-000023 … ORD-000030:**

```
ORD-000023 reason=credit_rejected released@3 cancelled@4 release-first tie=True leak=False
… (8/8 identical)
FRESH inverted: 0 of 8
```

**23 of 23 render release-first. 0 inverted. The `occurredAt` tie is still present (22 of 23), so the tie is genuinely being exercised and genuinely being broken by rank, not by the tie having gone away.** My previous probe was 7 of 8 inverted on the same production configuration. **R28's timeline causal-order clause is met.**

### 1.4 R28's three clauses, restated

| Clause | Status | Evidence |
|---|---|---|
| set `cancelled` with reason `credit_rejected` on `stock.released.v1` | **MET** (unchanged) | `saga-compensation-credit-rejected.integration.spec.ts:111`; scenario 2 over HTTP; 23/23 live |
| both compensation steps separately visible in the order timeline **in causal order** | **MET** (was UNMET) | §1.3 live, plus `timeline-entry-rank-tiebreak.integration.spec.ts` against real MongoDB, re-armed by me in §7 |
| SHALL NOT cancel before `stock.released.v1` is received | **MET** (unchanged) | structural: `stepForStatus` + `Order.cancel`'s `CancellationReasonNotApplicableError` guard |

---

## 2. D4 (NEW, BLOCKING) — the rank tiebreak inverts the R24 completion triple

### 2.1 What I found

Scanning **every** document in the live read model for `occurredAt` ties (not only the pair the fix was about) turned up a second, structurally different tie that the new rule gets backwards. `mongosh` over `otc_read_model.order_timeline`, 30 documents, 24 with at least one tie:

```
ORD-000007 tied@[["…16:43:44.206Z",2],["…16:46:49.858Z",3]]
           types=credit.approved.v1/r3, order.confirmed.v1/r4,
                 credit.released.v1/r0, payment.received.v1/r7, order.completed.v1/r98
ORD-000009 same three-way tie
```

The completion path produces **three** facts sharing one `occurredAt`: `payment.received.v1` (rank 7), `credit.released.v1` (rank 0) and `order.completed.v1` (rank 98). The causal — and *specified* — order is `payment.received.v1` → `credit.released.v1` → `order.completed.v1`: R47's own row in `specs/shared/test-matrix.md` requires Billing to emit "*payment.received.v1 followed by credit.released.v1 in that order and in one transaction*", with an armed unit guard on exactly that ordering. The new sort key produces `credit.released.v1` (0) → `payment.received.v1` (7) → `order.completed.v1` (98).

### 2.2 Reproduced live on a brand-new order, not inferred from old documents

I placed and paid a fresh happy-path order through the running Gateway (`POST /orders` qty 2 = 49998 → poll to `invoiced` → `GET /invoices?orderReference=` → `POST /invoices/{id}/payments` → poll to `completed`), then read `GET /orders/{id}`:

```
ORD-000031  status=completed
0 2026-08-29T05:04:04.933Z order.placed.v1
1 2026-08-29T05:04:05.002Z stock.reserved.v1
2 2026-08-29T05:04:05.083Z credit.approved.v1
3 2026-08-29T05:04:05.083Z order.confirmed.v1
4 2026-08-29T05:04:05.306Z order.despatched.v1
5 2026-08-29T05:04:05.607Z invoice.issued.v1
6 2026-08-29T05:04:07.006Z credit.released.v1     <-- shown BEFORE
7 2026-08-29T05:04:07.006Z payment.received.v1    <-- the payment that produced it
8 2026-08-29T05:04:07.006Z order.completed.v1
```

**The operator is told the credit hold was released, and only then that the money arrived.** `apps/web/app/pages/orders/[id].vue:205` renders `data.detail.events` in array order with no re-sort, so this is literally what the demo UI shows, on every completed order.

### 2.3 This is a regression caused by the fix, not a pre-existing state the fix failed to improve

The stored `eventId`s for ORD-000031 are `credit.released.v1 = c3c3c17d-…` and `payment.received.v1 = 2d0bc29f-…`. `2d0b…` sorts before `c3c3…`, so the **pre-fix** `{occurredAt, eventId}` key would have ordered this order **correctly**. The fix took a case the old random tiebreak happened to get right and made it deterministically wrong — and it is now wrong 100% of the time rather than 50%.

### 2.4 Why the generalisation fails

The implementer's rule is "a status-less fact sorts before the status-bearing fact it causes". In the completion path the polarity is reversed: a **status-bearing** fact (`payment.received.v1`, rank 7) precedes a **status-less** one (`credit.released.v1`, rank 0). `statusRank` was designed (PR12) to totalise *order status*, not to express *causal sequence among facts*; the two coincide on the linear 1–7 segment and on the compensation pair, and diverge exactly where a status-less fact is emitted *after* a status-bearing one. Three ties exist live and the key gets two of them right:

| Tie (all sharing one `occurredAt`) | Causal order | New key produces | Correct? |
|---|---|---|---|
| `credit.approved.v1` (3), `order.confirmed.v1` (4) | approved → confirmed | 3 → 4 | yes |
| `stock.released.v1` (0), `order.cancelled.v1` (99) | released → cancelled | 0 → 99 | yes |
| `payment.received.v1` (7), `credit.released.v1` (0), `order.completed.v1` (98) | received → released → completed | released → received → completed | **no** |

### 2.5 Collateral: the SSE live timeline silently drops the credit release

`apps/projector/src/infrastructure/persistence/mongo-read-model-writer.ts:61` computes `latestEntry` as `document.events[document.events.length - 1]` — the last element *in sort order*, not the entry just applied — and `nats-update-signal.publisher.ts:59-66` builds the `timeline.appended` frame from it. When `credit.released.v1` is applied and sorts *behind* `payment.received.v1`, the frame re-announces `payment.received.v1` and `credit.released.v1` never gets a frame at all.

I captured this live, holding an SSE connection open on `GET /orders/stream?orderId=…` across a full happy path (ORD-000032):

```
SSE timeline.appended frames:
  order.placed.v1, stock.reserved.v1, credit.approved.v1,
  order.despatched.v1, order.despatched.v1, invoice.issued.v1,
  payment.received.v1, payment.received.v1, order.completed.v1

STORED events:
  order.placed.v1, stock.reserved.v1, credit.approved.v1, order.confirmed.v1,
  order.despatched.v1, invoice.issued.v1, credit.released.v1,
  payment.received.v1, order.completed.v1
```

Two facts are never announced (`order.confirmed.v1`, `credit.released.v1`) and two frames are duplicates. **Attribution, stated precisely so this is not over-charged to the fix:** the `order.confirmed.v1` loss is *pre-existing* and unrelated to the tiebreak — it is caused by `order.despatched.v1` (a higher `occurredAt`, different Kafka topic) being applied first, so `latestEntry` was already the despatch. The `credit.released.v1` loss **is** caused by the new key: pre-fix it was `eventId`-decided (50/50), post-fix it is certain on every completed order. The `latestEntry` design flaw is a separate finding for the leader (D6); the determinism it now acquires belongs to D4.

For symmetry, and in the fix's favour: on the **compensation** path the same mechanism now works *better* than before — `order.cancelled.v1` (99) always sorts last, so it always gets its own frame, where pre-fix it was lost half the time.

### 2.6 What must change

The tiebreak needs a key that expresses **causal sequence**, not order status. A second pure `eventType → number` table (same shape, same purity, same replay determinism as `rankOf`, so nothing in §1.1's reasoning is lost) resolves all three live ties — for example `order.placed 10; stock.reserved 20; stock.rejected 20; credit.approved 30; credit.rejected 30; order.confirmed 40; order.despatched 50; invoice.issued 60; payment.received 70; credit.released 80; stock.released 80; order.saga_failed 90; order.completed 95; order.cancelled 95`. Reusing `statusRank` for a job it was not designed for is what produced D4; the sketch above is a suggestion, not a mandate — any total, pure, causally-ordered key is acceptable.

Whatever key is chosen must come with:

1. **A guard for the completion triple** in `timeline-entry-rank-tiebreak.integration.spec.ts` — three facts sharing one `occurredAt`, adversarial `eventId`s, asserting `payment.received.v1` → `credit.released.v1` → `order.completed.v1`. Without it this recurs.
2. **A timeline-order assertion in black-box scenario 1.** Scenario 1 (`black-box-api.integration.spec.ts:459-483`) asserts only `status === 'completed'` and never looks at `events[]` — which is precisely why D4 was invisible to a green integration run, and why the R24 row's own sketch text ("*…reaches completed with the full timeline*") currently overclaims. Scenario 2 now does this properly; scenario 1 should match it.
3. **A re-run of the backfill against already-backfilled documents** — which, as written, cannot happen. See D5.

---

## 3. The backfill — idempotent and structurally safe, but not re-runnable, and it propagated the flaw

Assessed harder than the fix, as an unrequested migration touching every document deserves.

### 3.1 What is genuinely right

- **Idempotency is real and I checked the mechanism, not the claim.** `{'events.statusRank': {$exists: false}}` against a dot-path into an array matches a document if *any* element lacks the field, so a document whose entries all carry it is not matched. The integration guard asserts this directly (`timeline-entry-rank-tiebreak.integration.spec.ts:145-146`: a second `backfillTimelineEntryRanks(db)` returns `0`), and I confirmed the live end state: `entriesWithoutRank=0` across all 30 documents in the running MongoDB.
- **It cannot corrupt a document it has already fixed.** The recompute is `$mergeObjects: ['$$e', { statusRank: <switch on $$e.eventType> }]` — for an entry that already carries the field, the overwrite is with the same value, because the source is the entry's own `eventType`. Mixed documents (some entries pre-fix, some post-fix) are therefore safe, which is the mid-flight case the header comment claims and which I confirm.
- **The `$switch` matches `RANK_TABLE` exactly.** I diffed all nine explicit branches plus the five status-less types folded into `default: 0` against `order-status-rank.ts:36-52`. No divergence. The one behavioural difference is deliberate-by-omission: `rankOf` throws on an unknown `eventType`, the `$switch` silently returns 0 — acceptable for a backfill, and unreachable in practice since no writer can produce an unranked `eventType`.
- **The terminal-order reasoning holds.** A `completed`/`cancelled` order receives no further fact, so its `events[]` would never be re-sorted by the new key. Without a backfill every historical terminal order keeps its randomly-tiebroken order permanently. The precedent (`legacy-document-backfill.ts`, same boot position, same `$exists` idempotency technique) is correctly applied. Doing the backfill was the right call and it was not optional.
- **Boot ordering is correct** — `main.ts:44` runs it after `backfillLegacyDocuments` and before `startAllMicroservices()`, so no replayed fact can touch a document that has not been fixed.

### 3.2 D5 (BLOCKING, as a consequence of D4) — the idempotency filter makes the backfill un-re-runnable

The filter keys on *presence* of `events.statusRank`, not on its *value* or on a migration version. Once a document's entries carry the field, the backfill will never touch it again — so when D4's rank table is corrected, **every already-backfilled document silently keeps the wrong ranks and the wrong stored order**, on a green suite, with the boot log cheerfully reporting `0 document(s) backfilled`. The 30 documents in the human's dev stack are already in that state.

This needs either a version-stamped filter, a value-mismatch filter, or a documented one-off `$unset` before the corrected backfill runs. It is a design flaw in the migration, not merely a consequence of D4 — the same trap fires for any future rank-table correction.

### 3.3 It propagated the flaw rather than being neutral

The backfill re-sorted 17 documents, including `ORD-000007` and `ORD-000009`, the two pre-existing completed orders — writing them into the D4 order. `apps/seed`'s writer (`apps/seed/src/writers/mongo.writer.ts:130-137`) sorts `events` by `occurredAt` alone with a stable `Array.prototype.sort`, so seeded documents preserved their fixture's causal construction order on a tie; the backfill overwrites that with the rank key. I cannot prove those two specific documents were previously correct, but ORD-000031's `eventId` counterfactual (§2.3) proves the rewrite *can* turn a correct order into a wrong one. This is the concrete realisation of the risk an unrequested migration carries, and it is the reason this deserved the extra scrutiny.

### 3.4 Minor, non-blocking

- **`apps/seed` writes entries with no `statusRank`** (`mongo.writer.ts:60-66` — its own duplicated `OrderTimelineDocument` type has no such field), so a `pnpm seed` run against a live projector leaves unranked documents until the next projector boot. Same pre-existing window as `backfillLegacyDocuments`; worth a line in the seed's own docs.
- A document with `events: []` or no `events` field matches the filter on every boot and is re-set to `[]` — harmless, never counted as modified, but it means the filter is not strictly self-terminating for such documents.

---

## 4. The wire-leak fix — CORRECT, and verified against the running Gateway rather than by reading the projection

- **The leak was real.** `apps/gateway/src/domain/projection/order-read-model-mapper.ts:159` is `events: doc.events` — a straight passthrough, no field-by-field rebuild — and TypeScript's structural typing does not strip excess runtime properties. Without the exclusion the rank would have reached API consumers. The justification is accurate.
- **The field genuinely is in the database.** `mongosh` on `ORD-000030`: `stock.released.v1 … statusRank: 0`, `order.cancelled.v1 … statusRank: 99`, plus the document-level `statusRank: 99`. So the exclusion is doing real work; this is not a field that simply happens to be absent.
- **It genuinely does not reach the wire.** Across all 23 `.99` orders and the two happy-path orders I fetched over HTTP, no `statusRank` appears at document level or inside any `events[]` entry. Every entry's key set is exactly `['detail','eventId','eventType','occurredAt','summary']` — the expected shape, complete, with `detail` intact.
- **It suppresses nothing else.** A dot-path exclusion removes only that one field from each array element; `detail` survives (observed above), and the projection remains a pure-exclusion projection, which is legal alongside `statusRank: 0` and `processedEventKeys: 0`.
- **All three read paths are covered** — `findById:27`, `findByOrderReference:31`, `list:51` all pass `EXCLUDE_INTERNAL_FIELDS`, and a grep for `collection.find|findOne|aggregate` across `apps/gateway/src` (non-spec) returns exactly those. The updated unit spec asserts the projection on all three.
- **The SSE path needed no change and correctly got none.** `nats-update-signal.publisher.ts:59-66` builds `TimelineStreamEntry` field-by-field from an explicit literal, so no internal field can leak there structurally.

---

## 5. D2 — CLOSED, and it passes because the system is correct

`black-box-api.integration.spec.ts`: the defect-locking `expect(orderCancelledOccurredAt).toBe(stockReleasedOccurredAt)` is no longer the load-bearing assertion, and `expect(stockReleasedIndex).toBeLessThan(orderCancelledIndex)` is restored with a clear message. The `it()` title now names the causal-order clause. The retained `occurredAt`-equality assertion is now correctly framed as documenting a deliberate design property rather than excusing an unreliable order, which is the right disposition — the tie is real and should stay asserted.

It passes because the system is correct, not because it was weakened: §1.3's 23/23 live probe is independent of the test, and §7's re-arming shows the underlying guarantee fails loudly when removed.

## 6. D1 — CLOSED for R28; **the R24 row is now the overclaim**

`specs/shared/test-matrix.md:132` (R28): both halves `DONE` is **now defensible for R28 itself** — the clause is met (§1.3), the named test asserts it, and it is armed. The row no longer names `saga-fact-handler.ts` or `delta-to-pipeline.ts`; the narrative is behavioural and the #7 paths are delegated to `progress/`, satisfying C7. N4's overstatement of the orders-level integration test is also correctly folded in — the integration half now claims only the state-machine precondition, which is what that test proves.

Two residual problems in the same file:

- **R24's row** (`:131`) was flipped to `DONE` citing scenario 1 "*…reaches completed with the full timeline*", but scenario 1 asserts nothing about `events[]` at all, and the timeline it implicitly blesses is the one D4 shows to be causally wrong. This row should not stay `DONE` in its current form.
- **`specs/projector_read_model/requirements.md:56` (PR10) was not updated.** It still specifies "*sorted by `occurredAt` ascending, **then by `eventId` ascending***" and still claims the secondary `eventId` key is what makes ties deterministic. The production code now sorts by three keys. Feature 24 is `sdd: true`, so that file is a spec of record, and it now contradicts the code it specifies. PR10's evidence row (`:143`) also still points only at the `occurredAt`-vs-arrival test, which does not exercise a tie. This is a C6 traceability defect and must be fixed alongside D4 (the requirement text will need rewriting anyway once the key changes).

## 7. The new guards — re-armed by me, not accepted from the transcript

I reverted `delta-to-pipeline.ts:55` to `sortBy: { occurredAt: 1, eventId: 1 }` and ran both guards.

**Pure unit** (`delta-to-pipeline.spec.ts`) — failed, message identical to the reported one:

```
AssertionError: expected { '$sortArray': { …(2) } } to match object { '$sortArray': { sortBy: { …(3) } } }
-       "statusRank": 1,
 Test Files  1 failed (1)   Tests  1 failed | 6 passed (7)
```

**Real MongoDB** (`timeline-entry-rank-tiebreak.integration.spec.ts`, Testcontainers) — failed, message identical to the reported one:

```
AssertionError: expected [ 'order.cancelled.v1', …(1) ] to deeply equal [ 'stock.released.v1', …(1) ]
 Test Files  1 failed | 12 passed (13)   Tests  1 failed | 32 passed (33)
```

I then restored the file (`git diff --stat` back to the fix's own 17 insertions / 1 deletion) and re-ran: **13 files, 33 tests, exit 0.** The guards are real and they fail for the right reason. Note that the *new* unit `it` added for R28 asserts the entry's `statusRank` value, not the sort key — the sort-key guard is the amended pre-existing assertion, which is fine, but worth knowing which test is load-bearing.

The second `it` in the integration file (the backfill arm) is a good test: it builds a genuine pre-fix document in the wrong order, asserts the corrected order and ranks, asserts the rest of the document is untouched, and asserts a second run returns `0`.

## 8. N3 (`apps/web` stable sort) — the reasoning was sound in scope, but its conclusion is now false

The implementer's argument is that the only tie in this domain is a trigger fact and the fact it directly causes, that the trigger is structurally guaranteed to arrive first, and that a stable sort therefore preserves the correct order — so the client already agrees with the server's new rank key.

Two of the three premises hold; the conclusion does not. **The completion triple is a tie the argument does not cover**, and there the client and server now disagree *and the server is the one that is wrong*: the SSE arrival order is causal (`payment.received.v1` first), a stable `localeCompare` sort preserves it, and the server's rank key inverts it. A user watching an order complete live, then reloading the page, sees two different timelines — the first correct, the second not. §2.5 makes it worse still: the live view never receives a `credit.released.v1` frame at all, so it shows two entries where the reloaded view shows three, in a different order.

`apps/web` still needs no change — the client is right and the server is wrong. Once D4 is fixed the two agree again, and *then* N3's conclusion becomes true. It should be re-stated as "no change needed once the server's key is causally correct", not as "the two already agree".

---

## 9. `CHECKPOINTS.md` walk

### C1 — The harness is complete
- [x] All harness files present; `.claude/agents/` unchanged; every agent declares its model.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `./init.sh` — not re-run (unchanged by this pass); relied on the implementer's exit 0.

### C2 — State is coherent
- [x] At most one feature `in_progress` — zero.
- [x] Every status is in `rules.valid_status` (34 `done`, 7 `pending`).
- [ ] **Every `done` feature has passing tests associated with it** — feature 24 (`projector_read_model`, `done`) now has a `requirements.md` PR10 that contradicts its own production code, and its cited PR10 evidence does not exercise a tie. Closes with D4/PR10.
- [x] `progress/current.md` describes the active session.
- [x] No `blocked` features.

### C3 — Architecture is respected
- [x] No forbidden imports in any `domain/` folder — `fact-projection.ts`/`projection-delta.ts` add only `rankOf`, already domain-local; `npx eslint` clean on all eight touched/new files.
- [x] No cross-service DB access in production code; the backfill runs inside the projector against the projector's own MongoDB.
- [x] No shared runtime code beyond `shared-kernel`/`contracts`; the rank `$switch` is deliberately duplicated as a Mongo expression rather than imported across the domain/infrastructure boundary, matching `STATUS_RANK_SWITCH`'s established precedent.
- [x] Every interaction still classifiable as Kafka-fact or NATS-RPC — none added.
- [x] No stray debug logging; the one new `console.log` is the backfill's boot report, mirroring the existing one.

### C4 — Verification is real
- [x] `pnpm --filter @otc/projector run typecheck` — exit 0 (run by me).
- [x] `pnpm --filter @otc/gateway run typecheck` — exit 0 (run by me).
- [x] `pnpm --filter @otc/projector run test` — 15 files / 134 tests, exit 0 (run by me; matches the report).
- [x] `pnpm --filter @otc/gateway run test` — 30 files / 121 tests, exit 0 (run by me; matches the report).
- [x] `pnpm --filter @otc/projector run test:integration` — 13 files / 33 tests, exit 0 (run by me, twice: armed and restored).
- [x] `npx eslint` on all eight touched/new files — exit 0, no output (run by me).
- [x] Integration tests use Testcontainers against real MongoDB.
- [x] Domain tests remain pure.
- [ ] **Tests prove what their rows claim** — R24's row claims a "full timeline" no test inspects, and the timeline it blesses is causally wrong (D4). PR10's evidence row does not exercise the tie its requirement is about.
- [ ] **Every branch that emits a fact is guarded by a test that fails when the emission is deleted** — the R28 tie is now guarded (§7, re-armed by me); the completion tie is not guarded at all, which is exactly why D4 shipped.

### C5 — The session closed cleanly
- [x] No suspicious untracked files — the two new projector files are the fix's own.
- [ ] `progress/history.md` has an entry for feature 31 with its effort record — **absent**, correctly so while rejected.
- [x] `feature_list.json` reflects true state (31 stays `pending`).
- [ ] The human has been told what was done and how to test it manually — the leader's job on re-report.
- [x] Claude did not commit.

### C6 — Spec-Driven Development
- [x] R28's row now matches what its named test proves.
- [x] R48's row correct.
- [ ] **R24's row overclaims** (§6).
- [ ] **`specs/projector_read_model/requirements.md` PR10 contradicts the code it specifies** (§6). Feature 24 is `sdd: true`; this is the spec of record.

### C7 — Trilogy reusability
- [x] The R28 row no longer names #7 production file paths; the narrative is behavioural. C7 satisfied for that row.
- [x] `n8n/workflows/*.json` untouched.
- [ ] `progress/history.md` effort records complete — pending feature 31's own entry.

---

## 10. Defects

### Blocking

**D4 — `apps/projector/src/infrastructure/persistence/delta-to-pipeline.ts:55`: the `statusRank` tiebreak inverts the completion triple.**
On every completed order, `credit.released.v1` (rank 0) sorts before the `payment.received.v1` (rank 7) that produced it, contradicting R47's own mandated emission order and misrepresenting causality in the operator UI. Deterministic, 100% of orders; pre-fix it was a 50/50 coin flip and ORD-000031's `eventId`s show the old key would have got that order right. Live-reproduced on a fresh order (§2.2) and present in the two pre-existing completed documents the backfill itself rewrote (§2.1). Why it matters: it is the same defect class this feature was rejected for, relocated from R28 to R24, and made certain rather than probable. Fix: a causal-sequence key, not the status rank (§2.6), plus a guard for the three-way tie and a timeline-order assertion in black-box scenario 1.

**D5 — `apps/projector/src/infrastructure/persistence/timeline-entry-rank-backfill.ts:57`: the backfill cannot be re-run.**
`{'events.statusRank': {$exists: false}}` keys on presence, not on value or migration version, so once D4's rank table is corrected every already-backfilled document keeps the wrong ranks and the wrong stored order — silently, on a green suite, with the boot log reporting `0 document(s) backfilled`. The 30 documents in the dev stack are already in that state. Needs a version stamp, a value-mismatch filter, or a documented one-off `$unset` before the corrected backfill runs.

**D6 — `specs/projector_read_model/requirements.md:56` (PR10) was not updated.**
It still specifies a two-key `{occurredAt, eventId}` sort and still credits `eventId` with making ties deterministic. The code now uses three keys. Feature 24 is `sdd: true` and `done`; its spec of record now contradicts its implementation, and PR10's evidence row cites a test that exercises no tie. Must be rewritten with the corrected key from D4, with the tie test cited.

**D7 — `specs/shared/test-matrix.md:131` (R24 row): overclaims.**
It flips to `DONE` citing scenario 1 "*…reaches completed with the full timeline*", but scenario 1 asserts only `status === 'completed'` and never reads `events[]`. Reword to claim only what it proves, and add the timeline-order assertion (D4 item 2) if the "full timeline" claim is to stay.

### Non-blocking (record; do not gate)

**N5 — `apps/projector/src/infrastructure/persistence/mongo-read-model-writer.ts:61`: `latestEntry` is the last entry in sort order, not the entry just applied.**
Pre-existing and independent of this fix. It makes the SSE `timeline.appended` frame announce the wrong fact whenever the applied entry does not sort last — I observed `order.confirmed.v1` and `credit.released.v1` never announced and two duplicate frames on one live order (§2.5). The `order.confirmed.v1` case is entirely pre-existing (a higher-`occurredAt` fact from another topic applied first). Worth its own feature: pass the applied entry through rather than re-deriving it.

**N6 — `apps/seed` writes `events[]` entries with no `statusRank`** (`apps/seed/src/writers/mongo.writer.ts:60-66`), so a `pnpm seed` against a live projector leaves unranked documents until the next projector boot. Same pre-existing window as `backfillLegacyDocuments`; a line in the seed's docs would close it.

**N7 — the backfill's `$switch` silently defaults an unknown `eventType` to 0** where `rankOf` throws. Unreachable in practice and defensible for a migration, but the asymmetry deserves a one-line comment.

**N1 and N2 from the first review remain open and remain non-blocking.**

---

## 11. What I ran, and what I did not

**Run by me:** `pnpm --filter @otc/projector run typecheck` (exit 0); `pnpm --filter @otc/gateway run typecheck` (exit 0); `pnpm --filter @otc/projector run test` (15 files / 134 tests, exit 0); `pnpm --filter @otc/gateway run test` (30 files / 121 tests, exit 0); `pnpm --filter @otc/projector run test:integration` **twice** — once with the sort key reverted (1 failed / 32 passed, the two verbatim failures in §7) and once restored (13 files / 33 tests, exit 0); `npx eslint` on all eight touched/new files (exit 0); a full source walk of the fix, the backfill and the projection exclusion; a `mongosh` scan of all 30 live read-model documents for `occurredAt` ties; and four independent live probes against the running compose stack — 15 pre-existing `.99` orders re-read, 8 fresh `.99` orders placed and polled, one fresh happy-path order placed and paid (ORD-000031), and one fresh happy-path order watched over a live SSE connection (ORD-000032).

**Not run by me:** `pnpm --filter @otc/gateway run test:integration` (the Testcontainers black-box suite). I relied on the implementer's reported run (10 files / 48 tests, exit 0) for that suite's greenness, and I am saying so explicitly. I judged a re-run not cost-justified: it needs ports 3001–3006 free, which means tearing down the very stack every finding above depends on, and **the claims under test are about causal correctness, not about that suite being green** — my own live probes answer them more directly and more independently. D4 in particular is invisible to that suite by construction, since scenario 1 never inspects `events[]`.

**Docker stack:** left **running and healthy** — 17 `otc-*` containers, all `(healthy)`, verified after every probe. I never stopped a container. `apps/projector/src/infrastructure/persistence/delta-to-pipeline.ts` was temporarily modified for the arming exercise and is **restored byte-for-byte** (`git diff --stat` back to 17 insertions / 1 deletion, `sortBy: { occurredAt: 1, statusRank: 1, eventId: 1 }` present at line 55). Side effect to disclose: my probes placed **10 real orders** in the dev stack — ORD-000023 … ORD-000030 (`.99`, all correctly `cancelled`/`credit_rejected`) and ORD-000031 / ORD-000032 (both paid to `completed`). Left in place, as before.

---

## 12. What must change before re-review

1. **D4** — replace the `statusRank` tiebreak with a causally-ordered key (§2.6). Add the three-way completion-tie guard to `timeline-entry-rank-tiebreak.integration.spec.ts` and a timeline-order assertion to black-box scenario 1. Re-arm both and record the verbatim failures.
2. **D5** — make the backfill re-runnable (version stamp, value-mismatch filter, or a documented `$unset`), and re-run it so the existing 30 documents pick up the corrected ranks.
3. **D6** — rewrite `specs/projector_read_model/requirements.md` PR10 to describe the new key, and point its evidence row at the tie test.
4. **D7** — correct the R24 row in `specs/shared/test-matrix.md`.
5. **N5** *(recommended, separate feature)* — `latestEntry` should be the entry just applied, not the last in sort order.

R28 itself is met and I want that recorded plainly: the fix works, the determinism argument holds, the guards are real and I broke them myself to prove it, the wire-leak fix is correct and live-verified, and D1/D2/D3 are genuinely closed. The rejection is D4 and its consequences — a rule generalised from one example, applied system-wide, that the system's own data disproves.

**On re-review, `progress/history.md` will still need feature 31's entry with its effort record (sessions + wall-clock) before I can close it.**

---

*Re-reviewed 2026-08-29. Feature 31 left `pending` in `feature_list.json`. No commit made. Docker stack left running and healthy.*

---

# Re-review 2 (post-A1) — 2026-08-29

**Verdict: APPROVED.** Feature 31 set `done` in `feature_list.json`.

Third pass. Both prior rejections are closed, and the thing that closed them is the right thing: the tiebreak is now a **recorded causal edge** in the data, not a table someone has to keep true. I looked for the failure mode that caught attempts 1 and 2 — a tie nobody asked about — by scanning **every** `occurredAt` tie in **every** document of the live read model rather than the two known ones, and by probing the pipeline expression itself against twelve adversarial inputs. It holds. I re-armed three guards (two required, one extra), and the extra one is the load-bearing question the gate paid for: `assertCausalOrder()` genuinely bites, end to end, through the real spawned Gateway.

---

## 1. R28 — MET, on all three clauses

| Clause | Status | Evidence I produced |
|---|---|---|
| set `cancelled` with reason `credit_rejected` on `stock.released.v1` | **MET** | 8 fresh `.99` orders placed by me through the live Gateway (`ORD-000033` – `ORD-000040` less the two the implementer placed), 8/8 `cancelled`/`credit_rejected` |
| both compensation steps separately visible in the timeline **in causal order** | **MET** | live: 8/8 fresh orders store `stock.released.v1` at index 3 and `order.cancelled.v1` at index 4, with `order.cancelled.v1.causationId` literally equal to `stock.released.v1.eventId`, both sharing one `occurredAt` — so the tie is genuinely exercised and genuinely broken by the edge. Guarded and re-armed by me twice: `timeline-causal-order.integration.spec.ts` (real MongoDB, adversarial `eventId`s) and `black-box-api.integration.spec.ts` scenario 2 (real spawned fleet over HTTP) |
| SHALL NOT cancel before `stock.released.v1` is received | **MET** (unchanged) | structural: `stepForStatus` + `Order.cancel`'s `CancellationReasonNotApplicableError` guard |

**The `specs/shared/test-matrix.md` R28 row is defensible.** Both halves `DONE`. The integration half now claims only the state-machine precondition (N4 from review 1, correctly folded in). The e2e/API half cites a test that asserts R28's own words and that I broke myself. The row's narrative describes behaviour and spec ids, not #7 production file paths — C7 satisfied in the same sense every other row in that file satisfies it.

## 2. R24 — MET, and this is the clause attempt 2 got backwards

| Clause | Status | Evidence I produced |
|---|---|---|
| `payment.received.v1` → `paid`; `credit.released.v1` → `completed` + exactly one `order.completed.v1` | **MET** (unchanged) | 7 fresh happy-path orders placed **and paid** by me over HTTP (`ORD-000042` – `ORD-000048`), 7/7 `completed` |
| the completion triple visible in the timeline **in causal order** | **MET** (was 100% inverted) | 7/7 store `payment.received.v1` → `credit.released.v1` → `order.completed.v1`, all three sharing one `occurredAt` (a real tie group), with `credit.released.v1.causationId` = `payment.received.v1.eventId` and `order.completed.v1.causationId` = `credit.released.v1.eventId` — the chain is in the data, not inferred |

**The R24 row is defensible, and it is the row that changed the most.** Review 2's D7 was that it flipped to `DONE` citing "reaches `completed` with the full timeline" while scenario 1 never read `events[]` at all. The row now names the actual mechanism — `assertCausalOrder`, the general invariant — and scenario 1 now asserts both the triple's presence and the invariant. I armed scenario 1 (§6.3) and it failed **through the helper**, which is what makes the row's claim true rather than decorative.

## 3. Full tie scan — the check that caught both previous attempts

Not the two known tie groups. **Every** `occurredAt` tie in **every** document, plus a *global* edge check (any recorded edge anywhere in a document, not only within a tie group), plus a contiguity check, plus a leak check. Run twice: once on the 34 documents as I found them, once after adding 14 orders of my own live traffic.

```
                       as found     after my 14 live orders
totalDocs                    34                          48
docsWithTies                 28                          42
tieGroups                    33                          54
tieGroupsWithEdges            3                          24
violations (in-tie-group)     0                           0
edgeViolationsAnywhere        0                           0
timelineOrderVersion          2 x34                       2 x48
entries carrying statusRank   0                           0
entries carrying __depth      0                           0
```

**Zero violations, at either sample size.** I deliberately grew the edge-carrying sample from 3 tie groups to 24 first, because 3 is not a scan — the 32 pre-A1 documents carry no edges at all and are therefore vacuously clean, and a scan that only walks them proves nothing. Contiguity holds everywhere (no tie group is split across a non-member). No document was made worse: not one tie group with a recorded edge is out of causal order, and no entry-level `statusRank` and no transient `__depth` survives anywhere in the collection.

**The honest residue, and it is gate-sanctioned.** 32 documents predate `PR30` and hold no `causationId` on any entry, so their tie groups fall to the `eventId` fallback permanently. `ORD-000007` and `ORD-000009` — the two completed orders the rejected backfill rewrote — now read `[order.completed.v1, credit.released.v1, payment.received.v1]` and `[order.completed.v1, payment.received.v1, credit.released.v1]`. Both are causally wrong; so was every alternative, because no rule can recover an edge that was never recorded, and `PR35` forbids inventing one (open point 10, approved). The migration says so out loud at boot rather than claiming repair, which is the correct disposition. See N12 for the demo-data recommendation.

## 4. `assertCausalOrder()` — it genuinely bites, and I proved it end to end

This is the assertion the gate bought by ruling `causationId` public, so I did not settle for reading it.

I armed the **production pipeline**, not the test: `sortBy: { occurredAt: 1, __depth: -1, eventId: 1 }` — depth *descending*, so within every tie group the effect sorts before its cause, deterministically, on every order. Then I ran the black-box suite against the real spawned fleet with the app containers stopped. Scenario 1 failed **inside the helper**:

```
AssertionError: causal order violated: order.confirmed.v1 (index 2) names causationId
9f7bce2f-448a-4f78-b821-0e7f1f78f321, but its cause (index 3) does not precede it —
events: ["order.placed.v1","stock.reserved.v1","order.confirmed.v1","credit.approved.v1",
"order.despatched.v1","invoice.issued.v1","order.completed.v1","credit.released.v1",
"payment.received.v1"]: expected 3 to be less than 2
 ❯ assertCausalOrder src/black-box-api.integration.spec.ts:162:7
 ❯ src/black-box-api.integration.spec.ts:524:7
```

Note *which* pair it caught: `credit.approved.v1` / `order.confirmed.v1` — a tie group **nobody wrote a test for**. That is the whole point of a general invariant over a hand-written sequence, and it is the difference between this attempt and the previous two. Scenario 2 failed too, on its hand-written `stockReleasedIndex < orderCancelledIndex` first (which fires before the helper is reached, so the helper is not the load-bearing assertion *there* — worth knowing, and scenario 2 keeps both).

Restored (`git diff --stat` back to the exact pre-arming baseline, 32 files / 855 insertions / 51 deletions) and re-ran: **4 passed (4), exit 0**.

**The one vacuity risk, recorded not as a defect but so nobody forgets it:** the helper `continue`s on an entry whose `causationId` is absent or names nothing. If `causationId` ever stopped reaching the wire, the helper would assert nothing and scenario 1 would go green on a broken system. It does not currently, and a D4-class regression (a bad sort key) leaves `causationId` in place and is caught — which is the class this exists for. A single `expect(edgesChecked).toBeGreaterThan(0)` inside the helper would close it permanently. Non-blocking (N7).

## 5. The `$ifNull` bug and its class — fixed, and I hunted for a second one

The reported bug is real and the fix is right: `$arrayElemAt` on an empty `$filter` yields BSON **missing**, `$eq: ['$$cause', null]` does not catch missing, and `$add` against a missing operand yields `null` — corrupting depth to `null` for every cause-less entry. `{ $ifNull: [{ $add: ['$$cause.__depth', 1] }, 0] }` catches missing and null uniformly, and needs no separate "no cause" arm at all, which is why it is also simpler than what it replaced.

**I did not stop at the reported instance.** I extracted the *real* expression from the compiled `dist/` (so this is the shipped tree, not a transcription) and evaluated it against `mongo:8.3.8` over twelve adversarial inputs:

```
A_no_causation_field_at_all      order=[a,b,c]     depths=[0,0,0]      <- the bug's own case
B_bson_null_causation            order=[a,b,c]     depths=[0,0,0]      <- null, not merely missing
C_cause_names_nothing            order=[a,b]       depths=[0,0]
D_self_loop                      order=[a,b]       depths=[0,1]        <- $ne self-guard works
E_chain4                         order=[a,b,c,d]   depths=[0,1,2,3]
F_chain8                         order=[a..h]      depths=[0..7]       <- worst-case round bound
G_cycle2                         order=[a,b]       depths=[2,2]        <- terminates, both present
H_cross_group_edge               order=[a,b,c]     depths=[0,0,1]      <- out-of-group edge ignored
I_mixed_legacy_and_new           order=[a,c,b,d]   depths=[0,0,1,1]
J_two_independent_chains         order=[a,c,b,d]   depths=[0,0,1,1]
K_duplicate_causation_siblings   order=[a,b,c]     depths=[0,1,1]
L_retired_statusRank_present     order=[a,b]       depths=[0,1]        <- retired key stripped
```

Every one correct. `F_chain8` matters specifically: eight entries in one 7-deep chain converge exactly within the `|appended|`-round bound, so the bound is sufficient at its theoretical worst case, empirically and not by argument. `G_cycle2` terminates with every entry present exactly once, as `PR31` requires.

**No second instance of the class.** The only `$arrayElemAt` in the tree is the fixed one. The two other missing-sensitive comparisons are safe by construction: `$eq: ['$$c.eventId', '$$e.causationId']` and `$eq: ['$$c.occurredAt', '$$e.occurredAt']` both have an always-present string on the left, so a missing right operand compares false rather than matching another missing. Every array operand is `$ifNull`-guarded before it reaches `$size`/`$concatArrays`, in both the live `$set` and the migration. The one residue is case B: a BSON `null` `causationId` survives the strip (which filters by key, not by value) and would reach the wire as `null`. Unreachable today — the fact controller's seven-field envelope check rejects it upstream — so N8, not a defect.

## 6. Arming — three guards, re-armed by me

### 6.1 K5 (`timeline-causal-order.integration.spec.ts`, real MongoDB)

Armed by removing the depth key (`sortBy: { occurredAt: 1, eventId: 1 }`). Both cases failed, verbatim-identical to the implementer's report:

```
FAIL > R28 — stock.released.v1 precedes the order.cancelled.v1 whose causationId names it...
AssertionError: expected [ 'order.cancelled.v1', …(1) ] to deeply equal [ 'stock.released.v1', …(1) ]
FAIL > R24 — the completion triple stores order.completed.v1 last...
AssertionError: expected [ 'order.completed.v1', …(2) ] to deeply equal [ 'payment.received.v1', …(2) ]
Test Files 1 failed (1)   Tests 2 failed | 4 passed (6)
```

### 6.2 K8 (`timeline-order-migration.integration.spec.ts`)

Armed by swapping the version filter for the rejected attempt's own presence filter (`{ 'events.causationId': { $exists: false } }`). **3 of 4 cases failed** — exactly as reported, and each failure is the D5 defect itself: `expected +0 to be 1 // migrated` twice and `expected 1 to be 2 // migrated` once.

### 6.3 The black-box `assertCausalOrder` (extra, not requested as one of the two)

§4 above.

Restored after each; the full projector integration suite is **14 files / 42 tests, exit 0** and the black-box suite **4/4, exit 0** on the restored tree, both run by me.

## 7. The Billing causation change — blast radius, walked

`Invoice.markPaid` now returns the `payment.received.v1` fact's own `eventId`, and `payment-register.handler.ts:201` passes `{ ...ctx, causationId: paymentEventId }` to `credit.releaseHold`. `ctx.occurredAt` is untouched, so the tie itself is unchanged. What I checked, and what I found:

- **`otc_saga_completion_ms` — unaffected.** `recordSagaCompletionIfClosed(order, ctx)` (`saga-fact-handler.ts:193`) reads `ctx.occurredAt` and nothing else, and `ctx` is built by `transitionContextFrom(envelope)` from the fact's own `occurredAt`. The metric never touches `causationId`. Review 2's Option-C concern does not apply to this change.
- **No dedup or idempotency path keys on `causationId`, anywhere.** Projector: `${consumer}:${eventId}` (`idempotent-consumer.ts:58`). Orders: `runOnce(envelope.eventId, 'orders.saga', …)`. Notifications: `runOnce(envelope.eventId, CONSUMER, …)`. Billing/Fulfillment/Orders outbox: `event_id` UNIQUE, not `causation_id`. `saga_commands.triggeringEventId` is set from `envelope.eventId` (`saga-fact-handler.ts:152`), not from the envelope's `causationId`. I grepped every production use of `causationId` across all five services: it is written into envelopes and read by the projector's ordering rule, and nowhere else.
- **`BuyerCredit.releaseHold` does not key on it either** — the ledger entry's id is `newId()` and its date is `ctx.occurredAt`; `causationId` reaches only the emitted fact's envelope.
- **It is *more* R12-compliant, not a deviation.** R12 permits "the `eventId` of the fact — or the identifier of the command — that caused the fact", and its stated purpose is that "the causal chain of an order is reconstructible **from the facts alone**". A command id is not in the fact set, so the old value made that chain unreconstructible at exactly this link. `BC1` constrains only the `billing.credit.hold` command path and is untouched; `credit-release.handler.ts:51` (the NATS `billing.credit.release` compensation path, where there *is* no causing fact in the transaction) correctly still uses `cmd.requestId`.
- **Guarded at two levels.** Unit (`payment-register.handler.spec.ts`): `releaseCausationId` equals the payment's `eventId` **and** `not.toEqual(cmd.requestId)`. Integration against real MySQL (`payment-register.integration.spec.ts:143`): `outboxRows[1].causationId === outboxRows[0].eventId` and `not.toBe(requestId.value)` — the edge proven in the durable outbox, not only in the domain layer.
- **Regression sweep run by me:** billing fast 29 files / 148 tests, billing `payment-register` integration 10 tests, orders fast 52 files / 512 tests — all exit 0. Plus 8 live compensation orders, which exercise the *other* `credit.released.v1` path, all correct.

**Finding: none.** The blast radius is contained.

## 8. The migration — D5 genuinely repaired, proven live rather than by test

The boot report is honest. Second boot of the same projector against the same MongoDB: `0 document(s) migrated` — so the stamp is real and the migration is not silently rewriting the collection on every start.

Then the actual D5 question, which no test can answer about the human's own data. I took `ORD-000042`, **reversed its `events` array, re-injected the retired entry-level `statusRank` on every entry, and stamped it `timelineOrderVersion: 1`** — precisely the state the rejected presence-filtered backfill would have left behind and never touched again. Restarted the projector:

```
[projector] timeline-order-migration: 1 document(s) migrated, 0 of them still holding an entry with no causationId
```

and the document came back fully repaired: `payment.received.v1` → `credit.released.v1` → `order.completed.v1`, edges intact, and every entry's key set exactly `causationId, eventId, eventType, occurredAt, summary` — the injected `statusRank` stripped. **A version bump alone is sufficient to re-migrate. D5 is closed.**

`ORD-000007` specifically, as asked: `timelineOrderVersion: 2`, `statusRank` stripped from every entry, and honestly unrepaired (edgeless, `eventId` fallback) — matching `PR35` exactly and matching the implementer's own account. The `32 migrated, 32 still edgeless` boot report is confirmed by my independent scan: exactly 32 of the 48 documents hold at least one entry with no `causationId`.

## 9. `statusRank` — fully retired as a timeline key

Grepped the whole tree. Every surviving occurrence is one of: the **document-level** `PR12` field (`R52`'s "precedes" — correctly kept, and explicitly protected by `PR30`'s own wording); the retired key's name as a literal in the strip filter; a test asserting its absence; or a comment explaining why it is gone. Specifically gone: `TimelineEntryDelta.statusRank`, `entryOf`'s `statusRank`, `OrderTimelineDocument.events[].statusRank`, the `$sortArray` key, `timeline-entry-rank-backfill.ts` and its spec (both deleted), and the Gateway's `'events.statusRank': 0` exclusion. Zero entries in the entire live collection carry it — including the 32 the rejected backfill had written it onto.

## 10. Public `causationId` — on the wire, and I asked the running Gateway

`GET /orders/{orderId}` against `http://127.0.0.1:3001` (the compose Gateway, not the mapper):

```
0 order.placed.v1        causationId=9aeb79aa -> idx -   keys: causationId,eventId,eventType,occurredAt,summary
3 order.confirmed.v1     causationId=7d81e782 -> idx 2
7 credit.released.v1     causationId=bf094ced -> idx 6
8 order.completed.v1     causationId=80a64af2 -> idx 7
```

Present on every entry, resolving to the right index. No `statusRank` at document or entry level. No `timelineOrderVersion` either — it is not in `EXCLUDE_INTERNAL_FIELDS`, but `order-read-model-mapper.ts` rebuilds the document field-by-field (only `events` is a passthrough), so it cannot leak. See N9 — the design text claims it is projected out, and it is not; the behaviour is right and the design is stale.

`openapi.yaml`: optional property on `TimelineEntry` and `TimelineStreamEntry`, **neither `required` list changed** — backwards-compatible. `packages/contracts` regenerated: I re-ran `pnpm --filter @otc/contracts run generate` and the output is **byte-identical** to the checked-in file, so the generated types are genuinely generated and not hand-edited.

## 11. `apps/seed`

`toTimelineDocument` writes each entry's `causationId` from the fixture's own declared chain and stamps `timelineOrderVersion: 2`, so a fresh `pnpm dc:seed` writes documents the boot migration has no reason to touch. The fixtures encode the **new** Billing edge (`creditReleasedCausationId = paymentReceivedEventId`, `orderCompletedCausationId = creditReleasedEventId`), so the seeded data and production now say the same thing. Three new unit tests assert exactly that, including the compensation pair. Seed suites run by me: 8 files / 122 tests fast, 1 file / 6 tests integration, both exit 0. See N10 for the one latent coupling.

## 12. Collateral improvement I measured rather than assumed

Review 2's §2.5 recorded that the SSE `timeline.appended` stream lost `credit.released.v1` on every completed order and duplicated `payment.received.v1`. I held an SSE connection open across a full live happy path (`ORD-000048`):

```
SSE timeline.appended frames: order.placed.v1, stock.reserved.v1, credit.approved.v1, order.confirmed.v1,
                              order.despatched.v1, invoice.issued.v1, payment.received.v1,
                              credit.released.v1, order.completed.v1
STORED events               : (identical, same order)
NEVER ANNOUNCED             : []
```

All nine facts announced, in stored order, no duplicates, nothing lost — including `order.confirmed.v1`, which review 2 lost to a pre-existing cause. The systematic half of N5 is gone as a side effect of the ordering fix. The residual cross-topic-arrival case is unchanged and still deserves its own feature (`latestEntry` should be the entry just applied, not the last in sort order), but it is no longer firing on the happy path. Review 2's N3 (`apps/web`'s stable client-side sort disagreeing with the server) is resolved with it: the client's arrival order and the server's causal order now agree, so a live-watched order and the same order after a reload show the same timeline.

---

## 13. `CHECKPOINTS.md` walk

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (+ suite_runner).
- [x] Every agent definition declares its model.
- [x] `./init.sh` exits 0 — **run by me**, exit 0.

### C2 — State is coherent
- [x] At most one feature `in_progress` — zero.
- [x] Every status is in `rules.valid_status` (35 `done` after this close, 6 `pending`).
- [x] **Every `done` feature has passing tests associated with it** — closed. Feature 24's `requirements.md` `PR10`/`PR15` now describe the key the code actually uses, and their evidence rows cite tests that exercise the tie (review 2's D6).
- [ ] `progress/current.md` describes the active session — **it does not**; it still describes feature 29 (`web_app`, phase 16). Leader housekeeping, not a defect in this feature's work, and not a reason to hold the close. See N13.
- [x] No `blocked` features.

### C3 — Architecture is respected
- [x] No forbidden imports in any `domain/` folder — grepped `apps/projector/src/domain`, `apps/billing/src/domain`, `apps/gateway/src/domain` for `@nestjs/*`/`mongodb`/`drizzle`/`kafkajs`/`nats`: zero hits. `pnpm run lint` (whole repo) exit 0.
- [x] No cross-service DB access in production code — the migration runs inside the projector against the projector's own MongoDB.
- [x] No shared runtime code beyond `shared-kernel`/`contracts` — `apps/seed`'s `TIMELINE_ORDER_VERSION` is a deliberate local copy, not an import across apps, matching the `STATUS_RANK` precedent that file already sets.
- [x] `packages/shared-kernel` still dependency-free.
- [x] Every interaction still classifiable as Kafka-fact or NATS-RPC — none added.
- [x] No stray debug logging; the one new `console.log` is the boot migration report, mirroring the existing backfill's.

### C4 — Verification is real
- [x] `pnpm run lint` exit 0; `pnpm run typecheck` (all 10 projects) exit 0 — both run by me.
- [x] Domain tests remain pure.
- [x] Integration tests use Testcontainers against real MySQL/Kafka/NATS/MongoDB — the black-box suite spawns five real services and the projector suite runs against a real MongoDB.
- [x] Coverage thresholds — unaffected by this pass.
- [x] No Jest anywhere.
- [x] **Tests prove what their rows claim** — closed. R24's row names `assertCausalOrder` and scenario 1 runs it; R28's row names the causal-order clause and scenario 2 asserts it; both are armed and I broke both myself.
- [x] **Every branch that emits — or orders — a fact is guarded by a test that fails when it is deleted** — K5, K7, K8 all armed and recorded; I independently re-armed K5, K8 and the black-box helper.

### C5 — The session closed cleanly
- [x] No suspicious untracked files — the four new files are the fix's own plus the three `progress/` documents.
- [x] `progress/history.md` has an entry for feature 31 including its effort record — **appended by me with this verdict**.
- [x] `feature_list.json` reflects the true state — feature 31 set `done`.
- [ ] The human has been told what was done and how to test it manually — the leader's job on re-report.
- [x] Claude did not commit.

### C6 — Spec-Driven Development
Feature 31 is `sdd: false`. The obligations that do apply, via the `sdd: true` feature 24 this pass amends:
- [x] `specs/projector_read_model/` has all three files; §6 records the amendment and why the first attempt was rejected.
- [x] EARS notation held for the new `PR30` – `PR35`.
- [x] Every task in section **K** (K1 – K14) ticked, and I found no unticked task anywhere in that file.
- [x] `PR10` and `PR15` rewritten to describe the key the code actually uses (review 2's D6 — closed).
- [x] R24, R28 and R48 rows in `specs/shared/test-matrix.md` all defensible; the `~` précis markers are correct and `apps/orders/src/test-matrix-guard.spec.ts` (6 tests) passes, run by me.

### C7 — Trilogy reusability
- [x] `specs/shared/` carries no stack specifics beyond the evidence-column file paths every row in `test-matrix.md` already uses; the R28 row's narrative is behavioural and names spec ids, not #7 production files.
- [x] The `openapi.yaml` addition is stack-agnostic and backwards-compatible — #8 and #9 inherit an optional property and the ordering rule stated in prose, which is exactly the right shape for a spec three assessments share.
- [x] `n8n/workflows/*.json` untouched.
- [x] `progress/history.md` effort records complete — feature 31's appended with this verdict.

---

## 14. Findings — none blocking

**N7 — `black-box-api.integration.spec.ts:151-164`: `assertCausalOrder` is vacuous if `causationId` ever leaves the wire.** It `continue`s on an entry whose `causationId` is absent or names nothing, and nothing asserts that it checked at least one edge. It is not vacuous today (§4 proves it bites), and the regression class it exists for leaves `causationId` in place. One counter and one `expect(edgesChecked).toBeGreaterThan(0)` closes it for good.

**N8 — `delta-to-pipeline.ts:151`: the field strip filters by key, not by value.** A BSON `null` `causationId` survives to the wire as `null` (probe case B, §5). Unreachable today because the fact controller's envelope check rejects a null `causationId` upstream. Recorded because it is the same *shape* as the bug that was found — a value the expression tree does not distinguish from the value it expects.

**N9 — `AppliedOrderTimeline.latestEntry.causationId` and `TimelineStreamEntry.causationId` are typed `string`, not `string | undefined`.** A pre-A1 entry has none, and `mongo-read-model-writer.ts:80` reads `latest!.causationId` off whatever sorted last — reachable whenever a non-terminal legacy document receives a new fact. Harmless at runtime (`JSON.stringify` drops `undefined`, and `openapi.yaml` declares the property optional), but the type is a lie on a reachable path. Should be optional in both places.

**N10 — `apps/seed`'s writer sorts by `occurredAt` alone while stamping `timelineOrderVersion: 2`.** No current fixture has a tie (I checked every `t*` constant in `sagas.data.ts`: all distinct), so today the two orders coincide and the stamp is honest. If a future fixture ever introduced a tie, the seed would write a possibly non-causal order and the version stamp would make the boot migration skip it. Either apply the rule in the writer or add a fixture-level assertion that no tie group exists.

**N11 — design/implementation divergences in `specs/projector_read_model/design.md`.** §5.5.4's migration table says the retired key is removed by `$unset` of `events.$[].statusRank`; the code strips it generically via `$objectToArray`/`$filter` (better, and correct for a future retired key too). §3's note says the Gateway projection is `{ statusRank: 0, processedEventKeys: 0, timelineOrderVersion: 0 }`; the code omits `timelineOrderVersion`, which does not leak only because the mapper rebuilds the document field-by-field. Both are stale text in an `sdd: true` spec of record. Behaviour is right in both cases.

**N12 — the dev read model's 32 pre-A1 documents.** Honestly reported as edgeless and left on the `eventId` fallback, per `PR35`. But the demo data is the first thing a reader looks at, and two of them (`ORD-000007`, `ORD-000009`) render `order.completed.v1` first. Recommend deleting the pre-A1 probe documents (or re-seeding, which now writes edges) before any demo — a one-line `mongosh` delete of `{ 'events.causationId': { $exists: false } }` documents would leave a coherent read model.

**N13 — `progress/current.md` still describes feature 29** (`web_app`, phase 16, `in_progress`), four features behind. Leader housekeeping; C2's box is unticked for it.

**N1, N2 and N5 from the earlier passes remain open and remain non-blocking.** N5 is materially smaller than review 2 recorded it (§12). **N3 is closed.**

---

## 15. What I ran, and what I relied on

**Run by me.** `./init.sh` (exit 0); `pnpm run lint` (exit 0); `pnpm run typecheck`, all 10 projects (exit 0); `pnpm --filter @otc/projector exec vitest run` (15 files / 163 tests); `pnpm --filter @otc/gateway exec vitest run` (30 / 123); `pnpm --filter @otc/orders exec vitest run` (52 / 512); `pnpm --filter @otc/billing exec vitest run` (29 / 148); `pnpm --filter @otc/seed exec vitest run` (8 / 122) and its integration config (1 / 6); `pnpm --filter @otc/billing … payment-register` integration (10); the **full** projector integration suite (14 files / 42 tests) on the restored tree; the black-box suite **twice** — once armed (2 failed / 2 passed, §4) and once restored (4/4); `timeline-causal-order` armed (2 failed / 4 passed) and `timeline-order-migration` armed (3 failed / 1 passed); the test-matrix guard (6); `pnpm --filter @otc/contracts run generate` byte-compared against the checked-in file.

Live, against the running compose stack: **14 orders placed through the real Gateway over HTTP** — 6 `.99` compensation (`ORD-000035` – `ORD-000040`), 7 happy-path placed *and paid* to `completed` (`ORD-000042` – `ORD-000048`, one of them watched over a held-open SSE connection), plus `ORD-000041` left at `invoiced` by an aborted first attempt; two full-collection `mongosh` tie scans (34 then 48 documents); a twelve-case adversarial probe of the compiled pipeline expression against `mongo:8.3.8`; three projector restarts including one against a deliberately corrupted, version-1-stamped document; `GET /orders/{id}` wire inspection.

**Relied on, and saying so.** I did **not** re-run `pnpm run test` whole-repo for its own sake. I ran the six workspace projects this change can reach (projector, gateway, orders, billing, seed, contracts-regeneration) plus the two integration suites that carry the claims, and relied on the implementer's report for `fulfillment` (83), `notifications` (82), `shared-kernel` (69) and `web` (59) — none of which this pass touches, none of which import anything it changed. I did not re-run a compose cold start.

**Docker stack:** left **running and healthy** — all 17 `otc-*` containers verified `(healthy)` after the app containers were stopped for the black-box run and restarted with `WEB_PORT=3010 pnpm dc:up:apps`. **Source tree restored byte-for-byte** after every arming: `git diff --stat` is back to the exact pre-review baseline (32 files, 855 insertions, 51 deletions), `sortBy: { occurredAt: 1, __depth: 1, eventId: 1 }` present at `delta-to-pipeline.ts:127` and the version filter present at `timeline-order-migration.ts:50`. Note the mtimes of those two files are mine (restored via `cp`), not the implementer's — the *content* is identical. Side effects to disclose: the 14 orders above are left in the dev read model, and `otc_probe` (the scratch database for the twelve-case probe) was dropped.

---

## 16. Why this one is approved and the other two were not

Attempt 1 fixed the pair it was shown and broke a pair it was not. Attempt 2's flaw was visible only because someone looked at a tie nobody had asked about. This attempt does not depend on anyone having thought of the right tie, because **the ordering key is the data the producers already emit** — there is no table to keep true, and the one place the data was genuinely silent (payment/release siblings) was fixed at the source rather than papered over in the projector. The invariant is now checkable from outside the system on every order the black-box suite touches, and when I inverted the production sort it was caught on a tie group **no test was written for**. That is the property the previous two attempts lacked, and it is worth more than the specific defect it closed.

*Re-reviewed 2026-08-29. Feature 31 set `done` in `feature_list.json`; `progress/history.md` entry with effort record appended. No commit made. Docker stack left running and healthy.*
