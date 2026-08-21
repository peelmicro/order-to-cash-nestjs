# Review pass — `order_saga_orchestrator` (feature 16, phase 8)

**Agent:** `reviewer`
**Date:** 2026-08-21
**Feature:** `order_saga_orchestrator` — the saga orchestrator inside Orders: Kafka facts in, NATS commands out, both compensation paths, `"sdd": true`
**Verdict:** **APPROVED** — 8 defects, **none blocking**; **5/5 hostile mutations KILLED**; **0 divergences** between `specs/shared/saga.md` and `saga-steps.ts`; the durable machinery proven independent of the in-memory cqrs hop with the hop physically removed.
**Status set:** `in_review` → `done` (`feature_list.json`). Nothing committed. Every probe file deleted, every mutation restored and md5-verified (`md5sum -c` OK on all four mutated files).

---

## 1. What I actually ran

| Gate | Command | Result |
|---|---|---|
| Unit | `pnpm --filter @otc/orders test` | **384/384** (28 files), 8.95 s |
| Integration (whole orders app) | `pnpm --filter @otc/orders test:integration` | **51/51** (17 files), 376 s, Testcontainers `mysql:8.4.11` + `apache/kafka:4.3.1` + `nats:2.14.5-alpine` |
| Quality | `pnpm quality` | **exit 0** — lint 0 errors (the explicit-`@Inject` guard included), typecheck clean, orders 384 + seed 106 + shared-kernel 68 + contracts 22 + the four 1-test apps |
| Coverage | `pnpm --filter @otc/orders test:coverage` | overall **89.87 %** stmts / 80.84 % branches; `domain/` **98.5 %** — both gates met (the implementer had not measured this; I did) |
| Harness | `./init.sh` | exit 0 |
| Live stack | `pnpm --filter @otc/orders build && start` against the running compose stack, 75 s | clean boot: `Consumer has joined the group`, `listening on port 3002 (HTTP) and NATS`, **no** `UNKNOWN_TOPIC_OR_PARTITION`, no crash. The real sweeper re-attempted the three parked rows unattended: `attempts` 3 → 6 → 9, `next_attempt_at` 10:34 → 10:59 (the 30 s → 60 s → 120 s capped schedule). The designed steady state, observed. |
| Scope | `git status --short` after cleanup | 18 modified + 30 untracked, identical to the set the implementer reported; `dist/` ignored; no probe residue |

The `KafkaJSNumberOfRetriesExceeded: This is not the correct coordinator` / `coordinator is loading` bursts the implementer describes reproduce here in every file's first seconds and always self-heal (kafkajs restarts the consumer). Not ours; consistent with the `fileParallelism: false` decision, which I accept.

## 2. `CHECKPOINTS.md` — boxes walked

**C1** — [x] harness files exist · [x] `current.md`/`history.md` exist · [x] five agents · [x] every agent declares its model · [x] `./init.sh` exits 0
**C2** — [x] ≤1 `in_progress` (none; 16 was the only non-terminal) · [x] statuses valid · [x] every `done` feature has passing tests · [ ] `progress/current.md` still says feature 16 `in_progress` — out of lockstep for the **fourth** time (carry-over D4 of features 13/15; leader resets it at close) · [x] no `blocked`
**C3** — [x] domain purity (grep of every `domain/` folder: zero forbidden imports; ESLint rule green) · [x] no cross-service DB access (orchestrator reads only `otc_orders`; Fulfillment/Billing referenced by `orderReference`/`companyCode`/`productCode` in payloads) · [x] no shared runtime code beyond `shared-kernel`/`contracts` (`@nestjs/cqrs` is a per-app dependency via the catalog) · [x] shared-kernel still dependency-free · [x] every interaction classified — 13 facts on Kafka, 5 commands on NATS request-reply; no Kafka-as-request-bus, no RPC-for-facts · [x] no stray debug logging, no context-free TODOs
**C4** — [x] `pnpm quality` green · [x] domain/step-table tests pure (`saga-steps.spec.ts` imports only the domain, shared-kernel and contracts types) · [x] integration on real containers · [x] coverage ≥80 % domain / ≥60 % overall · [x] no Jest
**C5** — [x] no suspicious untracked files · [x] history entry with effort record (this pass) · [x] `feature_list.json` true · [x] human told what/how (impl §6 + this file) · [x] Claude did not commit
**C6** — [x] `specs/order_saga_orchestrator/{requirements,design,tasks}.md` present · [x] EARS with ids (SO1–SO8; R19–R29 inherited) · [x] all 35 tasks ticked and verified (see §3) · [x] every R/SO → named, real test (§4) · [x] spec commit `e5641b3`/gate precedes this implementation (still uncommitted, as designed)
**C7** — [x] `specs/shared/` edits stack-agnostic (only the R29 row split and the R19–R29 DONE flips) · [x] `n8n/` untouched · [x] effort record honest

## 3. The step table — `saga.md` vs `saga-steps.ts`, row by row

| Fact | saga.md precondition → action → command | `saga-steps.ts` | Match |
|---|---|---|---|
| `order.placed.v1` | `placed` → nothing → `stock.reserve` (§3.1 #1) | `advance`/`placed`, no-op apply, `commandAfter: 'stock.reserve'` | yes |
| `stock.reserved.v1` | `placed` → `stock_reserved` → `credit.hold` (#2) | `markStockReserved`, `credit.hold` | yes |
| `credit.approved.v1` | `stock_reserved` → `credit_approved` → `confirmed`, one `order.confirmed.v1` → `despatch.create` (#3) | `approveCredit` + `confirm` on one instance, `despatch.create` | yes |
| `order.despatched.v1` | `confirmed` → `despatched` → `invoice.issue` (#4) | `markDespatched`, `invoice.issue` | yes |
| `invoice.issued.v1` | `despatched` → `invoiced` → — (#5) | `markInvoiced`, no `commandAfter` | yes |
| `payment.received.v1` | `invoiced` → `paid` → — (#6) | `markPaid` | yes |
| `credit.released.v1` | `paid` → `completed` + `order.completed.v1` (#7) | `complete` | yes |
| `stock.rejected.v1` | `placed` → cancel `stock_rejected`, **no** command (§4.1) | `cancel`/`placed`, `compensationSteps: () => []`, no command field exists on a `cancel` step | yes |
| `credit.rejected.v1` | `stock_reserved` → **stay** `stock_reserved` → `stock.release` (§4.2 B1) | `advance`/`stock_reserved`, no-op apply, `stock.release` | yes |
| `stock.released.v1` | `stock_reserved` → cancel `credit_rejected` (§4.2 B2) / `operator_cancelled` (§4.3 table) | `cancel`/`stock_reserved`, `mapReason` (`credit_rejected`→`credit_rejected`, `order_cancelled`→`operator_cancelled`), one `stock_released` step from the observed fact | yes |
| `order.confirmed.v1`, `order.completed.v1`, `order.cancelled.v1` | not consumed (§5) | `skip`; `factCommandFor` returns `undefined` so the controller never dispatches | yes |

§6 redelivery table: every row is "precondition unmet → ignored" or "dedup hit → ack"; the handler checks dedup first (`runOnce`), then strict equality on `precondition` (no ranges), and writes a durable `saga_ignored_facts` row with `observed_status`/`expected_status` and the `precondition_unmet` / `unknown_order` marker. **Zero divergences.** The `cancel` step shape cannot even express a command, so R26 is a prohibition by type, not by discipline.

## 4. R / SO → test mapping (verified, each run by me)

| Req | Test | Verified |
|---|---|---|
| R19–R23, R24 (integration half) | `saga-happy-path.integration.spec.ts` › *reaches invoiced … exactly one order.confirmed.v1 and one order.completed.v1 in the outbox*; R21/R23 also `saga-steps.spec.ts` | green; M5 kills it |
| R25 | `saga-preconditions.integration.spec.ts` › *every one of the ten consumed facts, redelivered against a completed order, changes nothing, issues nothing, and is recorded precondition_unmet*; unit `saga-fact-handler.spec.ts` › R25 | green; M1 kills the unit case |
| R26 | `saga-compensation-stock-rejected.integration.spec.ts` › *… release subject stub observes ZERO requests, including after redelivering stock.rejected.v1 against cancelled*; unit `saga-steps.spec.ts`, `saga-fact-handler.spec.ts` › R26 | green; M2 kills the unit cases (see D3) |
| R27, R28, SO7 | `saga-compensation-credit-rejected.integration.spec.ts` › *release-then-cancel in causal order, with one stock_released compensation step built from the observed fact* | green; my P3 re-proved it with the release parked for 20 s before the completing fact |
| R29 (retry clause), SO4, SO5 | `saga-command-retry.integration.spec.ts` › *parks a command after exhausted attempts, keeps the order in its last legal status, and resumes…*; unit `saga-command-dispatcher.spec.ts` › *retries a timed-out command up to maxAttempts, with the configured backoff schedule* | green |
| SO1 | `saga-consumption.integration.spec.ts` › *consumes a fact published before the consumer group ever subscribed (fromBeginning: true)* | green |
| SO2 | `saga-steps.spec.ts` › *maps the three self-produced facts to skip*; `saga-facts.controller.spec.ts` › *a self-produced fact … NO CommandBus dispatch at all* | green |
| SO3 | `saga-command-retry.integration.spec.ts` › *the crash-window composition: a pending row committed with NO in-memory hop is still issued by a sweeper cycle*; `order.sagas.spec.ts` (five mappings + no-termination) | green — but the "sweeper" there is a hand-driven `claimDue` + `dispatch`; the real service is proven only by my P1 (D2) |
| SO6 | `saga-compensation-credit-rejected.integration.spec.ts` › *does not retry a business-rejected credit.hold…*; unit `saga-command-dispatcher.spec.ts` › SO6 | green; M4 kills the unit case; my P2 proves the `stock.reserve` side |
| SO8 | `saga-preconditions.integration.spec.ts` › *SO8 — … unknown_order marker and acknowledged (no throw)* | green |
| R24 API half, R28 e2e half, R29 dead-letter | `TODO` (features 25/31, e2e, 27) — honestly left open in the matrix | — |

`specs/shared/test-matrix.md`: only the R19–R29 rows changed. Tasks A1–H4: all 35 verified against artefacts (schema files, `0004_melodic_microbe.sql` + snapshot, the two new `migrations.integration.spec.ts` round-trips, `outbox-parity.spec.ts` still green inside `pnpm quality`, `kafka.config.spec.ts` spec-text guard for the two consumed topics, `.env.example` SO4/SO5 settings, the E3 finding recorded in `main.ts`, G1 observed by me as well as by the implementer).

## 5. Probes — saga correctness, with the real output

**P1 — the cqrs hop killed, the real sweeper alone.** Scratch spec replacing `OrderSagas` via `vi.mock` with an empty class, harness sweeper off, dispatcher `300 ms × 3`, park cap 2 s. Result: `order.placed.v1` consumed → `saga_commands` row `{status: 'pending', attempts: 0}` and still so 3 s later, order `placed` (the hop is genuinely dead and nothing else dispatches). Then the **real** `SagaCommandSweeperService.onApplicationBootstrap()` with no responder → `parked, attempts: 3` → `attempts ≥ 6` on the next due sweep (indefinite capped re-attempts), order still `placed`. Then the stub responders started and **nothing else touched** → order reached **`invoiced`**, all four rows (`stock.reserve`, `credit.hold`, `despatch.create`, `invoice.issue`) `sent`. Task F6's claim — the durable row + sweeper is the guarantee, the hop only the fast path — holds on the real service, not just on a hand-driven cycle. Caveat that produced D2: this only worked after I made the harness's fixed `FakeClock` track wall time.

**P2 — business rejection on `stock.reserve`.** Stub replies `outcome: 'rejected'` → order `cancelled`, row `sent`, **exactly one** `stock.reserve` request for that order after a further 4 s of sweeper cycles, **zero** `stock.release` requests, and `saga_commands` holds only `['stock.reserve']` for the order. SO6 and R26 as prohibitions, both sides.

**P3 — `credit.rejected.v1` redelivered mid-compensation (feature 14's row 10).** No responders anywhere; `stock.reserve` parked; stub `stock.reserved.v1` → `stock_reserved`; `credit.hold` parked; `credit.rejected.v1` (eventId A) → `stock.release` row enqueued then parked, order **still `stock_reserved`** (R27). Redelivered **A again**: `processed_events` has one row for A, still one `stock.release` row with the same id, no ignored row, status unchanged — layer 1 holds. Then `stock.released.v1` → `cancelled` / `credit_rejected` / `compensationSteps: [{step: 'stock_released', eventId: <that fact's id>, eventType: 'stock.released.v1'}]`; a further `stock.released.v1` with a new id → `precondition_unmet`, still exactly one `order.cancelled.v1` in the outbox. All as specified. The **distinct-eventId** redelivery in the middle of that sequence is defect D1 below.

**Migration numbering.** `0003_smooth_machine_man.sql` is feature 15's `order_number_sequences`; the spec's "`0003`" predates it. `_journal.json` is coherent (idx 0–4, tags match files). Snapshot chain: `0000→0001` ok, `0002→0003` repaired by this pass (`0003.prevId` now `82ea016c…`), `0003→0004` ok, **`0001→0002` still broken** (D4).

## 6. Mutation results (each restored byte-exact, `md5sum -c` OK)

| # | Hostile edit | Result | Killed by |
|---|---|---|---|
| M1 | `saga-fact-handler.ts`: precondition check short-circuited (`false && …`) — wrong-precondition facts transition anyway | **KILLED** | `saga-fact-handler.spec.ts` › R25 (1/116 unit failures) |
| M2 | `saga-steps.ts`: `stock.rejected.v1` rewritten as an `advance` that cancels **and** owes `stock.release` | **KILLED** | 5 unit failures (`saga-steps.spec.ts` R26 row + 3 status rows, `saga-fact-handler.spec.ts` › R26). **Integration R26 spec stayed green** — see D3 |
| M3 | `saga-fact-handler.ts`: `order.placed.v1` deduped under a random eventId (dedup effectively skipped for one fact) | **KILLED** | unit › *a duplicate delivery returns outcome duplicate*; integration › R18 same-eventId redelivery (timed out waiting for the dedup row) |
| M4 | `saga-command-dispatcher.ts`: a reply with `outcome: 'rejected'` thrown as retriable | **KILLED** | `saga-command-dispatcher.spec.ts` › SO6 |
| M5 | `saga-fact.handlers.ts`: `OrderPlacedFactRecorded` published **before** awaiting the transactional unit (issue-before-commit) | **KILLED** | unit › *publishes nothing on duplicate/ignored* (2); integration happy path (the dispatcher finds no committed row → `noop`, saga stalls at `placed`, 45 s timeout) |

## 7. Transport-binding ruling (item 6)

Verified: `ListenersController.registerPatternHandlers` binds a pattern with no `transport` argument to **every** connected server; the implementer's diagnosis is right and the fix is complete — the only four pattern decorators in `apps/*/src` all carry an explicit `Transport.X` (`orders-create.controller.ts:43` NATS; `saga-facts.controller.ts:103/108/113` KAFKA), and the clean live boot confirms it. **Blast radius: every remaining service is hybrid** — Fulfillment and Billing (17–22) are NATS responders *and* Kafka fact consumers; Projector and Notifications (23–24) consume Kafka and will answer NATS queries; the Gateway (25) is HTTP + NATS. Each one re-creates exactly this crash on first boot, and no `TestingModule` (one transport each) can catch it. **Ruling: promote now, before feature 17 —** (a) one CLAUDE.md non-negotiable: *"Every `@MessagePattern`/`@EventPattern` names its transport explicitly (`Transport.NATS` / `Transport.KAFKA`); a bare decorator binds to every connected server."* (b) one ESLint `no-restricted-syntax` entry next to the DI guard, selector `Decorator[expression.callee.name=/^(MessagePattern|EventPattern)$/][expression.arguments.length<2]`, same message. Lint-able, zero false positives today (the parity census in `idempotent-consumer.parity.spec.ts` greps text, not AST, and is unaffected). Leader action; not done by me.

## 8. Defects (file, line, why) — none blocking

**D1 — a distinct-eventId duplicate of a fact whose precondition is still met poisons the partition.** `apps/orders/src/application/saga-fact-handler.ts:115` (`commandStore.enqueue`) + `drizzle-saga-command-store.ts:47`. Reproduced in P3: `credit.rejected.v1` with a **new** eventId while the order is still `stock_reserved` and the `stock.release` row already exists → `ER_DUP_ENTRY 'uq_saga_commands_order_command'` → the transactional unit rejects → kafkajs retries 5× → `[Consumer] Crash: KafkaJSNumberOfRetriesExceeded` → restart → the same offset again (12 `eachMessage` errors and 2 consumer crashes in 6 s; the billing partition never advances). The same happens for a second `order.placed.v1` with a new id while `stock.reserve` is parked. **Why it matters:** saga.md §6's own row says the safe behaviour is "stock.release is re-issued and the responder no-ops" — the unique key is the right guard but is answered with a crash loop rather than "already owed"; and R16's DLQ (feature 27) does not exist yet, so the loop is unbounded. In production no producer emits the same fact twice under different ids (B1/F3 invariants, the outbox keeps ids on republish), which is why this is not blocking. **Fix:** make `enqueue` idempotent on `(order_id, command)` — `INSERT … ON DUPLICATE KEY UPDATE id = id` (or select-then-skip) and report `enqueued` either way so the fast path re-dispatches the existing row (a `sent` row is a `noop` in `dispatch`, a `parked` one is resumed); one integration case: *a distinct-eventId duplicate mid-compensation neither crashes the consumer nor creates a second row*. Fold into the next Orders-touching feature or a `test_maintainer` pass; must close before feature 27 claims R16.

**D2 — the dispatcher stamps `next_attempt_at` with `Date.now()`, not the injected `Clock`.** `saga-command-dispatcher.ts:142`. CLAUDE.md's own testing convention ("time comes from a controllable clock port") and the store's `claimDue` (`clock.now()`) disagree with it; in production both are wall time, so no behavioural bug — but it is why **no integration test runs the real `SagaCommandSweeperService`** (the harness has `enabled: false` everywhere and F6/SO3 drive `claimDue` + `dispatch` by hand): with the fixed `FakeClock`, a parked row's wall-clock `next_attempt_at` is never `<= clock.now()`, and a just-enqueued row's `created_at == now` never satisfies `created_at < now`. My P1 had to tick the clock to prove the service. **Fix:** inject `Clock` into the dispatcher; then F6 can enable the real sweeper and assert the unattended resume through it.

**D3 — R26's integration assertion observes the wire, not the durable seam.** `saga-compensation-stock-rejected.integration.spec.ts:67,84` assert `stockReleaseRequests.length === 0`. M2 (a durable `stock.release` row enqueued on `stock.rejected.v1`) left it green because `HandleStockRejectedFactHandler` publishes no event and the harness sweeper is off — the unit layer caught it, the matrix-named test did not. **Fix:** also assert `saga_commands` has no row other than `stock.reserve` for the order (my P2 does exactly that).

**D4 — carry-over: `apps/orders/drizzle/meta/0002_snapshot.json:3` `prevId` is still `cc7967bb-…`**, the id of the orphan deleted after feature 14; feature 14's review prescribed `0fbd495b-…` (0001's id) and it was never applied. This pass repaired `0003.prevId` only. `drizzle-kit generate` tolerated it for 0004, so it is metadata hygiene, not a blocker — but it is the second review to say so.

**D5 — the broker-side group is `orders.saga-server`, not `orders.saga`.** `main.ts:33–35` and design §3.1 claim the consumer group is "deliberately identical to the `ConsumerName` used in `processed_events`"; Nest's `ServerKafka` appends `-server` unconditionally (`server-kafka.js:37`), and both the live log and every test log show `groupId: orders.saga-server`. Harmless, but a stated design intent that is false as shipped — fix the comment/design, or accept and record.

**D6 — interface-typed `@Optional()` logger parameters** on `SagaFactsController:98`, `OrderSagas:58`, `SagaCommandSweeperService:54`: `design:paramtypes` emits `Object` for an interface, resolution depends on `@Optional()` returning `undefined`, and the shape evades the `TSParameterProperty` ESLint selector by not being a parameter property (feature 15's N3, now with three instances). Works under `tsc`; would also "work" under esbuild by accident. Prefer a `LOGGER`-style token or no constructor injection for a console fallback.

**D7 — `progress/current.md` still reads `in_progress` for feature 16** (C2) — fourth occurrence of the lockstep drift; leader resets on close.

**D8 — probe console output is not visible in `vitest run` logs** is *my* finding about the harness, not a defect in the feature, recorded only so the next reviewer asserts rather than `console.log`s. (Not counted.)

Defect count: **7 in the feature's scope (D1–D7), none blocking.**

## 9. Deviations the implementer argued — ruled

1. `0004` not `0003` — justified (feature 15 took 0003 after the spec was written). 2. `0003_snapshot.json` prevId repair — justified and minimal; D4 notes the half left undone. 3. `RunsIdempotently`/`RecordsIgnoredSagaFacts` narrowing — justified, the established pattern. 4. `saga-command-payloads.ts` — justified, §6.3 assigns the responsibility without naming a file. 5. no port file for the dispatcher — accepted; the `DispatchesSagaCommands` surface plays that role. 6. `fileParallelism: false` — justified; I observed the same coordinator races and no functional failure.

## 10. What the human should do

`progress/impl_order_saga_orchestrator.md` §6 is the manual script and is accurate. Note that my 75 s live boot advanced the three parked rows to `attempts = 9` (`next_attempt_at ≈ 10:59 UTC`); that is the designed behaviour, not damage. The commit message must name `@nestjs/cqrs` in its packages section. Before feature 17 starts: the transport-binding convention + lint rule (§7) and, ideally, D1 and D2.

---

## Third pass (reopened for test race) — 2026-08-21

**Verdict:** **APPROVED** — narrow re-review of the `saga-compensation-credit-rejected.integration.spec.ts` race fix only; the original saga approval (step-table walk, 5/5 mutations) stands untouched.

**1. The fixed assertion rests on durable evidence and nothing was weakened.** The barrier now polls the `saga_commands` row for `(order_id, 'credit.hold')` reaching `status === 'sent'` — terminal per design.md §6.3 (`markSent` never revisits a `sent` row; `dispatch` no-ops on `sent`, `saga-command-dispatcher.ts:105`), so unlike the old transient `orders.status === 'stock_reserved'` poll there is no window to miss. The name's retry half ("does not retry a business-rejected credit.hold") is asserted directly and non-racily: 1.5s grace then `creditHoldRequests` (monotonically growing) `toHaveLength(1)`, plus the row re-read as `sent` (lines 96–104). The name's advance-on-fact half is carried by the sibling test's causal release-then-cancel chain in the same file plus `saga-steps.spec.ts:199–208` (R27: `credit.rejected.v1` `apply` leaves `stock_reserved` unchanged, reply never mutates state), and the fix documents that split in-file. No `specs/shared/test-matrix.md` row needed to change (R27/R28 rows 115–116 verified: names and file mapping unchanged).

**2. Isolation runs, 3×:** `pnpm exec vitest run --config vitest.integration.config.mts src/saga-compensation-credit-rejected.integration.spec.ts` — 2/2 green each: 28.45s, 41.13s, 56.34s.

**3. My own regression probe (different from the implementer's).** The implementer broke SO6 by making a rejected reply throw (→ `parked`, barrier timeout). I broke it the other way: injected a duplicate `credit.hold` send after a successful reply in `saga-command-dispatcher.ts` (`if (command === 'credit.hold') { await call(row.payload); }` before `markSent`), so the row still reaches `sent` and the barrier passes — the retry-count assertion alone must catch it. It did: `AssertionError: expected [ … ] to have a length of 1 but got 2` at `saga-compensation-credit-rejected.integration.spec.ts:97`, failing in 2.1s (a crisp assertion failure, not a timeout). Restored byte-exact, `md5sum` `b38aaf9502d5fc060fbeae7377e11002` matching both my pre-probe hash and the implementer's recorded value, `cmp` clean.

**4. Blast radius clean.** All six saga integration spec files carry the original `waitFor(…, timeoutMs = 45_000, intervalMs = 200)` defaults (grep-verified); `vitest.integration.config.mts` is the feature-16 shape: `testTimeout: 180_000`, `hookTimeout: 120_000`, `fileParallelism: false`.

**5. Gates.** `pnpm quality` exit 0. `./init.sh` exit 0. `git status` contains only the known feature-16 uncommitted set (plus this pass's progress files) — nothing unexpected.

**Pattern ruling for features 17–22:** saga integration tests must synchronise on **durable, terminal or monotonic evidence** — a `saga_commands`/outbox row status that never regresses, or an append-only observed-requests list — never on a transient live column (`orders.status` mid-chain) that a correct, fast saga can pass through inside one poll interval; polling a state the system is *supposed to leave* is a race by construction.
