# `billing_credit` (id 19, phase 10) — review

**Author:** `reviewer`
**Date:** 2026-08-22
**Pass:** 1
**Verdict:** ❌ **REJECTED** — **1 blocking defect**, everything else green. **9 of 10 hostile mutations killed**; the tenth survived and is the defect. `feature_list.json` set back to `in_progress`. No history entry is written (a rejected feature is not closeable).

The defect is small and costs **one unit test, no production-code change** — but it is precisely the shape that got feature 17 (`fulfillment_stock`) rejected on its first pass (`FS5`: a normative clause implemented correctly, guarded only by structure and a comment, with no test that fails when the clause is removed). Applying a different standard here would make the quality gate a matter of mood.

---

## 1. Scope of this review — what I ran, and what I did not

Per the scope-discipline rule, I re-ran in full only the suites whose claim *is* about the full suite (the relay refactor crosses Orders and Fulfillment, so both are in scope), and otherwise probed claims directly.

| Run | Result | Claim it checks |
|---|---|---|
| `pnpm --filter @otc/orders test` | **29 files / 390 tests, exit 0** | relay refactor did not change Orders' behaviour |
| `pnpm --filter @otc/fulfillment test` | **16 files / 75 tests, exit 0** | relay refactor did not change Fulfillment's behaviour |
| `pnpm --filter @otc/billing test` | **15 files / 56 tests, exit 0** | the new unit suite |
| `pnpm --filter @otc/seed test` | **8 files / 119 tests, exit 0** | `BC18`/`BC19` + the seed amendment |
| `pnpm --filter @otc/billing test:integration` (pristine) | **8 files / 28 tests, exit 0**, 112 s | the Testcontainers half |
| `pnpm --filter @otc/billing test:coverage` | domain **95.89 %**, application 90.47 %, presentation 100 %, **all files 96.74 %** | ≥80 % domain / ≥60 % overall |
| `pnpm run quality` (lint + typecheck + test, 10 packages) | **exit 0** | C4 |
| `./init.sh` | exit 0, *no feature in_progress*, 18/39 done | C1/C2 |
| `pnpm seed` ×2 against the live stack | identical summaries; `otc_billing.credits` md5 **`a5ba6b3d…`** identical before and after both runs | determinism/idempotency |

Every count the implementer reported is confirmed digit-for-digit. **Not** re-run: nothing — but note that the Orders/Fulfillment integration suites were *not* re-run, because the relay change is a type alias plus comments (verified by reading `git diff`) and their unit suites cover the relay directly; their spec files are **unmodified** (`git status` shows no `.spec.ts` change under `apps/orders` or `apps/fulfillment` other than the *new* parity spec), so the existing relay tests were not weakened to accommodate the refactor.

---

## 2. Mutation probes — 9/10 killed

Every mutation was restored **byte-exact** (`md5sum -c` / `cmp` clean at the end of the review; `git status` back to its starting 71 entries).

| # | Mutation | File | Result |
|---|---|---|---|
| M1a | `consume` enters the exposure formula (`exposure = hold − release + consume`) | `domain/credit-exposure.ts:82` | **KILLED** — 3 tests (`buyer-credit.spec — BC5`, `credit-exposure.spec`, `credit-ledger.spec — BC6`) |
| M1b | `consumeHold` reduces `committedExposure` (consume no longer numerically neutral) | `domain/buyer-credit.ts:319` | **KILLED** — 4 tests, incl. the **R40** named test |
| M2 | a release double-counts (`committedExposure − outstanding * 2`) | `domain/buyer-credit.ts:270` | **KILLED** — 3 tests, incl. the **R41** named test |
| M3a | ledger non-append-only *in the domain*: `releaseHold` deletes the order's `hold` entry instead of appending a `release` | `domain/buyer-credit.ts:268-272` | **KILLED** — the **R37** named test (`afterRelease[0]` no longer equals the original entry), plus `BC6`, `BC11` |
| M3b | ledger non-append-only *in persistence*: `save()` `DELETE`s the line's rows before inserting | `persistence/buyer-credit.repository.ts:73-76` | **KILLED** against real MySQL — `buyer-credit.repository.integration.spec` › *availableCredit recomputed from every row…* (`expected 50000 to be 70000`) |
| M4 | **`BC7` clause removed** — `already_held` only while net exposure is still positive | `domain/buyer-credit.ts:148` | **KILLED twice**: unit (`credit-hold.handler.spec — BC7`) **and** integration over real NATS+MySQL (`credit-hold.integration.spec` released-then-re-issued variant: `outcome: approved` where `already_held` was expected). The FS5-shaped rule is genuinely guarded this time |
| P1 | armed a body divergence inside Fulfillment's relay copy (outside the banner) | `apps/fulfillment/.../outbox-relay.ts:62` | **KILLED** — `outbox-relay.parity — OB1` case 1, naming the file |
| P2 | hid `apps/billing/.../create-kafka-client.ts` (an incomplete third copy) | — | **KILLED** — case 1 non-vacuity (`found: fulfillment, orders … ≥ 3`) **and** case 3 census (`incomplete outbox-relay family: billing`) |
| S1 | seed baseline drops `ALBIONFOODS` from the covered pairs | `apps/seed/src/data/credits.data.ts:80` | **KILLED** — 3 cases of the new *(retailer, company)* invariant block, including the class-level *stocked-companies* one |
| **M5** | **an adapter refusal emits no fact** — `credit.refuseHold(holdRequest, decision.reason, ctx)` deleted from the port-refusal branch, reply left unchanged | **`apps/billing/src/application/credit-hold.handler.ts:93-104`** | ⛔ **SURVIVED** — `pnpm typecheck` clean, **56/56 unit tests green**, and structurally uncatchable by the integration suite. **This is the defect.** |

---

## 3. The defect

### D1 — the adapter-refusal branch of `credit.hold` has no test at any level

**Where:** `apps/billing/src/application/credit-hold.handler.ts:93-104` (the `if (decision.kind === 'refuse')` branch).

**What survives:** deleting the `credit.refuseHold(holdRequest, decision.reason, ctx)` call from that branch — so a port-refused hold still replies `{ outcome: 'rejected', reason }` over RPC but **writes no `credit.rejected.v1` at all** — typechecks and leaves **all 56 billing unit tests green**. The integration suite cannot catch it either: `app.module.ts:65-66` binds `AlwaysApproveCreditDecision`, whose `decide()` returns `{ kind: 'approve' }` unconditionally, in **every** integration harness (`grep` for `CREDIT_DECISION` across `src/test-support/` and the four `*.integration.spec.ts` files returns nothing). No test anywhere in the repository ever drives this handler with a refusing port.

**Why it matters, concretely:**

- Amended **`R39`** — the very row this feature flips to `DONE` — reads *"IF a `credit.hold` command is received whose amount exceeds the retailer's available credit, **or which the credit port rejects**, THEN THE SYSTEM SHALL … emit `credit.rejected.v1` …"*. The over-limit half is tested at three levels (domain, handler, integration, plus my own live reproduction). The port-refusal half is tested **only** as `refuseHold(request, 'simulated_cents_rule')` called directly on the aggregate — i.e. the *fact builder* is proven, the *system behaviour* the requirement states is not. Half of a flipped row's named clause is untraced.
- `credit.rejected.v1` is the fact that drives the saga's compensation. A silent regression here produces an order that is told "rejected" over RPC while nothing is ever published — the saga waits, and no compensation runs. That is worse than the over-limit bug this feature exists to prevent.
- **`BC15`** promises feature 20 is *"a change to provider wiring only — no change to any domain, application or presentation file."* That promise is only as strong as a test that exercises a **refusing** provider through the handler. Today feature 20 will be the first thing that ever executes these twelve lines, and it will execute them in production.
- **Precedent.** `progress/review_fulfillment_stock.md` rejected feature 17 for exactly this class: *"the clause was implemented correctly … but nothing tested it"*, and the history entry generalises it into the portable rule *"mutate the sub-clauses of the requirement, not only the branches of the design"*. `M5` is that rule applied to `R39`'s second sub-clause.

**Not a valid defence:** *"the port-refusal path has no caller until feature 20"*. Gate open point 20 accepted caller-less delivery for `consumeHold`/`releaseHold` — but both ship **with domain unit tests** (`credit-ledger.spec — BC12`, `— BC11`), which is exactly what makes the flip honest. This branch ships with none.

**Required to clear it (test-only; do not touch production code):**

1. Add to `apps/billing/src/application/credit-hold.handler.spec.ts` an `alwaysRefuse()` fake beside the existing `alwaysApprove()` (the fixtures are already there — `creditSnapshot`, `repositoryOf`, `FakeUnitOfWork`, `fixedClock`, `holdCommand`), and one case asserting, for a request that **fits**: the reply is `{ outcome: 'rejected', reason: 'simulated_cents_rule' }`; the saved aggregate carries **exactly one** `credit.rejected.v1` whose payload `reason` is the adapter's; `appendedEntries` is empty; and `availableCredit` is unchanged. That case must fail under `M5` — verify it does before re-submitting, and say so in the report.
2. Record it in `specs/billing_credit/requirements.md` §2 (the `BC13`/`BC14` rows are the natural home — `BC14`'s *"one code path for every refusal"* is what this case actually proves end-to-end at handler level) and append it to the `R39` row of `specs/shared/test-matrix.md` as the second half of that row's evidence, the way `R38` already cites an integration half.

Nothing else is owed.

---

## 4. Independent reproduction of the headline claim — the end-to-end compensation

Reproduced from scratch, **not** re-using the implementer's `ORD-000012/13`, with a deliberately different basket so the arithmetic is my own.

Available credit on `CR-000001` (`CarrefourEs`/`IBERFOODS`) read from the live DB before the probe: `500 000 − (17 492 − 17 492) − 74 997 − 74 997 = 350 006`. Basket: `14 × PRD-0001 (24 999)` + `2 × PRD-0003 (2 499)` = **`354 984`**, and **`354 984 mod 100 = 84`** — not the `.99` demo affordance. Placed over raw NATS against the live `orders.create` responder; reply `ORD-000014`, `totalAmount: 354984`.

Read back from the three databases, ~600 ms later:

```
otc_orders.orders            ORD-000014  cancelled  credit_rejected  354984
otc_orders.outbox            order.placed.v1     11:36:56.579  published
                             order.cancelled.v1  11:36:57.165  published
otc_orders…order.cancelled.v1 payload:
  "compensationSteps": [ { "step": "stock_released",
                           "eventType": "stock.released.v1",
                           "summary": "stock released — reason: credit_rejected",
                           "occurredAt": "2026-08-22T11:36:57.165Z" } ]
otc_billing.credit_items     ZERO rows for ORD-000014
otc_billing.outbox           credit.rejected.v1  {"reason":"over_limit", …,
                               "availableCredit":350006,"requestedAmount":354984}
otc_fulfillment.reservations ORD-000014 PRD-0001 14 released
                             ORD-000014 PRD-0003  2 released
otc_fulfillment.outbox       stock.reserved.v1 → stock.released.v1  (same correlationId)
```

`availableCredit: 350006` equals my hand computation to the unit, `requestedAmount` equals the order total, the ledger gained nothing, the stock compensation ran, and the cancellation fact carries the compensation step. **The headline claim is true, and it is not the simulator affordance.** ✅

### The amended `R39` fact/no-fact split — all four paths probed live

Sent directly to the running Billing responder over raw NATS (bare JSON + headers), then queried `otc_billing.outbox` by `correlation_id` and `credit_items` by `order_reference`:

| Path | Reply | Fact emitted | Ledger rows |
|---|---|---|---|
| over-limit (`400 000` vs `350 006` available) | `{ outcome: 'rejected', reason: 'over_limit', availableCredit: 350006 }` | **`credit.rejected.v1`** ✅ | 0 ✅ |
| unknown `(retailer, company)` | `RpcError NOT_FOUND` naming both codes | **none** ✅ | 0 ✅ |
| currency mismatch (`GBP` on an `EUR` line) | `RpcError VALIDATION_FAILED`, `details {expected:'EUR',received:'GBP'}` | **none** ✅ | 0 ✅ |
| missing `x-correlation-id`/`x-request-id` (`BC1`) | `RpcError VALIDATION_FAILED` citing `BC1` | **none** ✅ | 0 ✅ |
| port refusal | *not reachable live* — `AlwaysApproveCreditDecision` is bound; see **D1** | — | — |

The split is exactly right: **only** a credit decision produces a fact. No spurious `credit.rejected.v1` on a contract violation, so no wiring bug can cancel an order over a malformed message.

### Live state — `BC20`

```
ORD-000007..011   despatched   invoice.issue  parked ("no responder … billing.invoice.issue")
```
All five confirmed by direct query, as reported. `otc_billing.credits` = 154 rows (7 × 22); `CR-000124` exists for `(AldiDe, ALBIONFOODS)`.

**Disclosure — live-state changes I made:** `ORD-000014` (cancelled/`credit_rejected`) and its facts; one `credit.rejected.v1` in `otc_billing.outbox` for the synthetic reference `ORD-900003` (my direct-responder over-limit probe). The Orders saga consumed that orphan fact at `11:37:46` and recorded it in `processed_events` **without creating an order or parking anything** — no landmine left, but the row is mine, not the implementer's. Two `pnpm seed` runs also ran; they are idempotent and left the reference tables byte-identical.

---

## 5. `CHECKPOINTS.md` — walked

### C1 — the harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist
- [x] `progress/current.md` and `progress/history.md` exist
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer
- [x] every agent definition declares its model (`./init.sh` §2 green)
- [x] `./init.sh` exits 0

### C2 — state is coherent
- [x] at most one feature `in_progress` (after this verdict: `billing_credit`, and only it)
- [x] every status in `rules.valid_status`
- [x] every `done` feature has passing tests (390 + 75 + 119 + 56 re-run here)
- [x] `progress/current.md` describes the active session
- [x] no `blocked` feature

### C3 — architecture is respected
- [x] no `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats`, `mongodb` import in any `domain/` — grepped `apps/billing/src/domain/` (clean) and enforced by ESLint in the green `pnpm quality`
- [x] no cross-service DB access — Billing's `db-config.ts` reads `MYSQL_DB_BILLING ?? 'otc_billing'` only; no FK crosses a boundary; `retailerCode`/`companyCode`/`orderReference` travel as business identifiers
- [x] no shared runtime code beyond `shared-kernel` + `contracts` — the outbox/messaging families are *copies under a parity guard*, not a shared package (that is the deliberate design, and `OB1` now enforces it for three copies)
- [x] `shared-kernel` still dependency-free
- [x] every interaction classifiable: `billing.credit.hold` / `billing.credit.list` are NATS RPC (`@MessagePattern(subject, Transport.NATS)`, both explicit); `credit.approved.v1` / `credit.rejected.v1` are Kafka facts through Billing's own outbox relay to `otc.billing.facts.v1`, keyed by `correlationId`. Billing registers **no** Kafka consumer transport (`main.ts` connects one microservice, NATS) — correct: `saga.md` §5 gives Billing no fact to consume
- [x] no stray debug logging or context-free TODO — the only `console.*` are the boot line, the migrate CLI and the relay's structured-JSON logger, matching Orders/Fulfillment

### C4 — verification is real
- [x] `pnpm quality` passes (my own run, exit 0)
- [x] domain tests pure — `buyer-credit.spec`, `credit-hold.spec`, `credit-ledger.spec`, `credit-exposure.spec` import only `vitest`, `@otc/shared-kernel` and the domain under test
- [x] integration tests use Testcontainers against real MySQL 8.4.11 + NATS 2.14.5 + Kafka 4.3.1 — no mocked broker anywhere (`credit-wire.integration.spec` even drives a raw `nats` client)
- [x] coverage: domain **95.89 %** ≥ 80, overall **96.74 %** ≥ 60
- [x] no Jest anywhere

### C5 — the session closed cleanly
- [x] no suspicious untracked files (71 entries, all feature artefacts; my probe scripts were written to the scratchpad and the two placed inside `apps/` were deleted in the same command)
- [ ] **`progress/history.md` entry with effort record** — correctly absent: a rejected feature is not closeable. Owed at approval
- [x] `feature_list.json` reflects true state (set back to `in_progress` by this verdict)
- [x] the human is told what was done and how to test it (`progress/impl_billing_credit.md` §6)
- [x] Claude did not commit — `git log` head is still `8a35d4e` (feature 17)

### C6 — spec-driven development (applies, `sdd: true`)
- [x] `specs/billing_credit/` holds all three of `requirements.md`, `design.md`, `tasks.md`
- [x] `requirements.md` uses EARS with `BC<n>` ids, and defers the normative `R37`–`R41` to `specs/shared/requirements.md` §5 rather than restating them
- [x] all **56/56** tasks ticked `[x]` in `tasks.md` (0 unticked)
- [ ] **every `R<n>` covered by a concrete named test** — `R37`, `R38`, `R40`, `R41` yes (each dies under a mutation, proven above). **`R39` only half**: its port-refusal sub-clause has no test that fails when the behaviour is removed (**D1**)
- [x] the spec commit precedes the implementation — `792176e docs(spec): fulfillment_stock…` pattern holds; `specs/billing_credit/` is untracked and will land in the spec commit before the implementation commit, per the same discipline (the human commits)

### C7 — trilogy reusability
- [x] `specs/shared/` stays stack-agnostic — the `R39` amendment cites only `M2`, `O1`, `R44`, `domain-model.md` §7.1; grep for `nest|drizzle|nuxt|mysql|typescript|vitest|kafkajs` in the diff hunks returns nothing
- [x] `n8n/workflows/*.json` untouched
- [ ] effort records complete — owed at approval

---

## 6. Traceability walk

### Shared rows flipped by this feature (`specs/shared/test-matrix.md` §5, `0 → 5`, total `31 → 36`)

| Id | Named test | Verified how |
|---|---|---|
| **R37** | `buyer-credit.spec.ts` › *keeps active holds plus open exposure within the credit limit and raises on any update or deletion of a ledger entry* | Read; **dies** under M3a (domain deletion) — and the persistence half dies under M3b against real MySQL ✅ |
| **R38** | `credit-hold.spec.ts` › *appends a hold entry and emits exactly one credit.approved.v1…* + integration half | Read; asserts entry type/amount, exactly one event, `availableCreditAfter: 6_000`; integration half asserts the row, the outbox row, headers and the recomputed value ✅ |
| **R39** | `credit-hold.spec.ts` › *…when the amount exceeds the available credit or the credit port refuses* | Over-limit half ✅ (dies under a limit mutation, reproduced live). **Port-refusal half ⛔ — see D1.** Matrix row's case name **does** match the amended requirement (currency clause removed, `availableCredit` wording adopted) ✅ |
| **R40** | `credit-ledger.spec.ts` › *appends a consume entry … numerically unchanged and emits no fact* | Read; **dies** under M1a and M1b ✅ |
| **R41** | `credit-ledger.spec.ts` › *releases with reason invoice_paid … without going below zero* | Read; **dies** under M2 ✅ |
| R42–R44 | left `TODO` | Correct — feature 20's, unowned here ✅ |

The matrix's coverage-summary row (`billing_credit … 8 | 5`) and total (`36/61`) are arithmetically right.

### Local rows (`specs/billing_credit/requirements.md` §2)

`BC1` ✅ (unit + integration + my live header probe) · `BC2` ✅ (`credit-wire.integration.spec`, raw NATS client, bare JSON both ways) · `BC3` ✅ (integration + live) · `BC4` ✅ (integration + live) · `BC5` ✅ (dies under M1a/M1b) · `BC6` ✅ (identity asserted over three fixtures; dies under M1a/M1b/M2/M3a) · `BC7` ✅ (**dies under M4 at unit *and* integration level** — the FS5-shaped rule is guarded this time) · `BC8` ✅ · `BC9` ✅ (10 fresh lines, real concurrency, in the green integration run) · `BC10` ✅ · `BC11` ✅ (dies under M2/M3a) · `BC12` ✅ (dies under M1b) · **`BC13` ⚠** (only the *negative* half is tested: the port is not called for an over-limit request. The positive half — what happens when it answers `refuse` — is D1) · **`BC14` ⚠** (the domain-level indistinguishability test is excellent and genuinely structural; the *"one code path for every refusal"* claim is untested where the two paths actually diverge, i.e. the handler) · `BC15` ✅ (adapter spec) · `BC16` ✅ (relay integration spec, green) · `BC17` ✅ (**dies under P1 and P2**) · `BC18` ✅ (dies under a comment-only fixture; the new cases assert the property directly rather than relying on today's migrations) · `BC19` ✅ (both directions asserted, plus the `credits`-must-stay-exact case) · `BC20` ✅ (verified live by my own queries)

---

## 7. Ruling on the implementer's four declared deviations

| # | Deviation | Ruling |
|---|---|---|
| **D1** | `reconstitute` validates B1/B3 but not B5-per-order | **Justified.** `tasks.md` B4 names exactly B1/B3, and without the omission `CreditReleaseUnderflowError` is unreachable — `releaseHold` always releases the order's *current* exposure, never a caller-supplied amount, so the branch can only be reached through a deliberately corrupted snapshot (`credit-ledger.spec — BC11` does exactly that, in-domain, never through the repository). Documented, asymmetric to `StockItem.reconstitute` for a stated reason. No gate return owed |
| **D2** | a one-line JSDoc fix in `apps/fulfillment/.../outbox-recorder.ts`, beyond task A4's named files | **Justified.** I read the diff: comment text only (`AUTO_INCREMENT (§3.2)` restored, a reflow undone), zero behavioural change, and `OB1`'s byte-identity case cannot pass truthfully without it. The alternative — weakening the guard to tolerate the divergence — would have been the real defect. Fulfillment's 75 tests are green and its spec files are untouched |
| **D3** | all five parked orders advanced, not the two the pre-amendment design predicted | **Not a deviation at all** — it is the *intended* consequence of the human's binding amendment to open point 12, and I verified all five live. Correctly recorded rather than quietly enjoyed |
| **D4** | the DTO's nested field is `amount`, not `minorUnits` as `design.md` §4.2's prose says | **Justified — design-prose imprecision, not drift.** Checked at source: `specs/shared/asyncapi.yaml:1816-1824` defines `Money.properties.amount`, the generated `packages/contracts/.../asyncapi.types.ts:457` reads `amount: Money`, and the existing (unmodified) caller `apps/orders/src/application/saga-command-payloads.ts` already builds `amount: { amount, currency }`. Following the generated contract over the design's paraphrase is the only correct choice; a wire-shape change to match the prose would have broken the live saga |

**None of the four should have returned to the gate.** All four are honestly disclosed, and D2 and D4 in particular are the kind of small truth that a less careful report would have buried.

---

## 8. Non-blocking findings (recorded, not owed for re-review)

- **N1 — `evaluateHold` ranks `already_held` above `currency_mismatch`.** A re-issued `credit.hold` naming the *wrong* currency for an order that already holds is answered `already_held`, not `VALIDATION_FAILED`. Defensible (idempotency dominates, and `BC7`'s reply carries the recorded amount, not the request's), but neither `BC4` nor `BC7` states the precedence and no test pins it. One sentence in `BC7` and one assertion would close it — worth doing whenever this file is next opened, and worth a line in the shared spec so #8/#9 do not order the two checks differently.
- **N2 — `pnpm quality` does not compute coverage**, although `CLAUDE.md` says the ≥80 %/≥60 % gates are "enforced in `pnpm quality`". Pre-existing harness discrepancy (the thresholds live in `vitest.config.mts` and bind only `test:coverage`, which is documented in that file as deliberate until phase 21). Not this feature's to fix; flagged because the sentence in `CLAUDE.md` is currently untrue.
- **N3 — feature 19's own acceptance line** in `feature_list.json` (*"release on compensation and on invoice paid"*) is delivered as an aggregate method with no caller and no responder subject. The gate consciously accepted this (open point 20), and `releaseHold` is properly unit-tested for both reasons — recorded only so the eventual `done` is read with that qualifier, and so the missing `billing.credit.release` subject (open point 10, owner: feature 22/25) is not forgotten.
- **N4 — the bare-JSON NATS (de)serializer pair is now a third byte-identical copy and is still unguarded.** Correctly refused as scope creep and recorded with banners in place; `OB1` is the template when someone arms it.

---

## 9. What must change before re-review

1. **D1 only.** Add the `alwaysRefuse()` handler unit case described in §3, confirm by re-running mutation `M5` yourself that the new case is what kills it (and that nothing else does), and record the case in `specs/billing_credit/requirements.md` §2 and on the `R39` row of `specs/shared/test-matrix.md`.
2. Do **not** touch production code, and do not re-run the world: the re-review will re-probe `M5`, re-read the two traceability rows, and re-run the billing unit suite. Everything else in this pass stands verified.

**Reviewer effort, pass 1:** single session, **2026-08-22 ≈13:26 → 13:55 CEST, ≈29 min**, of which ≈10 min Testcontainers wall-clock (mutated billing integration 234 s + pristine billing integration 112 s + mutated repository spec) and ≈2 min two `pnpm seed` runs against the live stack. All mutated files restored byte-exact and verified (`md5sum -c` / `cmp`); `git status` unchanged at 71 entries; no commit, no push.

---

# Second pass — 2026-08-22

**Pass:** 2
**Verdict:** ✅ **APPROVED.** The single blocking defect (`D1`) is closed, and closed by a test that fails for the *right reason* — I re-armed `M5` myself and watched it die on the fact assertion, not on the reply shape. One non-blocking documentation item (`D2-doc`) is owed before the human commits. `feature_list.json` → `done`; history entry with effort record appended.

## 1. Scope of this pass

Narrow, per the re-review brief and the scope-discipline rule. Everything pass 1 verified stands: 9/10 mutations killed, the live compensation reproduction, the four deviation rulings, the relay parity guard, the seed amendment, the C1–C7 walk. **Re-run here:** billing's unit suite (baseline, mutated ×5, restored), `pnpm quality` (all 10 packages), `./init.sh`. **Not re-run:** the other services' integration suites and the live compensation — nothing outside billing's spec files changed, and I verified that claim by mtime rather than assuming it (§4).

## 2. The new test — read, then attacked

`apps/billing/src/application/credit-hold.handler.spec.ts:154-182`, `describe('CreditHoldHandler.hold — R39, port refusal')`.

It injects a `CreditDecisionPort` that returns `{ kind: 'refuse', reason: 'simulated_cents_rule' }` for a hold that **fits** (`creditLimit: 10_000`, request `4_000`), drives the real `CreditHoldHandler`, and then asserts — this is the part that matters — on `saveCalls[0].pullDomainEvents()`: exactly **one** event, `eventType === 'credit.rejected.v1'`, `payload.reason === 'simulated_cents_rule'`. It observes the **fact recorded on the aggregate that was handed to `save`**, not the reply shape and not a spy on the port. That is the correct observation point: it is the only assertion in the repository that can distinguish "replied rejected" from "replied rejected *and* emitted the fact the saga compensates on".

It is also not vacuous by construction: the refusal reason is bound to a local const and compared in two places (reply and payload), and the fixture is deliberately *satisfiable* — a handler that ignored the port entirely would approve, not reject, so the case cannot pass by accident.

## 3. Mutation evidence — my own runs, not the leader's

Baseline before touching anything: `pnpm --filter @otc/billing test` → **15 files / 57 tests, exit 0**. Backup taken; `sha256(credit-hold.handler.ts) = 87e6678e5d457e3162b649ec15c368ed9417c65ff1077c03f6ef972d1de06708`.

| # | Mutation at `credit-hold.handler.ts:93-104` (the `decision.kind === 'refuse'` branch) | `tsc --noEmit` | Unit suite | Verdict |
|---|---|---|---|---|
| **M5** (re-armed) | `credit.refuseHold(holdRequest, decision.reason, ctx)` **deleted** — reply untouched | exit 0 | **1 failed / 56 passed** — `AssertionError: expected [] to have a length of 1 but got +0` | **KILLED**, by exactly the new case and nothing else. The failure is on the *fact*, which is the point |
| **W1** | fact recorded with the **wrong reason** (`'simulated_failure_rate'` hard-coded; reply still carries `decision.reason`) | exit 0 | 1 failed / 56 passed — `expected {…} to match object { reason: 'simulated_cents_rule' }` | **KILLED** |
| **W2** | fact correct, **reply's `reason` wrong** (`'simulated_failure_rate'`) — reply/fact divergence, the `R44` parity claim | exit 0 | 1 failed / 56 passed — reply `toMatchObject` | **KILLED** |
| **W3** | fact recorded with the **wrong amount** — `refuseHold({ ...holdRequest, amount: Money.of(1, amount.currency) }, decision.reason, ctx)`, so `credit.rejected.v1.requestedAmount` is `1` instead of the order total | exit 0 | **57 passed** | ⚠ **SURVIVED** — see §5 |
| **W5** | `await this.credits.save(credit, tx)` deleted from the branch (fact recorded on an aggregate never persisted) | exit 0 | 1 failed / 56 passed — same `[] to have a length of 1` | **KILLED** |

Restored from the backup after every probe; final `sha256sum -c` → **OK** (byte-identical to the pre-review file), and the restored tree runs **57/57 green** inside the `pnpm quality` run below. Two further variants were considered and not run because the domain already forbids them structurally: passing `'over_limit'` as the adapter's reason throws `CreditRefusalMismatchError` (`buyer-credit.ts:215-218` — a refusal may not lie about why when the amount fits), and an adapter cannot *type* `'over_limit'` at all (`AdapterRejectionReason = Exclude<CreditRejectionReason,'over_limit'>`).

## 4. No source changed, no assertion weakened, the row is accurate

- **Source.** The only file under `apps/billing/src/**` with an mtime after pass 1's verdict (13:45:59) is `credit-hold.handler.ts` (13:50:05) — the leader's re-arm-and-restore, and then mine. Its content is the branch pass 1 read, and its behaviour is now pinned by five mutations. `git diff -- apps/billing/src` shows only the pre-existing wiring changes to `app.module.ts`, `main.ts`, `persistence/client.ts` (identical hunks to pass 1); everything else in this feature is untracked-new.
- **Tests.** The only `*.spec.ts` in the repository with an mtime after 13:46 is `credit-hold.handler.spec.ts` (13:48:22). Every other billing spec is ≤ 12:56, i.e. untouched since implementation. No assertion anywhere was relaxed to accommodate the new case; the file gained a `describe` block and nothing else (the three pre-existing blocks — `BC7`, `BC13`, *reply built after commit* — are byte-unchanged and still green).
- **Traceability.** `specs/billing_credit/requirements.md:108` (`BC14`) now cites `apps/billing/src/application/credit-hold.handler.spec.ts` › *returns rejected with the port's reason and records a credit.rejected.v1 fact when the port refuses a fitting hold* — **verbatim match** to the `it` title, correct path, correct row (`BC14`'s "one code path for every refusal" is exactly what the case proves at handler level). `BC13` is untouched and still accurate.
- **Gates.** `pnpm run quality` (lint + typecheck + test across 10 packages) → **exit 0**: orders 29/390, fulfillment 16/75, billing 15/57, seed 8/119. `./init.sh` → **exit 0**, "1 feature in_progress: billing_credit", 18/39 done, all agent models pinned.

### D2-doc — `specs/shared/test-matrix.md`'s `R39` row was **not** extended (non-blocking, owed before the commit)

Pass 1 §9 item 2 asked for the new case to be recorded in **both** `specs/billing_credit/requirements.md` §2 **and** on the `R39` row of `specs/shared/test-matrix.md`. Only the first was done — `test-matrix.md`'s mtime is 13:19:14, i.e. untouched since before pass 1. The `R39` row's `DONE` column still cites only the domain case plus "integration half: `apps/billing/src/credit-hold.integration.spec.ts`", and that integration citation is **misleading for the port-refusal sub-clause specifically**, because every integration harness binds `AlwaysApproveCreditDecision` and therefore cannot reach the branch at all.

**Why this does not block.** The substance of pass 1's objection — a normative sub-clause with no test that fails when the behaviour is removed — is closed and independently re-proved above. The matrix's own `Level` column for `R39` declares *domain unit*, and the cited domain case does assert both reasons at aggregate level, so the row is incomplete rather than false; the handler-level guard is evidence *above* what the row demands, and it is recorded in the feature's own `requirements.md`. Sending the feature back a second time for one markdown line would cost a full round-trip and change no code, no test and no guarantee — that would be gate theatre, not a gate.

**Why it is nonetheless owed.** `specs/shared/` is what #8 (.NET) and #9 (FastAPI) implement from. A row that names only a domain-level test for `R39` will let both of them reproduce exactly the gap this feature was rejected for. The fix is one clause appended to the `R39` `DONE` column naming the handler case; it is a documentation file the leader may edit without an implementer round-trip, and it should land **before the human commits this feature**. Recorded here so it cannot be lost.

### Correction to pass 1

Pass 1's `C5` box claimed "`git log` head is still `8a35d4e` (feature 17)". That was wrong: head is **`035d8e5` — `feat(fulfillment): despatch advice…` (feature 18), committed 11:32 today**, i.e. *before* this feature's implementation session began. I checked what it contains: **zero** files under `apps/billing` (`git show --stat 035d8e5 | grep -c apps/billing` → `0`). The substance of the box holds — no billing work has been committed, and Claude did not commit — but the citation was stale and is corrected here.

## 5. Ruling on the deeper probe (`W3`) — a real residual gap, correctly non-blocking

`W3` survives: the handler can record a `credit.rejected.v1` whose `requestedAmount` is nonsense while the reply stays correct, and all 57 tests pass. The new case asserts the payload's `reason` and nothing else about the payload.

**Ruling: recorded as a nit, not a defect, and worth one assertion whenever this file is next opened.**

- The clause `R39` actually states is *"emit `credit.rejected.v1` … with a machine-readable reason"*. The reason is the field the saga branches on, and it is pinned at three levels now. `requestedAmount`/`availableCredit` are diagnostic payload, and `BC14`'s field-by-field parity test (`credit-hold.spec.ts:110-140`, `normalise()` strips only `eventId`/`occurredAt`/`reason` and asserts `toEqual`) already proves the aggregate builds them identically for both refusal kinds.
- The mutation is also implausible in a way `M5` is not: `holdRequest` is constructed once at `credit-hold.handler.ts:45` and shared by the `over_limit` branch, whose payload arithmetic **is** asserted at unit, integration *and* live level (pass 1 §4 read `requestedAmount: 354984` / `availableCredit: 350006` out of the real outbox). A regression would have to corrupt one branch's copy only.
- It is nonetheless a genuine hole in the *new* test's resolution, and it costs nothing to close: extend the existing assertion to `expect(events[0]?.payload).toMatchObject({ reason: refusedReason, requestedAmount: 4_000, availableCredit: 10_000 })`. Recorded as **N5**; fold it into the same touch as `D2-doc` if the leader wishes, or into feature 20, which is the first code that will ever execute this branch in anger.

The three mutations that *would* corrupt the saga — no fact (`M5`), unpersisted fact (`W5`), wrong reason (`W1`), and the reply/fact divergence `R44` forbids (`W2`) — are all dead. That is the right resolution for a one-test fix.

## 6. `CHECKPOINTS.md` — the three boxes pass 1 left open

- **C5** — [x] `progress/history.md` entry with effort record — written at this approval (§below in `history.md`)
- **C6** — [x] every `R<n>` covered by a concrete named test — `R39`'s port-refusal sub-clause now dies under `M5`, `W1`, `W2` and `W5`, verified personally; `R37`, `R38`, `R40`, `R41` unchanged from pass 1
- **C7** — [x] effort records complete
- **C5** — [x] `feature_list.json` reflects true state (set `done` by this verdict)
- **C5** — [x] Claude did not commit — head is `035d8e5`, which contains no billing file (correction above)

All other boxes carry forward from pass 1 §5 unchanged, re-confirmed by the green `pnpm quality` and `./init.sh` runs above.

## 7. Standing rule — yes, this shape now warrants one

**This is the second `FS5`-shaped defect in three features** (`fulfillment_stock`'s `FS5`, feature 17; `billing_credit`'s `D1`, feature 19 — and feature 18 escaped only because its fact-emitting branch had a caller). The shape is stable enough to name: **correct code, on a branch with no live caller, whose fact-emission is guarded by structure and a comment rather than by a test that fails when the emission is deleted.** Both times the whole suite stayed green under deletion; both times the cost of the fix was one unit test; both times it was found by a reviewer's mutation rather than by the suite.

**Recommended standing rule for features 20–39, to be added by the leader to `CLAUDE.md` § Testing conventions and — because it is stack-agnostic and #8/#9 need it more than we do — to the preamble of `specs/shared/test-matrix.md`:**

> **The fact-emission mutation.** For every branch that emits, or deliberately suppresses, a domain fact, the implementer arms the deletion of that emission themselves before submitting, and records in `progress/impl_<feature>.md` which named test failed and with what message. A branch whose fact-emission survives its own deletion with a green suite is not done. This applies with double force to branches that have no caller yet: "feature N will be its first caller" is precisely the condition under which no test exists.

It is cheap (the implementer already has the file open), it is self-reporting (the report names the killing test, so the reviewer verifies rather than discovers), and it generalises the rule feature 17's history entry already records — *mutate the sub-clauses of the requirement, not only the branches of the design* — into a mechanical step. Adding it to `specs/shared/` also closes `D2-doc`'s trilogy risk generically, which one extra matrix citation would not.

## 8. Reviewer effort, pass 2

Single session, **2026-08-22 ≈13:51 → 13:58 CEST, ≈7 min**, no Testcontainers (the claim under test is a unit-level guard): 1 baseline unit run, 5 mutated unit runs + 5 `tsc --noEmit` runs, 1 `pnpm quality` (10 packages), 1 `./init.sh`, plus the traceability reads. `credit-hold.handler.ts` restored byte-exact and verified by `sha256sum -c`; `git status` at 72 entries, unchanged; no commit, no push.
