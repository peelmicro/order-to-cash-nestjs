# review_orders_aggregate

**Feature:** `orders_aggregate` (id 13, phase 8), `"sdd": true` — the **first** SDD feature, so `CHECKPOINTS.md` **C6 applies in full for the first time**.
**Reviewer pass:** 2026-08-20, ~15:36–15:45 local.
**Verdict:** **APPROVED** — 6 defects, all minor, none blocking; 4/4 tasked hostile edits KILLED.
**Status set:** `in_review` → `done` in `feature_list.json`; history entry with effort record appended.

Everything below was re-run or re-read by this review. Nothing is relayed from `progress/impl_orders_aggregate.md` without independent confirmation.

## 1. Verification actually executed by this review

| # | Command / probe | Result |
|---|---|---|
| 1 | `pnpm --filter @otc/orders test:coverage` | `Test Files 8 passed (8)`, `Tests 166 passed (166)`; **domain 98.5 % stmts / 91.25 % br / 100 % funcs / 98.47 % lines** — byte-identical to the implementer's reported table |
| 2 | `pnpm --filter @otc/orders test:integration` (Testcontainers `mysql:8.4.11`) | `1 file, 5 tests` green — migrations `0000`+`0001` from an empty container, round-trip including `order_items.description` |
| 3 | `pnpm --filter @otc/seed test` / `test:integration` | `5 files, 94 tests` and `1 file, 4 tests` green |
| 4 | `pnpm quality` (root: lint + typecheck + test, 10 workspaces) | exit 0, all green |
| 5 | `./init.sh` | exit 0 — "environment and state are coherent"; SDD-coherence check reports `1 sdd feature(s) past pending have their triple-doc` |
| 6 | ESLint domain-purity probe (my own, not the implementer's) — prepended `@nestjs/common` **and** an `../infrastructure/...` import to `order.ts` | both flagged `no-restricted-imports`: *"Domain layer must stay framework/infrastructure free"* and *"Domain layer must not reach into infrastructure/ or presentation/"*; file restored, md5 back to `e3f1037…` |
| 7 | Live `otc_orders` inspection (read-only) | `information_schema` says `order_items.description` **does not exist**; 11 rows present; one row in `__drizzle_migrations` → the implementer's J5 statement about the warm database is **true, verified independently** |
| 8 | `git check-ignore -v` on `data/foo`, `infra/mysql/data/bar`, `apps/seed/src/data/sagas.data.ts` | first two still ignored (`.gitignore:38:/data/`, `:39:infra/**/data/`), the third **no longer ignored** — the leader's fix is correct in both directions |
| 9 | `git diff specs/shared/test-matrix.md` | only the six `R5`–`R10` rows + the §1 coverage-summary Green cell (`0` → `9`); nothing else in `specs/shared/` touched |
| 10 | Working-tree integrity after all probes | `md5sum` of `order.ts` = `e3f103755879cbdb0de87f8c41f12704` and `order-transitions.ts` = `27c84c980c6f9c472da10bc702a23db4`, both equal to their pre-probe values; the one temporary `zz-probe.spec.ts` removed; `git status` shows no probe residue |

Not re-run: task **A3**'s cold `rm -rf node_modules && pnpm install && pnpm build && pnpm quality` (≈10 min, and a failure mid-review would leave the workspace unusable). The *substantive artefact* of A3 — the `@otc/shared-kernel` + `@otc/contracts` `workspace:*` declarations in `apps/orders`, `apps/billing` **and** `apps/fulfillment` — is verified directly in the three `package.json` diffs, and `pnpm quality` is green.

## 2. Mutation testing — assertion quality

Four hostile edits as tasked; each applied, the suite run, then the file restored from a byte-exact backup (md5 re-checked, item 10 above).

| # | Hostile edit | Outcome | Killed by |
|---|---|---|---|
| M1 | Added an illegal row `placed → paid` to `ORDER_TRANSITIONS` | **KILLED** — 2 failures | `Order — R9` › *raises on every (from, to) pair absent from Table T-1…* + the per-pair `it.each` |
| M2 | Made `reconstitute` append an `order.placed.v1` before returning | **KILLED** — 2 failures | `Order.reconstitute — OA3` › *reconstitutes without emitting an event…* |
| M3 | Deleted both reason↔status pairing guards in `cancel` | **KILLED** — 5 failures | `Order.cancel — OA4` › *refuses a cancellation reason that Table T-1 does not pair…* + 4 more |
| M4 | Added `'confirmed'` to `LINES_MUTABLE_IN` | **KILLED** — 4 failures | `Order — R7` › *refuses to add, remove or modify a line once the order is confirmed…* + 3 more |

**4/4 killed.** Two further exploratory probes, reported for honesty:

- **M5 (equivalent mutant, survives):** relaxing the funnel condition at `order.ts:424` from `if (transition.emits && options.buildEvent)` to `if (options.buildEvent)` leaves 166/166 green. It is behaviourally equivalent under the current callers (a builder is passed only on the four emitting edges), so this is not a hole in the tests. The *other* direction **is** load-bearing: blanking the `emits` cells of the `confirmed`/`completed`/`cancelled` rows to `null` kills 8 tests.
- **M6 (genuine survivor, defect D1 below):** blanking Table T-1 **row 1**'s `emits: 'order.placed.v1'` to `null` leaves **166/166 green**, because `Order.place` hardcodes `orderPlacedEvent(...)` and never consults the table, and `CREATION_TRANSITION` is exported but dead.

## 3. `tasks.md` — all 44 tasks walked

**A (wiring).** A1 ✓ — all three `package.json` diffs carry both `workspace:*` deps (billing and fulfillment included, per post-gate amendment 2). A2 ✓ — root typecheck green across 10 workspaces; root `quality` script correctly left unchanged (feature 34). A3 — cold proof accepted on the implementer's recorded evidence; the fix itself independently verified (see §1).

**B (closed types).** B1/B2 ✓ — `ORDER_STATUSES` (9 values, T-1 order), `CANCELLATION_REASONS` (3), both with runtime guards. B3 ✓ — `order-status.spec.ts` proves parity *twice*: compile-time mutual assignability (a grown/shrunk contracts union stops compiling) **and** runtime value-set equality; non-vacuous. B4 ✓ — `orders.schema.spec.ts` sits in `infrastructure/` exactly as design §3 requires, because a `domain/` test may not import `infrastructure/`.

**C (T-1 as data).** C1 ✓ — 12 rows verbatim with `trigger` and `emits` cells, `Map<from, Map<to>>` built once at module load, `findTransition`. **This is genuinely data, not a switch cascade**: the only `switch` in the feature is in the *test* (`applyEdge`, mapping a target status to the public command method that attempts it) — the production legality decision is a single map lookup in one private `transitionTo`. C2 ✓. C3 ✓ with the disclosed shape: the exhaustive proof really is 9 × 9 = **81 pairs, 11 legal / 70 illegal**, all 81 checked directly against `findTransition`, and the 61 illegal pairs that a public method can attempt driven through the real aggregate asserting `OrderTransitionNotAllowedError` + unchanged status/total/line-count + empty `pullDomainEvents()`. The 9 `(from, 'placed')` pairs have no public command method at all — unrepresentable rather than rejected, which is strictly stronger; a dedicated case asserts those 9 are absent from the table. The deviation from C3's literal wording is disclosed in the impl report and endorsed by design §5. Accepted.

**D (errors, lines, totals).** D1 ✓ — all ten error classes with exactly the ten `code` strings of design §7. D2 ✓ — `OrderLine` has no setters; `withQuantity` returns a new instance with the same id. D3 ✓ — `Money`-only arithmetic, the order-level discount kept as a named `Money.zero(currency)` term (open point 2). D4/D5 ✓ — D5's specific demand is met: the named case asserts `OrderLineCurrencyMismatchError` **and** a further case is titled *"raises OrderLineCurrencyMismatchError, never the kernel CurrencyMismatchError…"*.

**E (aggregate).** E1 ✓ — **`OrderSnapshot` carries no totals fields at all** (open point 12 satisfied structurally, not by a check). E2 ✓ — private constructor, so `place`/`reconstitute` really are the only two paths. E3 ✓ — creation invariants in the specified order (lines → currency → totals → status), one `order.placed.v1`. E4 ✓. E5/E6 ✓ — `reconstitute` emits nothing (M2 proves the test would catch a regression), re-derives all three totals, validates status membership, and enforces reason-iff-`cancelled` in both directions. E7 ✓ — validate-then-commit: nothing is written to `this.props` before the final single assignment, which is what makes "changes nothing" true rather than hopeful. E8 ✓ — asserted across all six frozen statuses **including `cancelled`**, comparing status + all three totals + sorted line ids. E9 ✓ — `Object.freeze` on the array *and* on each view; a case even asserts two calls return independent copies. E10 ✓ — the eight command methods, all funnelling through one private `transitionTo`.

**F (facts).** F1 ✓ — four builders, `import type` only from `@otc/contracts`, `correlationId = aggregateId = order.id`, `causationId`/`occurredAt` from the context, `Money` → minor units, `Date` → ISO-8601, and a real non-empty-tuple narrowing helper rather than a blind cast. F2 ✓ — the named case walks creation + all nine non-creation edges. F3 ✓ — envelope assertions including an `eventType` regex for `<aggregate>.<fact>.v<n>`.

**G (cancellation).** G1 ✓ — closed set, T-1 pairing, `compensationSteps` from the caller defaulting to `[]`; immutability holds because `cancelled` is terminal, so a second `cancel` cannot run. G2/G3 ✓ — both mispaired negatives, both positives, and `operator_cancelled` from all four cancellable statuses.

**H (port and barrel).** H1 ✓ — `Symbol` token + the three-method interface, **no `@nestjs/common` import**; the Drizzle **adapter was correctly NOT built** (feature 15's scope, open point 5) — `apps/orders/src/infrastructure/persistence/` contains only schema files, the migrator and the migration spec. H2 ✓ — `index.ts` exports the deliberate surface; `LINES_MUTABLE_IN` and `transitionTo` stay internal.

**J (post-gate amendment 1).** J1 ✓ — `varchar('description', {length: 255}).notNull()` after `productId`, with the snapshot-not-a-join comment. J2 ✓ — `0001_small_vertigo.sql` is a single generated `ALTER TABLE \`order_items\` ADD \`description\` varchar(255) NOT NULL;`, journal entry `idx: 1` present, `0000_bizarre_champions.sql` untouched. J3 ✓ — round-trip insert **and** `toMatchObject` both carry `description`; the table-list case still expects 8 tables + `__drizzle_migrations`; green from empty (§1 item 2). J4 ✓ — `OrderLineFixture.description` resolved once in `resolveLines(...)` from `productByCode(...).name`, read back by `orderPlacedLines(...)` so row and fact agree by construction; the writer's `onDuplicateKeyUpdate` set carries `description` so a warm database backfills. J5 — see §6.

**I (closing).** I1 ✓ (diff-verified, §1 item 9). I2 ✓ — `OA1`–`OA5` flipped with file + case name. I3 ✓ (re-run). I4 ✓ — and re-proved independently by this review, in both restricted directions. I5 ✓ — the impl report is unusually candid (the R9 gap, the `Indexed<>` deviation, the `.gitignore` defect, the J5 block). I6 ✓.

## 4. C6 traceability walk — `R5`–`R10` and `OA1`–`OA5`

Every id below maps to a **real, named, non-vacuous** case whose title matches the matrix wording verbatim (matrix rule 4). "Killed by" cites the mutation that proves the assertion bites where one was run.

| Id | File | `describe` › `it` | Non-vacuous because |
|---|---|---|---|
| **R5** | `order.spec.ts` | `Order.place — R5` › *refuses to create an order with no lines and to remove the last remaining line* | asserts `EmptyOrderError` on both paths **and** `lines` still length 1 after the refused removal |
| **R6** | `order-totals.spec.ts` | `computeOrderTotals / Order — R6` › *recomputes initialAmount, initialDiscount and totalAmount after each mutation and rejects a negative total* | recomputes exact minor-unit values after add/change/remove, then asserts a rejected mutation left total and line count untouched |
| **R7** | `order.spec.ts` | `Order — R7` › *refuses to add, remove or modify a line once the order is confirmed and leaves every field unchanged* | 3 mutators × 6 frozen statuses, deep-equal on status + 3 totals + line ids; **killed M4** |
| **R8** | `order-state-machine.spec.ts` | `Order — R8` › *walks every legal edge of Table T-1 and reaches cancelled only from placed, stock_reserved, credit_approved and confirmed* | drives all 11 edges through the real command methods and asserts no edge leaves `completed`/`cancelled` |
| **R9** | `order-state-machine.spec.ts` | `Order — R9` › *raises on every (from, to) pair absent from Table T-1 without mutating state or appending an event* | 81 pairs asserted against `findTransition` (11/70 split asserted numerically) + 61 driven through the aggregate; **killed M1** |
| **R10** | `order-cancellation.spec.ts` | `Order.cancel — R10` › *requires a reason from the closed set, records it immutably and carries it on order.cancelled.v1* | missing reason, out-of-set reason, second-cancel refusal, and the payload's `cancellationReason` |
| **OA1** | `order-totals.spec.ts` | `Order — OA1` › *refuses a line whose price or discount currency differs from the order currency, with an order-level error and no partial mutation* | both offending fields, both call sites, asserts `expected`/`actual`/`orderId` on the aggregate's own error |
| **OA2** | `order-events.spec.ts` | `Order — OA2` › *emits exactly one fact on the four Table T-1 edges that name one and no fact at all on the five internal edges* | drains after every edge and compares `eventType` arrays, so an extra *or* missing fact fails |
| **OA3** | `order.spec.ts` | `Order.reconstitute — OA3` › *reconstitutes without emitting an event, recomputes the totals from the lines and refuses inconsistent persisted state* | empty `pullDomainEvents()`, exact re-derived totals, and all four inconsistent-snapshot rejections; **killed M2** |
| **OA4** | `order-cancellation.spec.ts` | `Order.cancel — OA4` › *refuses a cancellation reason that Table T-1 does not pair with the current status and changes nothing* | both mispairings + both positives + `operator_cancelled` × 4, asserting unchanged status, `undefined` reason and no event; **killed M3** |
| **OA5** | `order.spec.ts` | `Order.lines — OA5` › *returns lines that cannot be used to mutate the order or its totals* | asserts `Object.isFrozen` on array and element, that mutation attempts **throw**, and that the order's lines/totals are unchanged |

`R1`–`R4` correctly not re-proved (requirements.md §1); `R1`'s API half correctly left `TODO`, which is why the coverage-summary Green cell is `9`, not `10`.

## 5. `CHECKPOINTS.md` walk

**C1 — harness complete**

- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all present.
- [x] `progress/current.md` and `progress/history.md` present.
- [x] Five agents in `.claude/agents/`, each declaring its model (unchanged this feature).
- [x] `./init.sh` exits 0 (two expected mid-session `[WARN]`s: uncommitted changes, tests not run inside init).

**C2 — state coherent**

- [x] No feature `in_progress` after this pass; exactly one was, before it.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests (this one: 166 unit + 5 integration, re-run here).
- [ ] **`progress/current.md` is out of lockstep** — it still says `**Status:** in_progress` while `feature_list.json` said `in_review`, and it still carries the previous session's `seed_job` decision bullets. Defect **D4**; leader's file, not the implementer's.
- [x] No `blocked` features.

**C3 — architecture respected**

- [x] Zero `@nestjs/*` / `drizzle-orm` / `kafkajs` / `nats` / `mongodb` imports under `apps/orders/src/domain/` — verified by ESLint (probe 6), not by eye; the only external imports are `@otc/shared-kernel` (runtime) and `@otc/contracts` (`import type` only, erased).
- [x] No cross-service DB access: this feature touches only `otc_orders`; the added column is inside the Orders service; the domain sees business codes, never foreign keys.
- [x] No new shared runtime code — `shared-kernel` and `contracts` only; this feature added *declarations* of them, not new shared modules.
- [x] `packages/shared-kernel` still has zero runtime dependencies (`dependencies` and `peerDependencies` both absent) — and this feature did **not** extend it with a `Clock` (open point 6 honoured).
- [x] Kafka-fact vs NATS-RPC — n/a at domain level; the aggregate publishes nothing and calls nothing. The four facts are the T-1 facts, unchanged.
- [x] No stray debug logging, no context-free TODOs under `src/domain/` or `src/application/`.

**C4 — verification real**

- [x] `pnpm quality` passes (re-run here).
- [x] Domain tests are pure — no framework, no DB, no broker, no mock of infrastructure; time enters only through `TransitionContext`, so no test touches `Date.now()`.
- [x] Integration tests use real Testcontainers MySQL (`mysql:8.4.11`, the same pinned image as compose), never a mock.
- [x] Coverage: **domain 98.5 %** ≫ 80 % gate; overall 95.81 % ≫ 60 %. The branch gap is **benign and I checked each one**: `order-errors.ts` 62.5 % is the `orderId ? … : …` message ternaries on the four errors whose `orderId` is optional; `order-events.ts:145` is the non-empty-lines narrowing throw that O1/R5 make unreachable; `order-transitions.ts:138` is the module-load guard for a missing T-1 creation row; `order.ts:466` is the re-throw of a non-`NegativeOrderTotalError`. None of them hides behaviour a requirement names.
- [x] No Jest anywhere — no `jest` in any `package.json`.

**C5 — session closed cleanly**

- [x] No suspicious untracked files. `git status` scope is exactly this feature: the new `apps/orders/src/domain/**`, `apps/orders/src/application/ports/`, `drizzle/0001_*` + `meta/`, the three `package.json`s, `pnpm-lock.yaml`, the two modified infrastructure/seed files, `specs/orders_aggregate/`, `progress/*`, `feature_list.json`, `specs/shared/test-matrix.md`, `.gitignore` — plus `apps/seed/src/data/` newly *visible* (see §6). No `.tmp`, no build output.
- [x] `progress/history.md` entry with the effort record — appended by this pass.
- [x] `feature_list.json` set `done` by this pass.
- [x] The human has been told what was done and how to test it — `progress/impl_orders_aggregate.md` §"Manual verification", plus §6 below.
- [x] **Claude did not commit.** No commit or push in this review.

**C6 — Spec-Driven Development (first application)**

- [x] `specs/orders_aggregate/` holds all three of `requirements.md`, `design.md`, `tasks.md`; `init.sh`'s own SDD-coherence check agrees.
- [x] EARS notation with ids — the shared `R5`–`R10` are cited (not restated, deliberately, so the trilogy contract cannot drift) and the five local ones are written in EARS (`IF … THEN THE SYSTEM SHALL …`, `WHEN … THE SYSTEM SHALL …`) under the non-colliding `OA` prefix.
- [x] All 44 tasks ticked — walked one by one in §3; 43 fully done, J5 satisfied by adequate equivalent evidence with the residue disclosed (§6).
- [x] Every `R<n>` covered by a concrete named test recorded in `specs/shared/test-matrix.md` — §4, diff-verified as scoped to `R5`–`R10` only.
- [~] **The spec commit precedes the implementation commit** — **not yet satisfiable, and not by any agent**: nothing is committed (`specs/orders_aggregate/` is still untracked). Required human action at commit time, §7 item 1. Defect **D5**.

**C7 — trilogy reusability**

- [x] `specs/shared/` still stack-agnostic — the only edit was flipping status cells in `test-matrix.md`; no NestJS/Drizzle/MySQL specific leaked in. All stack detail lives in `specs/orders_aggregate/design.md`, exactly where #8/#9 write their own.
- [x] `n8n/workflows/` untouched.
- [x] Effort records complete and honest — this pass appends one derived from file timestamps, not from self-report.
- [x] **Bonus for the trilogy:** `requirements.md` §5 records `OA4` and `OA1` as **promotion candidates** for `specs/shared/` at feature 38, with the reason (#8/#9 read only the shared spec and would otherwise not enforce the reason↔status pairing or the aggregate-boundary currency error). This is the single most valuable artefact of the feature for the trilogy and it is correctly *not* acted on now.

## 6. Judgement on the two items the implementer flagged

### 6.1 The `.gitignore` defect — flagged, declined, since fixed by the leader: **fix is correct**

The implementer was **right to flag and right not to fix**: a repo-root config file is outside the three packages its tasks named, and it was a pre-existing phase-1 defect (`529bae7`), not something this feature caused.

The leader's fix — `data/` → `/data/`, with an explanatory comment — is verified in **both** directions and is minimal:

- `git check-ignore -v data/foo` → `.gitignore:38:/data/` — a root-level Docker bind-mount directory is **still ignored**.
- `git check-ignore -v infra/mysql/data/bar` → `.gitignore:39:infra/**/data/` — the infra bind-mount rule is untouched and still fires.
- `git check-ignore -v apps/seed/src/data/sagas.data.ts` → **no match**; `git status` now shows `?? apps/seed/src/data/` with all **11** source files present (`companies`, `constants`, `credits`, `currencies`, `products`, `reference-data.spec`, `retailers`, `sagas.data`, `sagas.spec`, `stock.data`, `stock.spec`).
- **Nothing else was wrongly un-ignored:** `find . -type d -name data` outside `node_modules` returns exactly one directory, `apps/seed/src/data` — so the anchoring cannot have exposed anything but the files it was meant to expose. `docker-compose.infra.yml` uses **named volumes** (`mysql_data`, `kafka_data`, …), not host bind mounts under `./data`, so the anchored `/data/` rule loses nothing real.

Consequence the human must not miss: those 11 files have **never been committed** (since phase 7), and `apps/seed/src/data/sagas.data.ts` contains this feature's J4 changes. They must be added in the next commit.

### 6.2 Task J5's live-database half — **substitution ADEQUATE; no requirement gap, one environment residue**

**Ruling: adequate.** The Testcontainers path is not a weaker proxy for "recreate from empty → migrate → seed → verify" — it *is* that chain, run twice over, against a real MySQL of the same pinned version:

- `migrations.integration.spec.ts` starts a fresh `mysql:8.4.11` container that "has never seen a single `CREATE TABLE`" and calls `runOrdersMigrations(...)` — **the very same function `db:migrate`'s CLI uses**, applying the committed `drizzle/` folder through the journal, so `0000` **and `0001`** are exercised in order from empty; it then round-trips an `order_items` row asserting `description` back out.
- `apps/seed/src/seed.integration.spec.ts` goes the whole distance: fresh container → `runOrdersMigrations` → `seedOrdersMasterData` → `seedOrdersSagas` → `verifySeed(...)`, plus a re-run idempotency case. A missing or unpopulated `description` could not survive that path — the column is `NOT NULL` and the typed insert carries it.

So every *correctness* claim J5 exists to establish is proved. What is **not** proved, and cannot be by a container, is an **environment** fact: I confirmed independently (§1 item 7) that this machine's live `otc_orders` has one migration row, 11 `order_items` rows and **no `description` column**. That is a state of the developer's box, not a defect in the code, and the implementer documented the exact recovery commands. Refusing the whole feature over a sandbox guard that stopped a `DROP DATABASE` would be punishing the implementer for correctly not working around a safety block.

**One correction to the impl report's framing:** MySQL 8 will *not* fail that `ALTER TABLE` on the warm database — it adds the column and fills existing rows with the implicit `''`. So the live risk is not a failed migration but 11 rows of empty descriptions, which the next `pnpm seed` backfills via the `onDuplicateKeyUpdate` set J4 added. Do the recreation anyway before feature 15, but it is a tidy-up, not a blocker.

## 7. Defects

All six are minor. None blocks approval; items 1–3 are carry-forward, items 4–6 are process/housekeeping.

**D1 — Table T-1 row 1's `emits` cell is inert; `CREATION_TRANSITION` is dead code with a comment that says otherwise.** `apps/orders/src/domain/order-transitions.ts:128` documents `CREATION_TRANSITION` as *"looked up separately by `Order.place`"*, and `:135` defines it — but `grep` finds **no** use anywhere in the repo, and `apps/orders/src/domain/order.ts:158` appends `orderPlacedEvent(order, ctx)` directly. Proved by mutation M6: setting row 1's `emits` to `null` leaves all 166 tests green. *Why it matters:* the whole argument for a table over a switch is that the table is the single source of legality-and-emission truth; for the creation row that is currently documentation only, and the comment misleads the next reader. Cheapest honest fixes: have `place` consult `CREATION_TRANSITION.emits` before appending, or delete the dead export and correct the comment. Not blocking — the behaviour is right and OA2 asserts it directly.

**D2 — the transition funnel's emission is jointly gated (`design.md` §5 says the table drives it).** `apps/orders/src/domain/order.ts:424`: `if (transition.emits && options.buildEvent)`. Design §5 says the funnel *"assigns the status and appends the fact named by `emits` (or none)"*; here the caller must also supply a builder. Both single-direction regressions are caught by tests, so this is redundancy rather than a hole (M5 is an equivalent mutant). Worth one line of comment, or an `else if (transition.emits) throw` invariant, when feature 16 touches this file.

**D3 — `Order.reconstitute` lets the kernel's `CurrencyMismatchError` escape the aggregate boundary.** `apps/orders/src/domain/order.ts:192-203`: `reconstitute` maps snapshot lines and calls `computeOrderTotalsFor` **without** the `assertLineCurrency` check that `place` (`:119-121`) and `addLine` (`:300`) run. I confirmed this with a throwaway spec (since deleted): reconstituting an `EUR` order whose line is `GBP` throws the shared-kernel `CurrencyMismatchError`, **not** `OrderLineCurrencyMismatchError` — `computeOrderTotalsFor` (`:462-467`) re-wraps only `NegativeOrderTotalError`. Strictly this is *outside* OA1's literal scope (*"added, modified or supplied at creation"*) and outside OA3's enumerated snapshot checks, so it is not a spec violation — but it is a hole in invariant **O2** on exactly the path feature 15's repository adapter will use to build snapshots from rows. Fix belongs with the adapter: add the currency assertion to `reconstitute`, or add it to OA3's snapshot validations.

**D4 — `progress/current.md` is out of lockstep with `feature_list.json`.** It reads `**Status:** in_progress` while the feature was `in_review`, and its "Decisions taken this session" still carries the previous `seed_job` session's bullets below the new ones. C2's fourth box therefore fails. Ironically the same file records the lesson twice (*"Leader lesson (D2, twice): `progress/current.md` must be updated at every feature status transition"*). Leader's file to fix, not the implementer's.

**D5 — the spec is not committed, so C6's spec-first box cannot be ticked yet.** `specs/orders_aggregate/` and `progress/spec_orders_aggregate.md` are untracked. Since Claude never commits, this is a **human action at commit time**, and for the *first* SDD feature the git history is the process evidence CLAUDE.md explicitly asks for. See §8 item 1.

**D6 — no test asserts the *content* of `order_items.description`.** The seed suites prove an insert succeeds (impossible with a `NOT NULL` column absent) and the orders round-trip proves a written value comes back, but nothing asserts that a seeded row's description equals `productByCode(...).name`, i.e. that the persisted row and the `order.placed.v1` payload really carry the same text. Today they do **by construction** (both read `line.description`), which is why this is minor; a one-line assertion in `apps/seed/src/data/sagas.spec.ts` would make it a regression-proof property.

Also noted, not a defect: `tasks.md` J5 is ticked `[x]` although its live half was not performed. Accepted here **because** the impl report discloses it twice, prominently, with the exact recovery commands — the tick is not the misleading artefact it would otherwise be. Prefer `[~]` next time.

## 8. Actions for the human (none are code changes)

1. **Commit spec-first, in two commits.** First `specs/orders_aggregate/{requirements,design,tasks}.md` + `progress/spec_orders_aggregate.md` (message: `docs(spec): orders_aggregate requirements/design/tasks, approved at the gate with 2 amendments`). *Then* the implementation. This is the only way C6's last box turns `[x]` for the first SDD feature, and the git history is the assessment's process evidence.
2. **Do not forget `apps/seed/src/data/`** in the implementation commit — 11 files, never committed before, now visible thanks to the `.gitignore` fix, and one of them carries this feature's J4 change.
3. **Recreate the live `otc_orders`** before feature 15: `docker compose -f docker-compose.infra.yml down -v && … up -d && pnpm --filter @otc/orders db:migrate && pnpm seed`, then `SELECT COUNT(*) FROM order_items WHERE description IS NULL OR description = '';` → expect `0`. Tidy-up, not a blocker (see §6.2).
4. **Reset `progress/current.md`** for the next feature (D4).

## 9. Verdict

**APPROVED.** The first SDD feature is the one that decides whether the harness is theatre or method, and this one holds up: the spec's sixteen open points are each traceable to code, both post-gate amendments landed in full, the exhaustive 9 × 9 proof is genuinely data-driven, the four hostile edits were all killed by the *named* requirement cases, coverage is real and its gaps are benign, and the implementer's two disclosures were both accurate when checked against the live system. Six minor defects recorded; none of them makes a requirement vacuous.
