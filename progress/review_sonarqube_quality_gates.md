# review: sonarqube_quality_gates (feature 34, phase 21)

**Verdict: APPROVED** — 2026-08-29, first review. Both acceptance criteria are met and independently verified. Five defects recorded below, none blocking; **D1 and D2 must be corrected before the human commits** (both are one-line documentation/debris fixes, no behaviour change).

`sdd: false` — no `specs/<feature>/` required, so C6 does not apply to this feature. Acceptance criteria are the two verbatim lines in `feature_list.json`.

## What I ran, and what I deliberately did not

I did not re-run the implementer's own fulfillment probe. Per `CLAUDE.md`'s reviewer guidance, re-running a suite the implementer just ran is duplicated cost; the value is in independent mechanisms. What I ran myself, all from a clean tree:

1. `pnpm run quality` clean — **exit 0, wall-clock 1:12.38**, zero `ERROR: Coverage` lines, all 10 workspaces reporting. SonarQube confirmed absent first (`docker ps -a | grep -i sonar` → *no sonar container at all*).
2. Three armed mutations against the two new seed test files (§3).
3. My own gate-failure probe, by a **different mechanism** from the implementer's (§4) — raising all six services' domain-tier numbers to 100 rather than excluding specs from the run. One run, maximum evidence: it proves the glob is live *per service*, which excluding fulfillment's specs could not.
4. The `--no-bail` **counterfactual** (§5) — the same broken state run *without* `--no-bail`.
5. `apps/seed` coverage re-measured with the exclusions removed (§2), to establish whether the exclusion is load-bearing or cosmetic.
6. Final `pnpm run test:coverage` — exit 0, 36.29s, all ten `coverage/lcov.info` present.

`git diff --stat` is byte-identical to the pre-review state (9 files, 167 insertions, 33 deletions); every armed file restored. No `coverage/`, `lcov.info` or probe artefact is staged — `.gitignore` already carries `coverage/` and `*.lcov`, and `git status --porcelain` shows only the 9 modified + 4 untracked feature files.

## Acceptance criteria

| Criterion | Verdict | Evidence |
|---|---|---|
| coverage gates enforced in `pnpm quality` independently of SonarQube | **MET** | `quality` now chains `test:coverage` (`package.json`); clean run exit 0 in 1:12 with no SonarQube container in existence; violation run exit 1 (§4). Enforcement lives in each workspace's `vitest.config.mts`, which has no SonarQube dependency of any kind. |
| ≥80% domain, ≥60% overall | **MET, with real headroom** | Measured independently, domain layer only (§4): orders 98.52/91.25/…, gateway 98.33/88, projector 97.7/88.88, billing 94.77/88.88, fulfillment 94.62/92.3 (stmts/branches) — every metric of every service well clear of 80. `shared-kernel` (pure domain) 100% on all four. Overall per workspace: lowest is projector 85.37% stmts / 68.88% branches — all clear of 60. `notifications` domain tier is **vacuous** (§6). |

## 1. The `apps/seed` exclusion — does the integration-coverage claim hold?

**Substantially yes, with one factually wrong sentence in the justification (D1).**

I read `apps/seed/src/seed.integration.spec.ts` line by line rather than trusting the summary. It is not an import-and-touch: its `runFullSeed()` helper (lines 127–135) calls **all six** writer entry points directly against a real Testcontainers MySQL — `seedOrdersMasterData`, `seedFulfillmentStock`, `seedBillingCredits`, `seedOrdersSagas`, `seedFulfillmentSagas`, `seedBillingSagas` — and the assertions are real outcomes, not smoke:

- concrete row counts through `verifySeed` (6 orders, 5 despatches, 5 invoices, 6 Mongo timelines, lines 159–162);
- **idempotency** by running the entire seed a second time and asserting `expect(after).toEqual(before)` plus an `MD5(GROUP_CONCAT(id))` checksum over `orders` (lines 165–186) — this is the strongest of the assertions, because it can only pass if the writers' upsert semantics genuinely work;
- every `outbox` row across all three databases published and carrying a `causation_id` (lines 204–280);
- an `OutboxRelay` run over all three databases with a publisher that must never be called.

`verifySeed` — the `verify.ts` half that is excluded — is called **three times** with its results asserted, exactly as claimed. So the three writers and `verifySeed` are genuinely exercised, and the exclusion is not a number-laundering move.

**Is the exclusion load-bearing?** I removed it and re-measured. Without it, `apps/seed` reports 67.98% stmts / **48.52% branches** / 67.54% funcs / 65.4% lines: three of the four metrics clear 60 on their own, and **only the branch metric fails**. So the exclusion is needed, but only for branches — and the file responsible is `verify.ts` at **40.4% stmts / 14.28% branches**, not the writers (which are a clean 0%/0% and genuinely unreachable without Docker).

**D1 (non-blocking, must fix before commit) — `apps/seed/vitest.config.mts`, lines ~50–52.** The config states of `verify.ts`: *"The rest, `verifySeed`, is Drizzle + MongoDB read I/O **with no branch logic of its own to lose**"*. That is measurably false. `verify.ts` contains roughly twelve `if (…) throw new SeedVerificationError(…)` guards (lines 44, 59, 163, 171, 198, 208, 223, 231, 241, 244, 247, 255, 259, 278, 283), and the coverage tool scores the file at **14.28% branch coverage** — the integration spec exercises only the non-throwing side of every one of them. This is the single sentence that tells a future reader "nothing is being hidden here", and it is attached to the one file whose exclusion is what carries `apps/seed` over the branch gate. The exclusion decision itself is defensible and the honest alternative is already named in the config (split the file; declined as a production change out of scope) — but the sentence must be corrected to say what is true: *the throw-branches are unhit by either suite; only the happy path is integration-covered.* A reader must not be told there is no branch logic when there are twelve branches at 14%.

The other four entries' justifications are accurate: the three writers are 0%/0% under the unit run and fully exercised by the integration spec; `src/index.ts` really is try/finally + `.then/.catch` orchestration with nothing else in it (I read all 79 lines).

## 2. The two new test files — armed

Both assert real behaviour. I armed three separate mutations and every one was caught by a **named** test with a message that points at the actual defect:

| Mutation (source, restored) | Test that failed | Message |
|---|---|---|
| `mongo-config.ts`: default port `27017` → `27018` | `loadMongoConfig > falls back to the documented defaults when the env carries none of the keys` | `AssertionError: expected { Object (host, port, ...) } to deeply equal { … }` |
| `mongo-config.ts`: dropped `encodeURIComponent` on `user` | `mongoConnectionUri > percent-encodes credential characters that are not URL-safe` | `expected 'mongodb://user@name:…' to be 'mongodb://user%40name:…'` |
| `currencies.data.ts`: deleted the `if (!found) throw` guard | `currencyIdByCode > throws, naming the code, for an unknown currency code` | `expected [Function] to throw error matching /currencyIdByCode: unknown currency co…/ but got 'Cannot read properties of undefined (…'` |

Result: `Test Files 2 failed | 8 passed (10) — Tests 3 failed | 136 passed (139)`. Note the third: the mutant still threw, just a different error, and the regex-matched `.toThrow` correctly refused it. These are guards, not percentage padding. Both files restored (`git diff` clean).

## 3. Gate-fails proof — re-derived independently

My mechanism, deliberately different from the implementer's: `sed -i 's/: 80,/: 100,/g'` across all six services' `vitest.config.mts` (the string `: 80,` occurs only inside the domain-glob group; the global tier is 60), then root `pnpm run test:coverage`.

**Exit code 1.** `Summary: 5 fails, 5 passes` — i.e. **all ten workspaces ran**. Eighteen genuine domain-tier ERROR lines across five services, each naming the glob:

```
apps/fulfillment  ERROR: Coverage for statements (94.62%) does not meet "src/domain/**" threshold (100%)
apps/gateway      ERROR: Coverage for statements (98.33%) does not meet "src/domain/**" threshold (100%)
apps/billing      ERROR: Coverage for statements (94.77%) does not meet "src/domain/**" threshold (100%)
apps/projector    ERROR: Coverage for statements (97.7%)  does not meet "src/domain/**" threshold (100%)
apps/orders       ERROR: Coverage for statements (98.52%) does not meet "src/domain/**" threshold (100%)
```

This proves three things the implementer's single-workspace probe could not:

1. The `src/domain/**` glob is **live and matching real files in five of the six services** — not one. The percentages reported are domain-only and differ from each service's All-files number (fulfillment 94.62% domain vs 90.92% overall), which also confirms Vitest removes glob-matched files from the global group rather than double-counting them.
2. The domain tier fires **independently** of the global tier — no global 60% violation appeared in any of the five.
3. `apps/notifications` **passed a 100% domain requirement** — the clean, unambiguous confirmation of the vacuity disclosed in §6.

Configs restored by the inverse `sed`; `git diff --stat` returned to the exact 9-file feature diff.

## 4. `--no-bail` — both halves, plus the counterfactual

- **Continues past failure:** yes. `Summary: 5 fails, 5 passes` = 10 of 10 workspaces executed with five of them failing.
- **Still exits non-zero:** yes. `EXIT=1`, `[ERR_PNPM_RECURSIVE_FAIL]`.

I then ran the same broken state through `pnpm -r --if-present run test:coverage` (no `--no-bail`): **only 8 of 10 workspaces ever started**, `[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @otc/fulfillment`, exit 1. `apps/seed` and `apps/web` never ran at all. So `--no-bail` is load-bearing, not decorative.

An unplanned second piece of evidence fell out of that counterfactual: after the bailing run, `apps/billing/coverage/lcov.info` and `apps/gateway/coverage/lcov.info` were **missing** — both workspaces had started, and pnpm's first-failure abort killed them after Vitest had cleaned their `coverage/` directory but before it rewrote the report. That is the "sibling killed mid-flight" failure mode `--no-bail` exists to prevent, observed live rather than argued. Both files were regenerated by the final clean run.

## 5. The vacuous `notifications` domain threshold — assessment and recommendation

**Confirmed vacuous, and confirmed harmless *today*.** `apps/notifications/src/domain/` contains exactly one file, `.gitkeep`. My 100%-threshold probe is the proof: notifications was the only service with a domain tier that did not fail when the requirement was raised to 100%, because zero files match the glob.

**Does domain logic live elsewhere in the service?** I checked. No. The service is a stateless fact-consumer with no aggregate: `application/notification-dispatch.service.ts` is idempotency/compensation orchestration over ports (an application concern by any reading), `infrastructure/templates/*` are pure email-rendering functions, `infrastructure/persistence` holds only the `processed_events` dedup table, and the presentation layer is `@EventPattern` controllers. Its only persistent state is a dedup ledger, which is infrastructure. **Notifications genuinely has no domain layer by design**, and the empty folder is a scaffolding placeholder, not a hidden gap. The nearest thing to a domain concern anywhere in it is `formatMoney` in `infrastructure/templates/notification-format.ts`, which duplicates the display concern of `packages/shared-kernel/src/domain/money.ts`'s `toString()` — a pre-existing, mild duplication from feature 20, not something this feature introduced or should fix.

**Recommendation: do not fix the coverage number; fix the silence.** The threshold is not concealing a real problem, so raising or lowering a percentage would achieve nothing. What is genuinely wrong is that a threshold which *can never fire* is indistinguishable, in a green run, from one that is holding the line — and this repository has now been bitten by guards-that-guard-nothing three times (feature 17's FS5 re-reserve branch, feature 19's R39 port-refusal branch, and the emission-deletion convention in `CLAUDE.md` that exists because of them). The consistent remedy here is the one this repo already uses for exactly this class: a **config-guard test**, in the same family as `outbox-parity.spec.ts`, `di-metadata-guard.spec.ts` and `notifications-consumes-only.spec.ts` — a single spec that reads every service's `vitest.config.mts`, and asserts that any config declaring a `'src/domain/**'` threshold group has at least one non-`.gitkeep` file under `src/domain/`. It would fail today for notifications, forcing an explicit decision (delete the empty folder and the glob key, or accept and annotate), and — more valuable — it would protect the *other five* against a future refactor that renames or empties `domain/` and silently turns their 80% tier vacuous with nobody noticing. That is a small test-only follow-up, correctly out of this feature's config-and-test scope only because the guard did not exist to be written into; **file it as its own item.** Until then, the README's plain statement that the tier is vacuously satisfied is the right interim disclosure, and it is present.

## 6. `sonar-project.properties` — static assessment

No live scan is possible here (host `/` at 98%, 18 GB free; Elasticsearch flood-stage watermark is 95% — I did not attempt to start it, per the brief). Reviewed statically:

**Correct.** `sonar.sources`/`sonar.tests` both `apps,packages` with `sonar.test.inclusions=**/*.spec.ts,**/*.integration.spec.ts` is the documented single-module way to scan main and test code from the same directories; it also correctly sweeps up `apps/web/e2e/*.spec.ts`. The exclusions (`node_modules`, `dist`, `.nuxt`, `.output`, `coverage`, `*.d.ts`, `packages/contracts/src/generated/**`) are right for this monorepo and consistent with the coverage config's own treatment of generated code. Deliberately omitting `sonar.host.url` and the token is correct — a token in a checked-in properties file would be the defect.

**LCOV paths: verified, all ten resolve.** I checked every path after a clean `pnpm run test:coverage`: all ten `coverage/lcov.info` files exist and are non-trivial (orders 3238 lines, web 2877, fulfillment 1412, notifications 770, projector 777, seed 561, shared-kernel 495, contracts 214, plus billing and gateway). Every workspace's vitest config emits `reporter: ['text', 'lcov']` — confirmed by grep across all ten, including `apps/web/vitest.config.ts`, `packages/shared-kernel` and `packages/contracts`. **This config does not point at reports that are never generated.**

**D3 (non-blocking) — `sonar.typescript.lcov.reportPaths=${sonar.javascript.lcov.reportPaths}`.** Two problems in one line. `sonar.typescript.lcov.reportPaths` has been deprecated since the JS/TS analysers merged and is very likely ignored outright by SonarQube 26.x; and the `${…}` reference is Java-properties syntax that the scanner does not interpolate, so if the property *is* still read it would receive the literal string `${sonar.javascript.lcov.reportPaths}` and resolve to no reports. Neither outcome breaks anything — `sonar.javascript.lcov.reportPaths` above it carries the real, correct list and is the property the merged analyser actually reads — but the line is at best dead and at worst misleading. Delete it.

**D4 (non-blocking) — no `sonar.coverage.exclusions`.** `apps/seed`'s five `coverage.exclude` entries produce **zero** LCOV records (I confirmed: `grep -c 'writers/orders-db.writer.ts\|verify.ts' apps/seed/coverage/lcov.info` → 0). Sonar treats a source file with no LCOV record as 0% covered, so a scan would report the three writers, `verify.ts` and `index.ts` at 0% and could fail a Sonar quality gate on files the local gate has deliberately and defensibly excluded. `sonar.coverage.exclusions` should mirror the vitest `coverage.exclude` list so the two gates tell the same story. Unobservable until a scan actually runs, hence non-blocking.

The README's statement of the limitation is honest and specific, and correctly frames SonarQube as additional rather than the gate.

## 7. Other defects

**D2 (non-blocking, must fix before commit) — `apps/fulfillment/vitest.config.mts`, lines 7–16: a duplicated comment block.** The five-line "Testcontainers integration specs run under vitest.integration.config.mts only…" comment appears **twice**, back to back. This is debris from the implementer's own break-and-revert cycle in §4 of its report, which states *"reverted immediately after, `git diff --stat` confirmed clean revert"*. The revert was not clean, and `git diff --stat` in fact showed it: fulfillment's diff is **24 lines changed against 19 for the five identically-changed sibling configs**, and those five extra lines are precisely this duplicate. Zero behavioural effect — it is a comment — but the claim in the impl report is false, and the discrepancy was sitting in the very command the report cites as its evidence. Delete lines 12–16.

**D5 (non-blocking) — `apps/web/vitest.config.ts`, lines 24–26: stale comment.** Still reads *"not enforced-failing until phase 21 (sonarqube_quality_gates) — … thresholds only fail *that* invocation."* Phase 21 is this feature; `pnpm quality` now runs `test:coverage`, so web's 60% threshold **is** live and enforced. The implementer rewrote this comment in the six service configs and in `apps/seed`, but missed `apps/web` (the only config named `.ts` rather than `.mts`, which is presumably why a glob missed it). It is the last surviving copy of that sentence in the repo — I grepped.

## Scope and conventions

- **No application source changed.** The diff is 6 service vitest configs + seed vitest config + root `package.json` + `README.md`, plus 2 new spec files and `sonar-project.properties`. `feature_list.json` and `specs/` untouched by the implementer, as required.
- **Vitest only, no Jest** — unchanged; `pnpm quality`'s lint + typecheck steps passed as part of the exit-0 run.
- **No stray artefacts staged.** `coverage/` and `*.lcov` are gitignored; `git status --porcelain` shows nothing else.
- The `@nestjs/cqrs`, DI-token, transport-naming and domain-purity rules are untouched by a coverage-config change; ESLint (which enforces them) ran green as `quality`'s first step.

## CHECKPOINTS walked

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer.
- [x] Every agent definition declares its model.
- [x] `./init.sh` exits 0 (implementer re-ran after the change; nothing in this diff touches it).

### C2 — State is coherent
- [x] At most one feature `in_progress` — feature 34 set to `done` by this review; no other feature left open.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it.
- [ ] `progress/current.md` describes the active session — **still stale**, carried forward from the `e2e_playwright` review's finding; not this feature's regression and not blocking it.
- [x] Every `blocked` feature records why (none blocked).

### C3 — Architecture is respected
- [x] No forbidden import inside any `domain/` folder — ESLint ran green in `pnpm quality`.
- [x] No cross-service database access — unchanged by this feature.
- [x] No shared runtime code beyond `shared-kernel` and `contracts` — unchanged.
- [x] `packages/shared-kernel` still has zero runtime dependencies.
- [x] Every inter-service interaction classifiable as Kafka-fact or NATS-RPC — unchanged.
- [x] No stray debug logging, no context-free TODOs — but see D2/D5, comment debris in two configs.

### C4 — Verification is real
- [x] `pnpm quality` (lint + typecheck + **test:coverage**) passes — exit 0, 1:12.38, verified by me from a clean tree.
- [x] Domain tests are pure — unchanged; the two new seed specs import only the modules under test and `vitest`.
- [x] Integration tests use Testcontainers against real MySQL/Mongo — `seed.integration.spec.ts` read in full, real containers, no mocked broker.
- [x] Coverage thresholds met: ≥80% domain (measured 88–98% on every metric of every service that has a domain layer), ≥60% overall (lowest 65.4%). **Caveat on record:** `apps/notifications`' domain tier is vacuous (§6), and `apps/seed`'s number depends on five exclusions, four of which are accurately justified and one of which is not (D1).
- [x] No Jest anywhere.

### C5 — The session closed cleanly
- [x] No suspicious untracked files — the four untracked entries are the two new specs, `sonar-project.properties` and the impl report.
- [x] `progress/history.md` has an entry for this feature including its effort record — appended by this review.
- [x] `feature_list.json` reflects true state — feature 34 set `done`.
- [x] The human has been told what was done and how to test it manually (impl report §"pnpm quality — real, final result" + README's new sections).
- [x] Claude did not commit — I ran no `git commit`/`git push`; the working tree is left exactly as the implementer left it.

### C6 — Spec-Driven Development
Not applicable: `sdd: false`. No `specs/sonarqube_quality_gates/` is required or expected, and none was created. The other C6 boxes concern `sdd: true` features and are unaffected by this change.

### C7 — Trilogy reusability
- [x] `specs/shared/` untouched by this feature and still stack-agnostic.
- [x] `n8n/workflows/*.json` untouched.
- [x] `progress/history.md` effort records complete and honest — this feature's appended below.

## Required before the human commits

1. **D1** — correct the `verify.ts` justification in `apps/seed/vitest.config.mts` (it has twelve throw-branches at 14.28% branch coverage; the claim "no branch logic of its own to lose" is false, and it is the sentence that carries the exclusion).
2. **D2** — delete the duplicated comment block at `apps/fulfillment/vitest.config.mts` lines 12–16.

Both are documentation/debris edits with no behavioural effect, which is why they do not gate approval. **D3, D4 and D5** are recommended in the same pass; the §6 config-guard test should be filed as its own follow-up item.

## Effort record

- **Implementation:** 1 session. Wall-clock from artefact mtimes and the preceding commit (local CEST, 2026-08-29): HEAD committed **16:47** → impl report written **17:19**, with `mongo-config.spec.ts` 16:58, `data-lookups.spec.ts` 16:59, root `package.json` 17:00, `sonar-project.properties` 17:07, `README.md` 17:16. **≈32 min**, including the SonarQube boot attempt that failed on disk headroom and the fulfillment break-and-revert probe.
- **Review:** 1 pass, APPROVED first time. **17:20 → 17:34, ≈34 min**, covering one clean `pnpm quality` (1:12), three armed source mutations across two new test files, a six-service threshold-raising probe, a `--no-bail` counterfactual run, an exclusion-removal re-measurement of `apps/seed`, a full read of `seed.integration.spec.ts`, and a static review of `sonar-project.properties` against all ten generated LCOV files.
- **Total: ≈1 h 06 min across 2 sessions.** The second feature in this project approved on the first review after a phase-19/20 run of rejections.

---

# Review — follow-up pass: SonarQube first-scan a11y fixes and false-positive suppression (2026-08-29, second review)

**Verdict: APPROVED.**

Scope of this review: only the follow-up pass described in `progress/impl_sonarqube_quality_gates.md` §"SonarQube first-scan findings — a11y fixes and false-positive suppression". Feature 34 was already `done` (approved on its first review, above); this pass added no acceptance criteria, so `feature_list.json` is untouched — per the review brief's explicit constraint, and because `done` is already its true state.

## The claim under test, and how I tested it

The implementer claims the **13 remaining SonarQube bugs are analyser limitations, not real defects** — that SonarQube's generic HTML analyser parses each `.vue` file's raw template in isolation and cannot resolve Vue SFC component composition. That is exactly the shape of a comfortable conclusion, so I did not evaluate it from the source. I drove a real Chromium against the running `otc-web` container on `http://localhost:3000`, logged in through the real `/login` form, and read the **computed accessibility tree** — Chromium's own `Accessibility.getFullAXTree` over CDP, plus Playwright's independently-implemented ARIA name computation as a second opinion.

First, the 13 are real and current — from the running SonarQube's own API, not from the report:

```
Web:InputWithoutLabelCheck  place.vue:282, place.vue:301, place.vue:340
Web:InputWithoutLabelCheck  billing/index.vue:176, :261, :278
Web:InputWithoutLabelCheck  orders/index.vue:87, :104          (8 total)
Web:S5256                   billing/index.vue:200, :306
Web:S5256                   orders/index.vue:132
Web:S5256                   stock/index.vue:158
Web:S5256                   ui/table/Table.vue:12              (5 total)
```

Live measures also match the impl report exactly: `bugs=13`, `reliability_rating=3.0` (C), `vulnerabilities=3`, `code_smells=88`, `duplicated_lines_density=12.3`, `coverage=68.5`, `ncloc=27834`.

### Category 1 — the 5 `Web:S5256` table findings: **analyser noise, confirmed**

Rendered DOM, live, per page:

| Page | `<table>` | `<th>` rendered | `scope` |
|---|---|---|---|
| `/orders` | 1 | 6 | all `col` |
| `/billing` | 2 | 6 and 8 | all `col` |
| `/stock` | 1 | 7 | all `col` |
| `/` (dashboard) | 1 | 6 | all `col` |

Every `<th>` carries `data-slot="table-head"` — i.e. it is genuinely produced by `TableHead.vue`, the different file the analyser never connects to the `<Table>` usage site. Four page-level tables + the `Table.vue` primitive itself = the 5 findings, one-for-one. I also confirmed by source that `<TableHeader>` is an unconditional sibling of `<TableBody>` inside `<Table>` (`orders/index.vue:132-146`), so the `<th>` row exists in the `TableEmpty` state too, not only when rows are present.

I additionally inventoried every page for tables and selects: `<Table` appears in exactly `orders/index.vue`, `stock/index.vue`, `billing/index.vue`; `<Select ` in exactly `orders/index.vue`, `billing/index.vue`, `orders/place.vue`. There is no table or select anywhere in `apps/web` that SonarQube did *not* flag — so no real defect is hiding in the gap between the tool's list and reality.

### Category 2 — the 8 `Web:InputWithoutLabelCheck` Select findings: **analyser noise, confirmed**

Each of the 8 resolves in the live accessibility tree to a real `role="combobox"` element with a correctly computed accessible name, sourced from the associated `<label>` (`nameFrom=[relatedElement]`, i.e. HTML label/for association, not a placeholder and not an invented `aria-label`):

| Page | id on `SelectTrigger` | Chromium AX name | Playwright accessible name | keyboard-focusable | Enter opens | options |
|---|---|---|---|---|---|---|
| `/orders` | `order-status-filter` | `Status` | `Status` | yes | `aria-expanded false→true` | 10 |
| `/orders` | `order-retailer-filter` | `Retailer` | `Retailer` | yes | `false→true` | 8 |
| `/billing` | `credit-retailer-filter` | `Retailer` | `Retailer` | yes | `false→true` | 8 |
| `/billing` | `invoice-status-filter` | `Status` | `Status` | yes | `false→true` | 3 |
| `/billing` | `invoice-retailer-filter` | `Retailer` | `Retailer` | yes | `false→true` | 8 |
| `/orders/place` | `retailer-select` | `Retailer` | `Retailer` | yes | `false→true` | 7 |
| `/orders/place` | `company-select` | `Company` | `Company` | yes | `false→true` | 22 |
| `/orders/place` | `product-field-0` | `Product` | `Product` | yes | `false→true` | 12 |

Two independent accessibility-name implementations agree on all eight. Clicking each `<label for=…>` moves `document.activeElement` onto the corresponding trigger in all eight cases — the label/for wiring is genuinely live, not decorative (a `<button>` is a labelable element per HTML, so this is correct, not a workaround). The implementer's account is accurate: the ARIA `combobox` lives on `SelectTrigger`, `<Select>` is a context-only root with no DOM node of its own, and putting an `id` on `<Select>` to satisfy the text-matching rule would do nothing for a real user.

**Conclusion: the 13 are correctly classified. None of them is a real defect being explained away.** No blocking finding here.

## The other verification items

### 1. The 20 fixes are genuine — yes

Across `/`, `/login`, `/orders`, `/orders/place` (both branch states), `/billing`, `/stock` and an order-detail page, the live DOM reports **zero `<label>` without a `for`**, **zero form control without an accessible name** (no `labels`, no `aria-label`, no `aria-labelledby`), and every `label[for]` resolves to an existing element. Spot-checking the accessible names a user would actually hear: `Retailer`, `Company`, `Currency`, `Product`, `Quantity`, `Unit price override`, `Line discount`, `Notes`, `Status`, `Username`, `Password` — expected words, not empty strings satisfying a linter.

The gaps were real, as claimed. The diff confirms five `<Select>` filters that had only `<span class="text-sm font-medium">` beside them (billing ×3, orders/index ×2) and six `<Label>` elements in `place.vue` with no `for` attribute at all (Retailer, Company, Product, Quantity, Unit price override, Line discount).

### 2. Shared primitives did not break callers — yes, and `id` stayed caller-supplied

`Input.vue` declares `id?: string` and binds `:id="id"`; there is no `useId()`, no generated fallback, no default. `TableHead.vue` uses `withDefaults(..., { scope: 'col' })`. Live evidence that no caller broke: `Input` has 15 call sites and `TableHead` 31, and every one of them renders correctly in the DOM — including `login.vue`'s `#username`/`#password`, which I exercised by logging in for real. `lint` exit 0, `typecheck` exit 0.

This mattered more than it looks: declaring `id` as a prop *removes* it from `$attrs`, so had the `:id="id"` binding been omitted, every caller's id would have vanished silently. **Armed probe:** replacing `:id="id"` with an inert attribute in `Input.vue` fails 4 tests — 3 in `app/pages/login.spec.ts` and 1 in `app/pages/orders/place.currency.spec.ts` — each with `TestingLibraryElementError: Found a label with the text of: Username/Currency, however no form control was found associated to that label`. The binding is load-bearing and guarded. Restored; suite back to 14 files / 66 tests.

### 3. No test was weakened — confirmed, none was touched

`git status` shows **no `*.spec.ts` modified anywhere in the repository** in this pass. No locator was loosened because no locator was edited. The only test-adjacent change in the whole feature is `apps/web/vitest.config.ts`, whose diff is a comment rewrite plus nothing else — the `thresholds` block is byte-identical.

### 4. The mid-pass duplicate-id regression is genuinely gone — confirmed in both branch states

`Web:S7930` returns 2 issues from the SonarQube API, both on `place.vue`, both `CLOSED`. More importantly, in the rendered DOM: **zero duplicate ids** on `/orders/place` with the catalog available (Select branch: `retailer-select`, `company-select`, `product-field-0`) and **zero duplicate ids** with `/api/catalog/**` forced to 503 so the `v-else` fallback renders (Input branch: `retailer-input`, `company-input`, `product-field-0`). I drove the fallback branch deliberately via request interception rather than trusting the v-if/v-else reading.

### 5. The suppression is honest — confirmed

`sonar.issue.ignore.multicriteria` has exactly one entry (`e1`), scoped to one rule (`typescript:S7739`) **and** one file (`apps/projector/src/infrastructure/persistence/legacy-document-backfill.ts`). It is not a blanket rule-off: `typescript:S7739` remains active everywhere else. The stated reason is accurate — `grep -rn "then:" apps packages --include='*.ts'` returns exactly 9 hits, all in that file, all of the form `{ case: { $eq: [...] }, then: <rank> }` inside a MongoDB `$switch`, plus the cross-reference comment at line 35. `delta-to-pipeline.ts` is genuinely free of the pattern. Live: `typescript:S7739` open issues = **0**.

### 6. The README duplication note — substantively right, one inaccurate attribution (D6 below)

`README.md:113` correctly ties 12.3% to `CLAUDE.md`'s "only `shared-kernel`/`contracts` are shared" rule, and correctly records that no `sonar.cpd.exclusions` entry was added, so the number stays visible. The parity guard it names does exist and does enforce byte-identity. But see D6 — it describes the guard's location wrongly.

## Gates — run by me, from a clean restored tree

| Gate | Result |
|---|---|
| `pnpm --filter @otc/web run lint` | exit 0 |
| `pnpm --filter @otc/web run typecheck` | exit 0 |
| `pnpm --filter @otc/web exec vitest run` | 14 files, **66 tests**, all passed |
| `E2E_BASE_URL=http://localhost:3000 pnpm --filter @otc/web run test:e2e` | **3 passed** (8.7s) — setup + compensation + happy path |
| SonarQube `api/issues/search` / `api/measures/component` | matches the impl report exactly |

I did **not** re-run `pnpm quality` in full — the claim under review is about `apps/web` and about SonarQube findings, not about the whole-repo suite, which the previous review already verified from a clean tree. Consequently I neither saw nor looked for the incidental `apps/orders` parity-spec flake; it remains an open, separately-documented artefact and is not this pass's defect.

## Defects found — all non-blocking

- **D6 — `README.md:113`, parity-guard attribution is wrong.** It says the guard is "the parity spec **each service's own test suite carries** … if one copy's behaviour drifts from its siblings, **that service's own suite fails**". The guards are in fact *centralised*: `apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts`, `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` and `apps/seed/src/outbox-parity.spec.ts` read every other app's copies off disk (`findRepoRoot`/`listApps`/`readFileSync`) and assert banner-stripped byte identity. If `apps/billing`'s outbox copy drifts, it is `apps/orders`' suite that fails, not billing's. The substance (a real, enforcing guard exists) is right; the sentence misdirects a reader looking for it. Why it matters: an assessor following this README to find the guard will look in the wrong six places.
- **D7 — `README.md:107`, "20 were genuine WCAG accessibility defects … all now fixed" is not accurate, and the paragraph contradicts itself.** It counts the 5 table findings among the "20 genuine defects" and then, in the same sentence, explains that their `<th>` "genuinely already existed at runtime". Both cannot be true. The honest arithmetic — which the impl report gets right and the README does not — is: 7 `<Input>` findings were real and are now closed in the tool; 8 `<Select>` findings were real missing-label defects, are substantively fixed (verified above) but remain open because the tool wants the id in the wrong place; 5 table findings were never defects and remain open. "All now fixed" reads as 29→0 when the tool still reports 13.
- **D8 — the a11y fixes have no regression guard.** Armed and confirmed on a fully green suite: deleting `for="order-status-filter"` from `orders/index.vue` and deleting `:scope="scope"` from `TableHead.vue` **both survive** — 14 files / 66 tests, all passing. The 3 Playwright specs locate exclusively by `data-testid` and `getByRole('option'|'button'|'link')`, never by label or accessible name, so they do not catch it either. Only `Input.vue`'s `id` passthrough is guarded (by pre-existing `getByLabelText` calls in `login.spec.ts` and `place.currency.spec.ts`). This is not a hard violation of `CLAUDE.md`'s deletion rule, which is scoped to domain-fact-emitting branches — but it is the same failure shape the project has been burned by twice, applied to a11y: work verified once by inspection, with nothing to stop it silently regressing. Recommended: one `getByRole('combobox', { name: … })` or `getByLabelText` assertion per page-level filter, which would have failed under my probe.
- **D9 — `place.vue`, Product field shares one id across mutually-exclusive branches.** `:id="`product-field-${index}`"` appears on both the `v-if="productsUsable"` `<SelectTrigger>` (line ~340) and the `v-else` `<Input>` (line ~350). This is precisely the pattern the file's own comment (lines ~266-278) says was rejected for Retailer/Company as "a genuine duplicate-id defect … fragile in real code regardless". It is runtime-safe (I verified zero duplicate ids in both branch states) and invisible to SonarQube only because the id is a dynamic expression — which is the other half of what that comment argues against. Not a defect; an internal inconsistency between the stated principle and the code three fields below it.
- **D10 — impl report path typo.** `progress/impl_sonarqube_quality_gates.md:151` writes `apps/web/app/components/ui/table/table/TableHead.vue` (doubled `table/`). Actual path: `apps/web/app/components/ui/table/TableHead.vue`.
- **D11 — impl report overstates the absence of label-based tests.** Line 162 says "none of the tests this pass touches rely on `getByLabel`, only `data-testid`/`getByRole`, confirmed by grep before editing". `login.spec.ts` and `place.currency.spec.ts` do use `getByLabelText`, which is why my `Input.vue` probe failed 4 tests. Harmless — the claim understated the safety net rather than overstating it — but the pre-edit grep was incomplete, and the real result is better than reported.
- **D12 — `apps/web/playwright.config.ts:14-16` carries a stale port comment**: "The currently running stack under test uses `WEB_PORT=3010`". `.env` has `WEB_PORT=3000` and no `3010` exists in the compose files. This stale comment is the likely source of the wrong port in the review brief itself. One-line doc fix.
- **D13 (cosmetic, pre-existing) — two `<th scope="col">` render with empty text**: the actions column of `/billing`'s invoice table and of `/stock`'s table. Passes `Web:S5256`; a screen-reader user hears an unnamed column. Not introduced by this pass.

None of D6–D13 changes a runtime behaviour or invalidates a verified claim, which is why none blocks. D6, D7 and D12 are one-sentence documentation corrections and should land before the human commits; D8 is the one worth a follow-up item.

## `CHECKPOINTS.md` boxes walked for this pass

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist — unchanged by this pass.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` unchanged.
- [x] `./init.sh` exit 0 — per the impl report; the working tree I verified is byte-identical to the one it ran against.

### C2 — State is coherent
- [x] Feature 34 remains `done`; no status changed. `feature_list.json` deliberately untouched by me (brief constraint) and already correct.
- [x] Every `done` feature has passing tests — `apps/web`'s 66 unit + 3 e2e re-run by me.

### C3 — Architecture is respected
- [x] Domain purity — no `domain/` folder touched by this pass; the only backend edit is a comment in `apps/projector/.../legacy-document-backfill.ts` (infrastructure layer, no logic change, verified in the diff).
- [x] No cross-service database access — unchanged.
- [x] No shared runtime code beyond `shared-kernel`/`contracts` — unchanged; the 12.3% duplication is the *consequence* of this rule and is now documented rather than suppressed.
- [x] `packages/shared-kernel` still dependency-free — untouched.
- [x] Kafka-fact / NATS-RPC classification — unchanged.
- [x] No stray debug logging, no context-free TODOs — the added comments are substantive and cross-referenced. I removed every marker I armed; `grep -rn "data-armed" apps/web/app` returns nothing.

### C4 — Verification is real
- [x] Lint + typecheck + `apps/web` tests pass — run by me, exit 0 / exit 0 / 66 passed.
- [x] Domain tests are pure — no domain test touched.
- [x] Integration tests use real containers — the Playwright suite ran against the real 17-container stack via `otc-web` on port 3000, not a self-spawned dev server (`webServer` is deliberately unset).
- [x] Coverage thresholds — unchanged by this pass (no test added or removed); SonarQube still reports 68.5%.
- [x] No Jest anywhere.
- [x] **Mutation probes armed and restored**: 3 (Input `id` passthrough — *caught*; TableHead `scope` — *survived*, D8; `<Label for>` on `orders/index.vue` — *survived*, D8).

### C5 — The session closed cleanly
- [x] No suspicious untracked files — untracked set unchanged: 3 seed specs, `sonar-project.properties`, and the two `progress/` reports.
- [x] `progress/history.md` has an entry for feature 34 including its effort record; this pass's effort record is appended below.
- [x] `feature_list.json` reflects true state.
- [x] The human has been told what was done and how to test it — impl report §"Gate results, this pass" plus README's two new subsections.
- [x] **Claude did not commit.** I ran no `git commit`/`git push`. Working tree restored to exactly the implementer's state after my probes: same 18 modified paths, same 6 untracked paths, same `319 insertions(+), 80 deletions(-)`.
- [x] Stack left running and healthy: all 17 required containers + `otc-sonarqube`.

### C6 — Spec-Driven Development
Not applicable: `sdd: false`. No `specs/sonarqube_quality_gates/` required, none created.

### C7 — Trilogy reusability
- [x] `specs/shared/` untouched by this pass.
- [x] `n8n/workflows/*.json` untouched.
- [x] `progress/history.md` effort records complete and honest — this pass's appended below.

## Effort record — follow-up pass

- **Implementation:** 1 session. Wall-clock from artefact mtimes and scanner logs (local CEST, 2026-08-29): first successful scan `scan.log` **18:18** → a11y source edits **18:38–18:39** (`billing/index.vue` 18:38:23, `sonar-project.properties` 18:39:08, `legacy-document-backfill.ts` 18:39:14, `README.md` 18:39:40) → `otc-web` rebuilt and recreated **≈18:58** → impl report written **19:07**. **≈52 min**, including two container rebuild/recreate cycles and the self-introduced `Web:S7930` duplicate-id regression, caught and fixed within the same session. (The 19:16 mtimes on `Input.vue`, `TableHead.vue`, `orders/index.vue` and `place.vue` are mine — my mutation probes and their restore — not the implementer's.)
- **Review:** 1 pass, APPROVED first time. **19:07 → 19:25, ≈18 min**, covering a live SonarQube API cross-check of all 13 open issues plus the closed `S7930` and suppressed `S7739`, three custom Chromium/CDP accessibility-tree probes against the running container (accessibility tree, keyboard reachability and label-click focus, empty/edge pages plus a request-intercepted `v-else` fallback branch), 3 armed source mutations across the shared primitives and one page, a full page-inventory cross-check of every `<Table>`/`<Select>` against the tool's findings, and the four `apps/web` gates re-run from a restored tree.
- **Total: ≈1 h 10 min across 2 sessions.** Approved on the first review, with 8 non-blocking defects recorded (three of them one-sentence documentation corrections in `README.md` and `playwright.config.ts`).
