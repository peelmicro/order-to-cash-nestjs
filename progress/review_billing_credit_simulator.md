# review: billing_credit_simulator (feature 20, phase 10)

**Verdict: APPROVED** — 0 blocking defects, 6 non-blocking findings, **7/7 hostile mutations killed** (one of them at the type level, one at integration level against the *binding* rather than the adapter).

Reviewed against the `feature_list.json` acceptance list (`sdd: false`, no `specs/billing_credit_simulator/`), `specs/shared/requirements.md` **R42/R43/R44** and its §5.1 boxed warning, and `CLAUDE.md`.

---

## 1. Scope discipline — what I ran, and what I did not

The declared footprint is one new adapter, one binding change, one added assertion in an existing spec, plus two new spec files and the test-matrix/state files. `git status` and `git diff --stat` confirm it **exactly** — six modified files, four untracked, **nothing outside `apps/billing/`, `specs/shared/test-matrix.md`, `feature_list.json` and `progress/`**:

```
 M apps/billing/src/app.module.ts                     | 25 +++++++++++++-----
 M apps/billing/src/application/credit-hold.handler.spec.ts |  2 +-
 M apps/billing/src/infrastructure/credit/always-approve-credit-decision.ts | 25 +++++-----
 M feature_list.json | 2 +-   M progress/current.md | 6 +-   M specs/shared/test-matrix.md | 8 +-
?? apps/billing/src/credit-rejection-parity.integration.spec.ts
?? apps/billing/src/infrastructure/credit/simulator-credit-decision{,.spec}.ts
?? progress/impl_billing_credit_simulator.md
```

`apps/orders`, `apps/fulfillment`, `apps/seed`, `packages/*`, `infra/`, `n8n/` and every migration are untouched, so **I did not re-run their integration suites** — nothing in the diff can reach them, and `pnpm quality` re-ran their unit suites anyway (390 + 75 + 119 green). What I did run myself: billing's unit suite, billing's **full** integration suite (the claim under test *is* the binding, and the binding is compiled by every billing harness), `pnpm quality`, `./init.sh`, billing coverage, and seven mutation probes of my own.

| Run | Result |
|---|---|
| `apps/billing` unit (`pnpm exec vitest run`) | **16 files, 64 tests passed** — matches the implementer's claim |
| `pnpm --filter @otc/billing test:integration` (Testcontainers mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1) | **9 files, 30 tests passed**, exit 0, 160.16 s — matches the claim; feature 19's four harnesses green **against the simulator binding** |
| `pnpm quality` (lint → typecheck → test, whole monorepo) | pass — billing 64, fulfillment 75, orders 390, seed 119, contracts 22, shared-kernel green |
| `pnpm exec vitest run --coverage` (billing) | **domain 95.58 % lines / 89.47 % branches**, **all files 97.74 % lines** — clears ≥80 % domain, ≥60 % overall |
| `./init.sh` | exit 0, 39 features parsed, "no feature in_progress", 19/39 done |

---

## 2. Acceptance list

| Acceptance criterion | Verdict |
|---|---|
| rejects `totalAmount % 100 === 99` deterministically | **MET** — `simulator-credit-decision.ts:66`; determinism proved by probe P1 below at five credit levels and four `random()` draws |
| `CREDIT_FAILURE_RATE` defaults to 0 | **MET** — `simulator-credit-decision.ts:46-48`; `undefined` **and** `''` both yield `{ failureRate: 0 }` |
| sits behind the credit port | **MET** — the diff touches **no** domain, application, presentation, port, DTO or fact-builder file. `SimulatorCreditDecision implements CreditDecisionPort` and is constructed only inside `app.module.ts`'s `useFactory` |

---

## 3. Probes (real output)

### P1 — R42, the "regardless" clause

The requirement's load-bearing words are *regardless of the retailer's available credit*. The shipped unit test uses one ample-credit case; I widened it. A `.99` total is refused at **every** credit level — including `availableCreditMinorUnits = Number.MAX_SAFE_INTEGER`, i.e. comfortably fitting — and at `0`, `1`, `24_999` and `500_000`; and refused for `99`, `199`, `10_999_999` and `24_999`; and **not** refused for `98`, `100`, `24_909`, `24_998`, `25_000`, `0`. All green. The predicate is exactly `mod 100 = 99`, neither wider nor narrower, and it reads `amountMinorUnits` only — `availableCreditMinorUnits` is never consulted on that branch, so the "regardless" clause is a structural property, not a tested coincidence.

### P2 — R43, is the rate actually applied?

The shipped tests pin the comparison at its boundary (`draw 0.4 < rate 0.5` refuses, `draw 0.5` does not, `rate 0` at `draw 0` does not). They do not measure a *proportion*, so I measured one: a deterministic LCG fed in as the injected `random`, 200 000 draws per rate, non-`.99` amount throughout.

```
rate=0     observed=0.0000  refused=0/200000
rate=0.1   observed=0.1024  refused=20490/200000
rate=0.3   observed=0.3059  refused=61176/200000
rate=0.75  observed=0.7525  refused=150504/200000
rate=1     observed=1.0000  refused=200000/200000
```

Every observation within 1 pp of the configured rate (the residual is my LCG's low bits, not the adapter), every refusal carried `reason: 'simulated_failure_rate'`, `rate = 0` refused **nothing** in 200 000 draws and `rate = 1` refused everything. The rate is genuinely applied.

### P3 — R43, fail fast rather than clamp

Every boundary the brief named, each throwing synchronously with the **offending value present in the message**:

```
bad="-0.1"        -> CREDIT_FAILURE_RATE must be a number in the closed interval [0, 1]; got "-0.1"
bad="1.1"         -> ... got "1.1"
bad="abc"         -> ... got "abc"
bad="NaN"         -> ... got "NaN"
bad="Infinity"    -> ... got "Infinity"
bad="-0.0000001"  -> ... got "-0.0000001"
bad="1.0000001"   -> ... got "1.0000001"
```

`'0'` → 0, `'1'` → 1 (both endpoints of the **closed** interval accepted, as R43 words it), `''` and absent → 0. The throw is unguarded inside `app.module.ts`'s `useFactory`, so it propagates out of Nest's container construction and `main.ts` never reaches `listen()` — verified by reading the wiring; I did not re-boot the live stack, and the implementer's reasoning for not doing so a third time is accepted. Two `Number()` coercion quirks survive — see **N3**.

### P4 — Rule precedence

Claim: the `.99` check runs first and wins unconditionally. Verified in code (`simulator-credit-decision.ts:66` precedes `:75`) and by probe: for the cross-product of `failureRate ∈ {0, 0.5, 1}` × `random() ∈ {0, 0.25, 0.5, 0.9999}` — twelve combinations, including every one in which the failure-rate branch would also have fired — a `.99` amount returns `simulated_cents_rule` in all twelve. Pinned by a named test (`the cents rule wins over the failure-rate rule when both could apply`, `failureRate = 1`, `random = 0`), and mutation **M1** confirms that test dies if the ordering is removed. Code matches the claim.

### P5 — R44, field by field

I compared the two `credit.rejected.v1` payloads and then went one level below the test, because the test's own parity assertion is weaker than it looks (**N1**).

| Field | `simulated_cents_rule` (24 999 vs 500 000 limit) | `over_limit` (20 000 vs 10 000 limit) | Same? |
|---|---|---|---|
| `eventType` | `credit.rejected.v1` | `credit.rejected.v1` | ✅ |
| `orderReference` | present, the requested order | present, the requested order | ✅ |
| `retailerCode` / `companyCode` / `creditCode` | present | present | ✅ |
| `currency` | `EUR` | `EUR` | ✅ |
| `requestedAmount` | `24_999` | `20_000` | ✅ same field, both the true amount |
| `availableCredit` | `500_000` | `10_000` | ✅ same field, both the true availability |
| `reason` | `simulated_cents_rule` | `over_limit` | ❗ **the only difference** |
| key set | 8 keys | 8 keys, `Object.keys().sort()` asserted equal | ✅ |
| ledger rows written | 0 | 0 | ✅ |
| outbox rows | exactly 1, `publishedAt` set | exactly 1, `publishedAt` set | ✅ |
| RPC reply | `outcome: 'rejected'` | `outcome: 'rejected'` | ✅ |

**Structurally, not just observably:** `credit-events.ts:78-87` builds the payload from a single object literal with eight fixed keys, in `creditRejectedEvent`, which has exactly **one** call site — `BuyerCredit.refuseHold` (`buyer-credit.ts:214-233`). There is no branch anywhere in the domain, the application layer, the outbox record or the RPC reply that distinguishes an adapter refusal from an aggregate refusal; `reason` is a parameter. Feature 19's `credit-hold.spec.ts:110` already asserts this as a normalised whole-envelope `toEqual` with `eventId`/`occurredAt`/`reason` stripped. R44's "same fact type, same payload shape, same compensation path" is therefore a property of the code, not of the fixtures.

**R37 unbypassed:** the genuine `over_limit` rejection is reachable *with the simulator bound and the rate at its default* — proved at integration level in this very suite (the R44 test uses `20_000`, deliberately non-`.99`, and gets `over_limit` from the aggregate), and live by the implementer (`ORD-000017`). Belt and braces: `refuseHold` throws `CreditRefusalMismatchError` if `over_limit` is claimed while the amount actually fits, so the simulator cannot even borrow the word by accident.

### P6 — The port's contract

`decide` performs **no I/O**: the whole method is two comparisons and three object literals (`simulator-credit-decision.ts:63-80`), the class holds no client, pool, socket or clock, its only import is `import type` (erased at compile time), and it is constructed with an injected `random` plus a plain config object. Nothing can hold the credit line's row lock across a network call. The shipped test `never performs I/O and resolves synchronously` asserts the return is not a `Promise` — worth keeping, though it is the weaker half of the guarantee; the strong half is that there is nothing in the class *to* await.

**The type system still forbids `over_limit`** — see mutation M4: it does not compile, with the exact error the port's header promises.

---

## 4. Mutations — 7 armed, 7 killed, all restored byte-exact

Every restore verified by `sha256sum`; the final `git status` and `git diff` are identical to the pre-review state.

| # | Mutation | File | Result |
|---|---|---|---|
| **M1** | delete the `.99` branch entirely | `simulator-credit-decision.ts:66-68` | **KILLED** — 2 failed / 9 passed. `expected { kind: 'approve' } to deeply equal { kind: 'refuse', reason: 'simulated_cents_rule' }` and the precedence case |
| **M2** | invert the rate comparison (`<` → `>=`) | `:75` | **KILLED** — 3 failed / 4 passed, including *approves an amount that does not end in 99 when the failure rate is zero* |
| **M2b** | loosen the comparison by one boundary (`<` → `<=`) | `:75` | **KILLED** — 2 failed / 5 passed. The suite is **boundary-tight**: `rate 0, draw 0` and `rate 0.5, draw 0.5` both discriminate |
| **M3** | clamp instead of throw (`Math.min(1, Math.max(0, r))`, `NaN → 0`) | `:50-53` | **KILLED** — `AssertionError: expected [Function] to throw an error` |
| **M4** | adapter returns `over_limit` | `:67` | **KILLED at compile time** — `error TS2322: Type '"over_limit"' is not assignable to type 'AdapterRejectionReason'`. It does not typecheck, exactly as the brief anticipated |
| **M5** | corrupt `requestedAmount` in the single `refuseHold` fact builder (`+ 1`) | `buyer-credit.ts:227` | **KILLED** by `credit-hold.handler.spec.ts` — see §5 |
| **M6** | revert the binding to `AlwaysApproveCreditDecision` (adapter file untouched) | `app.module.ts:78` | **KILLED at integration level** — `expected { outcome: 'approved', …(5) } to match object { outcome: 'rejected', …(2) }`. The integration spec pins the **wiring**, not merely the class |

M6 is the one I most wanted. A simulator that is correct but unbound is the exact failure mode this feature could have shipped, and it is invisible to every unit test; the parity spec compiles the real `AppModule` with no `overrideProvider`, so it dies when the binding moves.

---

## 5. The folded-in nit from feature 19 (N5), re-armed

Feature 19 was approved with a residual: the port-refusal test asserted only `reason`, so a fact carrying a corrupted `requestedAmount` survived with a green suite. I re-armed that exact mutation and ran it against **both** versions of the assertion:

```
--- with feature 20's strengthened assertion:
  × returns rejected with the port's reason and records a credit.rejected.v1 fact when the port refuses a fitting hold
    AssertionError: expected { orderReference: 'ORD-000001', …(7) } to match object { Object (reason, requestedAmount, ...) }
    -   "requestedAmount": 4000
    +   "requestedAmount": 4001
    Tests  1 failed | 3 passed (4)

--- same mutation, with the PRE-feature-20 assertion ({ reason } only):
    Tests  4 passed (4)
```

The nit is genuinely closed: the strengthened assertion is the thing that kills it, and the old one demonstrably did not. **N5 from `review_billing_credit.md` is closed.**

---

## 6. Ruling on the binding decision

Two questions were put to me. I rule on both.

**(a) Is binding the simulator unconditionally — no env flag — correct? YES, and an env toggle would be a regression.** R42/R43's `WHERE the credit-check simulator is the adapter bound to the credit port` is EARS's *variant precondition*: it scopes when the requirement holds, it does not mandate a runtime switch. §5.1 describes the removal mechanism as *"swapping the adapter"*, and a one-line change to a `useFactory` is a swap; `specs/billing_credit/design.md:441` had already fixed feature 20's footprint as "that one provider". Positively against a toggle: §5.1's **trilogy obligation** requires the demo script, the API tests and the end-to-end tests of #7, #8 and #9 to place a `.99` order and see it cancelled — a flag that defaults *off* breaks all three, and a flag that defaults *on* is decorative while adding a second configuration axis that R43's start-up validation does not police. The implementer's reasoning is sound and I endorse it.

**(b) Is `AlwaysApproveCreditDecision` dead code, a retained test double, or a deployment option?** It is **a retained reference adapter and latent test double — keep it, do not delete it, and do not make it env-selectable.** Evidence: `grep` finds exactly one non-comment consumer, its own spec (`always-approve-credit-decision.spec.ts`, 2 instantiations). So it is unbound. But "unbound" is not "dead": it is five lines, it is the port's minimal reference implementation that `design.md` §6.3 documents and `BC15` asserts, it is what a future harness will reach for via `overrideProvider` when it wants approve-everything without the `.99` rule, and it is read by #8 and #9 as the shape of the seam. Deleting it would delete a passing spec and a documented reference for a saving of five lines. A *deployment* option it is not — an adapter that approves every request regardless of anything is not a production credit policy, and promoting it to an env-selectable binding would create exactly the "which adapter is live?" ambiguity that (a) rejects.

One qualification, recorded as **N5** below: the file's new header justifies its retention partly by *"for any harness that wants approve-everything behaviour without the simulator's rules"* — no harness does, today. Speculative generality stated as fact. Trim the claim to the honest one (reference implementation for the port, and the override a future harness may bind) or give it a real consumer.

**Feature 19's harnesses:** `credit-integration-harness.ts:123` is `Test.createTestingModule({ imports: [AppModule] }).compile()` with **no** `overrideProvider`, so all four feature-19 integration specs now genuinely execute against the simulator. I verified independently that no fixture amount is `≡ 99 (mod 100)` — every one is a round thousand (`1_000`, `10_000`, `20_000`, `25_000`, `30_000`, `35_000`, `45_000`, `50_000`, `100_000`) — and the suite passes unchanged, 30/30. See **N2** for the durability of that.

---

## 7. Requirement → test mapping (verified, not read)

| Req | Test(s) I confirmed exercise it | How I confirmed |
|---|---|---|
| **R42** | `apps/billing/src/infrastructure/credit/simulator-credit-decision.spec.ts` › `— R42` › *rejects a total whose minor units end in 99 … even when the retailer has ample credit* + *the cents rule wins over the failure-rate rule when both could apply*; **integration**: `apps/billing/src/credit-rejection-parity.integration.spec.ts` › *R42 — rejects a fitting hold whose total ends in 99 minor units…* | mutations **M1** (unit) and **M6** (integration binding) both KILLED; probe **P1** widened the "regardless" clause to five credit levels |
| **R43** | same file › `— R43` › *defaults the failure rate to zero, rejects a configured proportion when set, and fails to start reporting the offending value…* + *…only when the random draw falls below the configured rate, and never at a zero rate* + *a failure rate of 1 rejects every non-99 amount* | mutations **M2**, **M2b**, **M3** KILLED; probe **P2** measured the proportion over 200 k draws; probe **P3** walked all six boundaries |
| **R44** | `credit-rejection-parity.integration.spec.ts` › *R44 — a genuine over-limit rejection is still reachable with the simulator bound and CREDIT_FAILURE_RATE at its default of zero…*; structurally underwritten by `credit-hold.spec.ts:110` (BC14) and the single-builder/single-call-site design of `creditRejectedEvent` | probe **P5** field-by-field table above; **M4** proves the adapter cannot say `over_limit` at all |
| feature-19 nit | `credit-hold.handler.spec.ts` › *…records a credit.rejected.v1 fact when the port refuses a fitting hold* | **M5** re-armed: kills with the new assertion, survives with the old one |

Test-matrix flips are **confined to R42/R43/R44**, plus one factual correction to R39's note (its claim that "the integration harness binds an always-approve adapter and therefore cannot reach that branch" became false the moment this feature landed — updating it was mandatory, not scope creep). No other row moved.

---

## 8. `CHECKPOINTS.md` — walked

### C1 — the harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist
- [x] `progress/current.md` and `progress/history.md` exist
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer
- [x] every agent definition declares its model (`init.sh` §2 all OK)
- [x] `./init.sh` exits 0

### C2 — state is coherent
- [x] at most one feature `in_progress` — zero; this one was `in_review`, set `done` by this review
- [x] every status is in `rules.valid_status`
- [x] every `done` feature has passing tests — billing 64 unit + 30 integration re-run here
- [x] `progress/current.md` describes the active session (feature 20), not leftovers
- [x] no `blocked` features

### C3 — architecture is respected
- [x] no `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats`, `mongodb` inside any `domain/` — grep of `apps/billing/src/domain/` returns nothing; ESLint clean in `pnpm quality`
- [x] no cross-service DB access — this feature performs **no** database access at all
- [x] no shared runtime code beyond `shared-kernel` / `contracts` — the new file's only import is a local `import type`
- [x] `packages/shared-kernel` untouched, still dependency-free
- [x] every interaction classifiable as Kafka-fact or NATS-RPC — **no new interaction**: the adapter is an in-process port call inside an existing NATS-RPC handler; the fact it causes is the pre-existing `credit.rejected.v1` on Kafka via the outbox
- [x] no stray debug logging, no context-free TODOs — grep of all touched files: zero `console.`/`TODO`/`FIXME`
- [x] explicit DI: `SimulatorCreditDecision` is undecorated and built inside `useFactory` with literal arguments — no bare-type inference anywhere

### C4 — verification is real
- [x] `pnpm quality` passes (lint + typecheck + full unit suite, monorepo-wide)
- [x] domain tests pure — the new unit spec imports only `vitest` and two local modules; no framework, no DB, no broker, randomness injected
- [x] integration tests use Testcontainers against real MySQL/Kafka/NATS — `credit-rejection-parity.integration.spec.ts` compiles the real `AppModule`; no mocked broker
- [x] coverage: billing **domain 95.58 %** (≥80), **overall 97.74 %** (≥60)
- [x] no Jest anywhere

### C5 — the session closed cleanly
- [x] no suspicious untracked files — the four untracked paths are this feature's own artefacts; my probe file was deleted and my seven mutations restored byte-exact (sha256 verified)
- [x] `progress/history.md` has an entry for this feature **including its effort record** — appended by this review
- [x] `feature_list.json` reflects true state — feature 20 → `done`
- [x] the human will be told what was done and how to test it manually — the leader's report, drawn from `progress/impl_billing_credit_simulator.md` §Verification
- [x] Claude did not commit — no `git commit`, no `git push` in this review

### C6 — SDD
- n/a for this feature (`"sdd": false`, no spec phase and no human gate by design); the global boxes still hold — `init.sh` reports "SDD coherence: 5 sdd feature(s) past pending have their triple-doc", and R42/R43/R44 are recorded in `specs/shared/test-matrix.md` against concrete named tests
- [x] every `R<n>` covered by at least one concrete named test, recorded in the matrix

### C7 — trilogy reusability
- [x] `specs/shared/` stays stack-agnostic — the sketch column of the three touched rows keeps its neutral `billing/…/credit-simulator.spec` form; only the "Actual" column names #7 paths, exactly as every other row does
- [x] `n8n/workflows/*.json` untouched
- [x] `progress/history.md` effort records complete and honest — this feature's is appended below, including the mtimes I myself rewrote

---

## 9. Findings (6, none blocking)

**N1 — the R44 parity assertion is weaker than its comment claims.** `apps/billing/src/credit-rejection-parity.integration.spec.ts:131-132` compares the over-limit payload's key set against a **hard-coded literal array**, under a comment reading *"Same shape as the simulated rejection above"*. It never touches the simulated payload the sibling test observed, and that test asserts its payload with `toMatchObject` (subset semantics). So if `credit.rejected.v1` ever grew a ninth key on the simulated path only — the precise thing R44 forbids — both tests would stay green. Non-blocking because parity is guaranteed one level down (single builder, single call site, eight-key literal — `credit-events.ts:78-87`) and feature 19's `credit-hold.spec.ts:110` does the real normalised whole-envelope comparison. **Why it matters:** #8 and #9 will copy this spec, and in a stack where the payload is assembled per-branch the literal list stops being a tautology and starts being a lie. Fix: hoist the simulated payload's `Object.keys().sort()` into a shared `let` and compare the second against *it*.

**N2 — every future billing integration fixture is now silently subject to the `.99` rule, and the only guard is a comment.** With the simulator bound unconditionally and `credit-integration-harness.ts:123` compiling the real `AppModule` without overrides, an implementer who picks `19_999` as a fixture amount in 2027 gets an inexplicable `simulated_cents_rule` in a test about something else. Today's four harnesses are safe (verified independently: all round thousands), but the protection is a prose list of four filenames in `app.module.ts`'s header, which rots the moment a fifth spec is added. **Why it matters:** it is the cheapest possible future time-sink — a mysterious failure in an unrelated feature. Fix: one cheap durable guard, e.g. a unit test asserting that no amount literal in `src/**/*.integration.spec.ts` is `≡ 99 (mod 100)`, or a `harness.amount()` helper that refuses such values.

**N3 — `loadCreditSimulatorConfig` inherits `Number()`'s coercion quirks.** `simulator-credit-decision.ts:49` uses `Number(raw)`, so `CREDIT_FAILURE_RATE='   '` (whitespace) silently yields `0`, and — the interesting one — `CREDIT_FAILURE_RATE='0x1'` silently yields **`1`, i.e. reject every non-`.99` hold**. Both verified by probe. Strictly R43 is not violated (`0x1` *is* the number 1 under JS semantics), which is why this is not a defect, but a value that turns the demo into "everything is rejected" while looking like a near-zero rate is exactly the *"non-reproducible for invisible reasons"* shape R43's last clause exists to prevent. Fix: one added guard, e.g. reject any `raw` not matching `/^\d*\.?\d+(?:[eE][+-]?\d+)?$/` after `trim()`.

**N4 — the standing fact-emission rule adopted at feature 19's approval is still not written down where it binds.** `progress/history.md` records the rule as *"to be added to `CLAUDE.md` § Testing conventions and to the preamble of `specs/shared/test-matrix.md`"*. `grep` finds it in **neither** file. This implementer complied anyway (`progress/impl_billing_credit_simulator.md` § *Armed-deletion evidence* names the failing test and quotes its message, and I re-verified that deletion myself as M1), so nothing is at risk *here*. **Why it matters:** the rule is the cheapest defect-finder this project has produced, it has now prevented the shape that rejected features 15, 17 and 19, and it currently survives only as prose in a history file that #8 and #9 will not read as normative. Owed by the **leader**, not the implementer.

**N5 — `always-approve-credit-decision.ts:10-12` justifies its own retention with a consumer that does not exist** (*"for any harness that wants approve-everything behaviour without the simulator's rules"* — no harness does). See my ruling in §6(b): keep the class, trim the claim to what is true (the port's reference implementation, and the `overrideProvider` a future harness may bind).

**N6 — the stack-agnostic sketch column still points at the wrong layer.** `specs/shared/test-matrix.md` R42/R43 keep `billing/domain/credit-simulator.spec` in the *sketch* column while the thing is, correctly, an infrastructure adapter (§5.1: *"they live behind the credit port"*). The implementer flagged the deviation honestly and fixed the "Actual" column, but the sketch is what #8 and #9 build from, and it will lead both of them to put an adapter's test in the domain layer — where a domain-purity rule will then fight it. One-word fix: `billing/infrastructure/credit-simulator.spec`.

---

## 10. Integrity of the tree after review

Seven mutations across three source files, all restored and verified:

```
6891dfea…d6a4363f  apps/billing/src/infrastructure/credit/simulator-credit-decision.ts
e7d1114f…55c56650  apps/billing/src/app.module.ts
4d2b3a07…a2529251  apps/billing/src/domain/buyer-credit.ts
```

One incident, disclosed: while restoring M5 I ran `git checkout --` on `apps/billing/src/application/credit-hold.handler.spec.ts`, which reverted the implementer's one-line assertion change. I restored it immediately; `git diff` for that file is now byte-identical to its pre-review form (same blob pair `9d3c5b2..65c2b4a`, same single-line hunk at :180). My temporary probe spec was deleted. Final `git status` matches the pre-review status exactly — six modified, four untracked, nothing else.

**Verdict: APPROVED.** `billing_credit_simulator` → `done`.


---

## Leader response to N4 (2026-08-22)

**N4 is not correct — the rule is present and committed.** `CLAUDE.md` § Testing conventions carries it (committed in `c3f8e85`), and the `specs/shared/test-matrix.md` preamble carries it (committed in `b85ce96`, the feature-19 spec commit). Verified against `git show HEAD:` for both files, not just the working tree. The likely cause is that the check ran against a tree state predating those two commits, or grepped a phrase that does not appear verbatim.

Recorded rather than silently dropped, because a reviewer finding that does not hold up is worth the same visibility as one that does — it is the first in this project, and the process depends on findings being checked rather than assumed correct in either direction.

The other five findings (N1, N2, N3, N5, N6) stand and are carried forward.
