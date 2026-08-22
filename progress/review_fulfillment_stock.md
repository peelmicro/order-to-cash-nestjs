# Review — `fulfillment_stock` (feature 17, phase 9)

**Verdict: REJECTED** — one defect (D1 below). Everything else examined on this pass held up under probing: all four planned mutations killed, the race and deadlock-shape tests re-run green and assert only terminal evidence, the bare-JSON wire proven against the installed `ServerNats` source and by a raw `nats` client against the real `AppModule`, the correlation-header chain verified end-to-end in the live compose database, the D1 crash-loop fix re-run green, and the traceability for R30–R35/R61 verified name-for-name. The rejection is narrow and cheap to fix: FS5's normative "(in any status)" clause is implemented but untested at every level — my fifth, unplanned mutation survived the entire test suite.

**Review date:** 2026-08-22. **Reviewer effort:** 1 session, ~75 min wall-clock (of which ~14 min Testcontainers: fulfillment integration 163s + full Orders integration 352s + repeated unit runs).

*(A previous review attempt on 2026-08-21 was cut off by an API session limit after confirming the 4 planned mutations killed and restoring files; no verdict was written. This pass started from the top and re-ran everything; it did not reuse that attempt's results.)*

## 1. Probes run, with real output

### 1.1 Suites and coverage (claims vs. observed)

| Claim | Observed | Match |
|---|---|---|
| Fulfillment unit: 12 files / 57 tests | `Test Files 12 passed (12)`, `Tests 57 passed (57)` | ✅ |
| Fulfillment integration: 11 files / 36 tests | `Test Files 11 passed (11)`, `Tests 36 passed (36)`, 163.05s | ✅ |
| Orders unit: 387 | `Test Files 28 passed (28)`, `Tests 387 passed (387)` | ✅ |
| Domain coverage 93.63% (≥80 gate) | `domain 93.63 stmts / 91.66 branch`, all files 90.41% | ✅ |
| Orders integration (incl. new FS1/D1 describe) | `Test Files 17 passed (17)`, `Tests 52 passed (52)`, 352.28s | ✅ |
| `pnpm lint` / `pnpm typecheck` / root `pnpm test` / `pnpm build` / `./init.sh` | all exit 0 (root test: every workspace green, incl. seed 106, shared-kernel 68, contracts 22) | ✅ |

The only console noise in the integration runs is `TimeoutNegativeWarning` — a pre-existing kafkajs artifact already documented in `apps/orders/src/infrastructure/outbox/create-kafka-client.ts` (lines 10–15 name its exact magnitude/sign); not this feature's defect.

### 1.2 Mutation probes — 4/4 planned KILLED, 1 unplanned SURVIVED

Files backed up, mutated one at a time, suite run, restored, restoration verified by `sha256sum` (both domain files hash-identical to pre-probe: `12f176ba…` `stock-item.ts`, `5d54373f…` `order-stock-reservation.ts`), suite re-run green after restore.

| # | Mutation | Result |
|---|---|---|
| M1 | `StockItem.reserve` — removed the F1 guard (`reservedUnits + units > units` throw), aggregate over-reserves | **KILLED** — `stock-item.spec.ts › stock-item.spec — R30 › rejects in full any operation that would push reservedUnits above units and changes no stock item` |
| M2 | `reserveOrderStock` — reservation made partial (reserve satisfiable lines despite shortages; reject only when all lines short) | **KILLED** by 4 tests — FS8, the three-item-order F3 case, the repeated-product case, and the R33 matrix case |
| M3 | `releaseOrderStock` — second release emits a second `stock.released.v1` instead of the `already_released` no-op | **KILLED** — `order-stock-reservation.spec.ts › reservation-release › F5 — releasing an order whose reservations are all already released is a success no-op: no counter change, no fact` |
| M4 | `StockItem.replenish` — appended a domain event (R61 forbids) | **KILLED** — `stock-item.spec.ts › stock-replenishment › increases units by the requested quantity, leaves reservedUnits and every reservation unchanged and appends no domain event` |
| M5 | `stock-reservation.handler.ts` reserve short-circuit — added `&& reservation.status === 'reserved'` to the existing-reservations filter, so a re-issued `stock.reserve` after a release **re-reserves** instead of answering `already_reserved` | **SURVIVED — the entire unit suite passes (12/12 files), and no integration test seeds a terminal-status reservation before a reserve, so the integration suite cannot catch it either.** This is defect D1. |

### 1.3 The race (acceptance criterion) — re-run, assertions inspected

`stock-reserve-race.integration.spec.ts` re-run green inside the 36. Assertions inspected line by line: FS6 runs 10 fresh items, `Promise.all` of two raw-NATS reserves for the last 5 units, asserts sorted reply outcomes `['accepted','rejected']`, final `reserved_units === 5` (exactly the winner's, never both), and exactly one published `stock.reserved.v1` + one `stock.rejected.v1` per pair via `outboxRowsFor` with `publishedAt` stamped — replies, final counters, outbox only; no transient state polled. The binding synchronisation ruling is obeyed. The deadlock-shape test runs A `[P1,P2]` vs B `[P2,P1]` concurrently 10×, both accepted every time — consistent with the single `FOR UPDATE … ORDER BY (company_code, product_code)` statement in `DrizzleStockItemRepository.lockForOrder` (one lock statement, index-ordered, contenders wait, no `SKIP LOCKED`), which I verified in source.

### 1.4 The NATS wire (gate row 1)

Premise confirmed in the installed `@nestjs/microservices@11.2.1` source (`server/server-nats.js` `handleMessage`): `if (isUndefined(message.id)) return this.handleEvent(…)` — an id-less bare request never gets a reply. `BareJsonNatsDeserializer` assigns a synthetic id only when `options.replyTo` is present (which `ServerNats.handleMessage` sets from the raw NATS `reply` field); `BareJsonNatsSerializer` emits `packet.response` bare and maps `packet.err` to a bare `RpcError`. `stock-wire.integration.spec.ts` (6 cases, re-run green) sends raw `nats` `JSONCodec` requests against the **real `AppModule`** (the harness boots literally `Test.createTestingModule({ imports: [AppModule] })` with env pointed at the containers — no hand-wired graph) and asserts the decoded reply contains none of `response`/`isDisposed`/`id` on all five subjects plus the validation-failure path. `main.ts` installs the same (de)serializer pair the harness uses — production wiring and tested wiring match.

### 1.5 Headers (gate row 2) — R12/R15 across a service boundary, verified live

- Orders sends: `nats-saga-commands.adapter.ts` sets `x-correlation-id`/`x-request-id` via `nats` `headers()` on every call; `saga-command-dispatcher.ts` passes `{ correlationId: row.orderId, requestId: row.id }` on every attempt (unit tests named in the FS2 rows, all green in the 387).
- Fulfillment refuses without them: `stock.controller.ts` `parseRpcMeta` → `VALIDATION_FAILED`, dispatch never reached (controller unit tests + the live H3 record).
- **Live compose DB, queried directly this pass:** `otc_fulfillment.outbox` rows `stock.reserved.v1` have `correlation_id` = `ce8bee7c-…`/`cf5a406f-…` — exactly the `otc_orders.orders.id` of ORD-000010/ORD-000011 — and `causation_id` = `dd12415b-…`/`5992159f-…` — exactly the `otc_orders.saga_commands.id` of each order's `stock.reserve` row. The chain fact.correlationId = orderId, fact.causationId = saga-row-id holds on real cross-service data.

### 1.6 D1 fix (gate row 3)

`saga-compensation-credit-rejected.integration.spec.ts`'s new describe re-run green (inside the 17/52). Scenario inspected: `stock.release` parked via `respondToStockRelease: false`, a distinct-`eventId` `credit.rejected.v1` published, then — durable evidence only — the `processed_events` count grows (duplicate consumed, consumer alive), exactly **one** `stock.release` row with its **original id**, `attempts` climbs above the parked baseline (fast-path re-dispatch of the existing row), order still `stock_reserved`. If `enqueue` regressed to a plain insert the consumer would crash on `ER_DUP_ENTRY` and the `processed_events` wait would time the test out — the test genuinely guards the fix. The store diff is the specced `INSERT … ON DUPLICATE KEY UPDATE id = id` with outcome from `affectedRows`; `saga-fact-handler.ts` reports `enqueued = step.commandAfter` unconditionally (line 130).

### 1.7 Responder idempotency

- Re-issued `stock.reserve` for an order with existing **reserved** rows → `already_reserved`, no counter change, no second fact: integration test green + handler unit test proves no domain call/no `saveAll`. **For terminal-status rows the behaviour is implemented (the short-circuit filter has no status condition) but untested — defect D1.**
- Release of never-reserved → `already_released` with `[]`, no transaction, no fact (FS9 integration test green).
- Release of consumed → `PRECONDITION_FAILED`, nothing changes (FS10, seeded `consumed` row, green; plus the domain half).
- Double release → success no-op, no second fact (R34 matrix case, green; M3 proved the test bites).

### 1.8 Live-boot claims — verified against the compose stack

Queried `otc-mysql` directly this pass: ORD-000007/8/9 `stock.reserve` still `parked` (attempts 21 — the sweeper kept re-issuing while the processes ran); ORD-000010/11 exactly as reported: `stock.reserve` `sent` 0 attempts, `credit.hold` `parked` 18, orders `stock_reserved`, `otc_fulfillment.reservations` rows `PRD-0001 / 3 / reserved`, two `stock.reserved.v1` published `2026-08-21 17:08:53` / `17:09:18` — every value in impl §3 matches the database. `otc_fulfillment.stock` holds rows for exactly 5 company codes; `otc_orders.companies` holds 22 — the seed gap is real.

### 1.9 Parity guards and copies

- OI12 (`idempotent-consumer.parity.spec.ts`) green within the 387; independently re-verified byte identity of both files with the spec's own contiguous-`//`-banner normalisation: **IDENTICAL**. Case 1 now compares two real copies — no longer vacuous.
- OI11 (`outbox-parity`, seed) green within seed's 106.
- The five relay-family copies carry the `// COPY OF — apps/orders/src/…` banner (spot-checked `outbox-relay.ts`, `idempotent-consumer.ts`); the guard for that family is explicitly not armed — feature 19 owns the canonical's service-neutral refactor, honestly recorded in impl §6.

### 1.10 Conventions

- Domain purity: `grep` of `apps/fulfillment/src/domain/` for `@nestjs|drizzle-orm|kafkajs|nats|mongodb` — clean; the ESLint block at `eslint.config` line ~120 covers `apps/*/src/domain/**` and `pnpm lint` exits 0.
- Every `@MessagePattern` names `Transport.NATS` (five in `stock.controller.ts`); explicit `@Inject` throughout (`QueryBus`/`CommandBus` in the controller, `useFactory`+`inject` in `app.module.ts`); both enforced by the lint that passed.
- CQRS split as specced: queries (check, list) on `QueryBus`, commands (reserve, release, replenish) on `CommandBus`; `CqrsModule.forRoot()`.
- Subjects = AsyncAPI addresses proven read-the-spec-as-text (`stock.controller.spec.ts`).
- No Jest anywhere; Vitest only. No new catalog entries — `package.json` additions all `catalog:`. `tsconfig.build.json` excludes `src/**/test-support/**`. `.env.example` gained `FULFILLMENT_KAFKA_CLIENT_ID` with its comment. `git status` scope: all modified/untracked files belong to this feature (Orders confined to design §10's 12 files: 6 production + their specs + the test-support stub + the sweeper spec's mechanical ripple).

## 2. R/FS → test mapping verified

- **R30–R35, R61 (domain half)** — every `DONE` citation in `specs/shared/test-matrix.md` §4 checked against the actual test titles: all seven names exist **verbatim** in the cited files; summary counts (6 done / feature, 30 total) arithmetically correct; no other matrix row touched; R36 and R61's API half correctly left `TODO`.
- **FS1–FS4, FS6–FS17** — every citation in `specs/fulfillment_stock/requirements.md` §2 resolves to a real, passing, non-vacuous test (FS1/FS2 on the Orders side, FS17 to the live-boot record §1.8 above). FS14's reuse of R61's domain test is argued in impl §2.3 and is legitimate (FS14's own novelty is integration-level all-or-nothing `NOT_FOUND`, which has its own test).
- **FS5** — the cited test exists and passes but does **not** exercise the requirement's "(in any status)" clause. Row overclaims `DONE`. Defect D1.

## 3. Defects

### D1 (must fix) — FS5's "(in any status)" branch is implemented but untested; a status-filter regression survives the entire suite

- **Where:** `apps/fulfillment/src/application/stock-reservation.handler.ts` line 44–45 (the `existingReservations` filter — correct today: no status condition); missing coverage in `apps/fulfillment/src/application/stock-reservation.handler.spec.ts` (only a `status: 'reserved'` fixture, line 99) and in `apps/fulfillment/src/stock-reserve.integration.spec.ts` (the FS5 case re-issues only after an accepted reserve, so the existing rows are always `reserved`); no integration spec seeds a `released`/`consumed` reservation before a `stock.reserve` (the only terminal-status seeding in the suite is FS10's, on the release path).
- **Evidence:** mutation M5 (`&& reservation.status === 'reserved'` added to the filter) — full unit suite **passes** 12/12; grep confirms no integration test constructs the scenario either. Handler restored from the pre-mutation copy; suite re-run green.
- **Why it matters:** FS5's "(in any status)" wording is the gate-approved ruling of spec open point 7, whose stated rationale is exactly this hazard: *"A re-reserve after a release would double-reserve an order the saga already unwound."* The mutation is precisely that regression, it is silent (all green), and the clause is a promotion candidate #8/#9 are meant to inherit — an untested ruling exports as an untested ruling. The traceability row marks FS5 `DONE` on a test that does not exercise the requirement's distinguishing branch, which fails the review's traceability bar.

**Required fix (bounded):**

1. Add a handler unit test in `stock-reservation.handler.spec.ts`: existing reservations in status `released` (and/or `consumed`) → reply `already_reserved` carrying those refs, no domain call, no `saveAll`, counters untouched.
2. Add one integration case in `stock-reserve.integration.spec.ts`: seed a stock row plus a `released` reservation for the order (via `seedReservation`), issue `stock.reserve` with headers → `already_reserved` with the existing ref, `reserved_units` unchanged, outbox empty for that correlationId.
3. Update FS5's row in `specs/fulfillment_stock/requirements.md` §2 to cite the new test(s) (renaming/adding a test = editing its row).
4. Verify the fix kills mutation M5 (re-apply `&& reservation.status === 'reserved'` to the filter, expect the new tests to fail, restore).

Nothing else needs to change; do not touch the domain, the Orders side, or the shared matrix.

## 4. Ruling — the `apps/seed` stock gap (probe 8)

**Ruled: a genuine pre-existing `apps/seed` data-coherence defect, not a defect of feature 17, and not blocking this feature.** Facts: `otc_orders.companies` holds 22 companies, `otc_fulfillment.stock` covers 5; the seed itself places demo orders ORD-000007/8/9 against `ALBIONFOODS`, to which it gives no stock row — so the seed creates orders whose own saga can never progress past `stock.reserve` (`NOT_FOUND` → parked, by design). Feature 12's written acceptance ("initial stock") is literally satisfied, but the seed is internally incoherent: its demo orders and its stock data disagree. Feature 17's behaviour on this input — `NOT_FOUND`, orchestrator parks, loud and safe — is the designed negative path (design §3.3 / spec open point 10) observed working live; penalising feature 17 for it would be wrong. **Owner:** the leader should schedule a small `apps/seed` fix (either stock rows for every company that gets demo orders, or re-point ORD-000007/8/9 at stocked companies) **no later than feature 28 (`saga_e2e_verification`)**, which cannot demonstrate an end-to-end saga while three seed orders are permanently parked; folding it into feature 18's live-boot pass (which will want despatchable orders anyway) is the natural slot. Recorded here so it is owed, not forgotten.

## 5. CHECKPOINTS walked

- **C1** — [x] harness files exist; [x] progress files exist; [x] five agent defs; [x] all 5 declare a model; [x] `./init.sh` exit 0.
- **C2** — [x] no feature `in_progress` before this verdict (17 was `in_review`; set back to `in_progress` by this rejection); [x] statuses valid; [x] every `done` feature has passing tests; [x] `current.md` describes this session; [x] no `blocked` features.
- **C3** — [x] domain purity (ESLint + grep); [x] no cross-service DB access (Fulfillment references business codes only; the D1 test's cross-schema reads are test-harness-side, not service code); [x] no shared runtime beyond shared-kernel/contracts (copies are per-service with parity guards); [x] shared-kernel dependency-free; [x] every interaction classifiable (five NATS RPC responders per the matrix; three Kafka facts via outbox); [x] no stray debug logging / context-free TODOs found.
- **C4** — [x] `pnpm quality` green (lint, typecheck, test each exit 0); [x] domain tests pure; [x] integration via Testcontainers (real MySQL/Kafka/NATS); [ ] **coverage: gates numerically met (93.63/90.41) but the FS5 branch gap (D1) means the suite does not yet guard a normative behaviour — treated as part of D1, not a separate defect**; [x] no Jest.
- **C5** — [x] no suspicious untracked files; [ ] history entry — N/A, feature not closing on this verdict; [x] `feature_list.json` reflects true state after this review's flip; [x] human told what/how to test (impl §4); [x] no commit by Claude.
- **C6** — [x] `specs/fulfillment_stock/` complete (requirements/design/tasks); [x] EARS with ids; [x] all tasks ticked (and verified genuinely done, except that G3's FS5 case under-covers the requirement — D1); [ ] **every R covered by a test that exercises it — FS5 fails this box (D1)**; [x] spec commit (`ed5f343`-style, `docs(spec)` for this feature is in history before the implementation, which is uncommitted work-in-tree) precedes implementation.
- **C7** — [x] `specs/shared/` still stack-agnostic (only status flips this feature); [x] n8n untouched; [x] effort records honest to date.

## 6. What happens next

`fulfillment_stock` set back to `in_progress` in `feature_list.json`. The implementer fixes D1 exactly as bounded in §3 (two tests + one traceability row edit + the mutation re-probe), re-runs `pnpm --filter @otc/fulfillment test` and the reserve integration spec, and returns the feature to `in_review`. Re-review will be narrow: re-apply M5 expecting a kill, re-run the touched suites, re-check the FS5 row. Everything else in this feature is approved as examined and should not be re-touched.

---

# Second pass — 2026-08-22

**Verdict: APPROVED.** D1 is closed. My own re-application of mutation **M5** is now **KILLED at both levels** (2 unit cases + 1 integration case), the two new tests assert terminal evidence and are not vacuous, and `stock-reservation.handler.ts` is unchanged from the version approved on pass 1 — proved independently of the implementer's transcript. Feature 17 → `done`.

**Reviewer effort, this pass:** 1 session, ~35 min wall-clock, of which ~8.5 min Testcontainers (mutated integration run 178.28s + restored full integration run 332.77s).

**Scope of this pass, as instructed:** only (1) the two new tests, (2) my own M5 re-probe, (3) scope discipline, (4) suites/quality/init. Everything else stands as examined on pass 1 and was not re-opened.

## S1. The two new tests — read, and honest

### S1.1 Handler unit test — `apps/fulfillment/src/application/stock-reservation.handler.spec.ts:133–182`

`it.each(['released', 'consumed'] as const)('FS5 — already_reserved path short-circuits on a %s reservation (any status), calling no domain function and no saveAll', …)`. The fixture is deliberately discriminating: the stock item is seeded `units: 10, reservedUnits: 0` with **one terminal-status reservation** for the order — i.e. a state in which the requested 2 units *are* satisfiable, so a status-filtering handler would happily reserve. Assertions (lines 170–180): reply `outcome === 'already_reserved'`; the reply's `reservations` array `toEqual` the **exact** projection of the existing row (`reservationId`/`productCode`/`units`) — not a length check, so a short-circuit that returned an empty or wrong array would also fail; `saveAllCalled === false`; `item.reservedUnits === 0`; `item.reservations` length 1; `item.reservations[0].status === status`. Nothing tautological, no `expect(true)`, no assertion on a mocked return value. The last three are aggregate-state assertions that can only hold if `reserveOrderStock` was never called.

### S1.2 Integration case — `apps/fulfillment/src/stock-reserve.integration.spec.ts:124–164`

`it('FS5 — answers already_reserved for an order whose only existing reservation is already released (the saga-compensated case), reserving nothing new', …)`. Seeds a real stock row (`units: 10, reservedUnits: 0`) plus a **`released`** reservation for the order via `harness.seedReservation(...)` (a pre-existing helper — `stock-integration-harness.ts` mtime `2026-08-21 18:52`, untouched by this fix), then issues a real bare-JSON `stock.reserve` with both correlation headers over the real NATS/MySQL/Kafka graph. Assertions: reply `already_reserved` + one reservation matching `{ productCode, units: 3 }`; `stock.reserved_units` still **0** (the mutant drives it to 3); exactly one reservation row for the order and its status still `released` (no new row, no status change); **`outboxRowsFor(correlationId)` has length 0** — no fact emitted. All four are terminal-state reads taken *after* the RPC reply resolved, which per the binding synchronisation ruling is terminal evidence; no transient counter is polled and the zero-outbox assertion is not a race (under the mutant the outbox row is written in the same committed transaction as the reserve, so it is already visible when the reply returns — I confirmed the mutant fails on the reply assertion first, and the counters/outbox assertions are independently discriminating).

## S2. Mutation M5 — re-run by me, not read from the transcript

| Step | Command / evidence | Result |
|---|---|---|
| Baseline | `pnpm --filter @otc/fulfillment test` | `Test Files 12 passed (12)`, `Tests 59 passed (59)` |
| Backup + checksum | `sha256sum` of pristine handler | `1ecd7003 6130f295 8eb8caea 43862772 0b360188 d1c1cc64 b9728431 e2e7fb17` |
| Apply M5 | appended `&& reservation.status === 'reserved'` to the line-45 filter (single occurrence, asserted `count == 1` before replacing) | applied, verified by re-reading lines 44–46 |
| Unit under M5 | `pnpm --filter @otc/fulfillment test` | **`Tests 2 failed | 57 passed (59)`** — both new `it.each` cases: `AssertionError: expected 'accepted' to be 'already_reserved'`. **KILLED** |
| Integration under M5 | `pnpm --filter @otc/fulfillment test:integration` (the trailing file filter does not actually narrow — the whole suite ran) | **`Tests 1 failed | 36 passed (37)`** — only the new FS5 case: `expected { outcome: 'accepted', … } to match object { outcome: 'already_reserved', … }`. **KILLED**, and no other test perturbed |
| Restore | `cp` from the pristine copy, then `cmp` + `sha256sum` | `RESTORED byte-exact`, hash back to `1ecd7003…e2e7fb17` |
| Unit after restore | `pnpm --filter @otc/fulfillment test` | `12 passed (12)` / `59 passed (59)` |
| Integration after restore | `pnpm --filter @otc/fulfillment test:integration` | `11 passed (11)` / `37 passed (37)`, 332.77s |

The mutation is killed **precisely** — it takes down the two new unit cases and the one new integration case and nothing else, which is the signature of tests that target the requirement rather than incidentally overlapping it. Before the fix (pass 1 §1.2) this exact mutant survived 57/57 unit and 36/36 integration.

## S3. Handler file unchanged — proved without trusting the transcript

The implementer quotes a pre/post checksum, but a self-reported hash proves nothing about the *pass-1-approved* bytes. Two independent checks:

1. **Compiler-artefact baseline.** `apps/fulfillment/dist/application/stock-reservation.handler.js(.map)` was emitted at `2026-08-22 05:51:30` — during pass 1's `pnpm build`, **after** my M5 restore and **before** my 05:56:29 verdict — and has not been rebuilt since. Recompiling the *current* source with the same `tsconfig.build.json` into a scratch `outDir` gives a `.js` that is **byte-identical** to that baseline (`diff -q` → identical; `tsc` preserves comments, so comment edits would show), and a `.js.map` whose `version`/`mappings`/`names`/`file`/`sourceRoot` are all identical — the only differing field is `sources`, which is the outDir-relative path and necessarily differs. Identical `mappings` means every token sits at the same line *and column* as it did in the approved source.
2. **Checksum continuity.** The current file hashes `1ecd7003…e2e7fb17`, matching the implementer's claimed pre- and post-probe hash, and my own restore reproduced that same hash byte-exactly.

Conclusion: `stock-reservation.handler.ts` is the pass-1-approved file (at most modulo trailing whitespace invisible to both `tsc` output and the source map, which is also excluded by the sha256 matching the implementer's pre-mutation copy). **No production code changed to close D1** — the fix is tests only, exactly as bounded.

## S4. Scope discipline

`find` over `apps/`, `packages/`, `specs/`, `progress/`, `.env.example`, `feature_list.json` for files modified after the 05:56:29 verdict returns, in order:

| File | mtime | Verdict |
|---|---|---|
| `progress/review_fulfillment_stock.md` | 05:56:29 | my own pass-1 verdict |
| `apps/fulfillment/src/application/stock-reservation.handler.spec.ts` | 05:57:50 | **expected** (+2 tests) |
| `apps/fulfillment/src/stock-reserve.integration.spec.ts` | 05:58:01 | **expected** (+1 test) |
| `specs/fulfillment_stock/requirements.md` | 06:00:36 | **expected** (FS5 rows) |
| `apps/fulfillment/src/application/stock-reservation.handler.ts` | 06:04:03 | mutation + restore only — content proved identical (S3) |
| `apps/web/.nuxt/**`, `packages/contracts/src/generated/*.ts` | 06:04:40–06:05:43 | build/typecheck artefacts (not in `git status`, i.e. regenerated identically or ignored) |
| `progress/impl_fulfillment_stock.md`, `feature_list.json` | 06:08:13 / 06:08:19 | report + status flip |

No domain file, no Orders file, no `specs/shared/test-matrix.md` row, no harness, no other Fulfillment file. `specs/shared/test-matrix.md` has no FS-row by construction (it carries `R30`–`R35`/`R61`), so leaving it alone is correct, not an omission — confirmed by grep. The FS5 requirement text at `specs/fulfillment_stock/requirements.md:27` is unchanged; only the §2 traceability rows (75–76) moved, which is the required edit.

## S5. Suites, quality, init

| Gate | Observed |
|---|---|
| Fulfillment unit | `Test Files 12 passed (12)`, **`Tests 59 passed (59)`** (was 57, +2) |
| Fulfillment integration | `Test Files 11 passed (11)`, **`Tests 37 passed (37)`** (was 36, +1), 332.77s |
| `pnpm quality` (lint → typecheck → test, all workspaces) | **exit 0** — orders 387, fulfillment 59, seed 106, shared-kernel 68, contracts 22, billing/gateway/notifications/projector 1 each |
| Coverage | `domain 93.63 stmts / 91.66 branch`, all files `90.41 / 80.00` — gates (≥80 domain, ≥60 overall) met, unchanged by this fix as expected |
| `./init.sh` | **exit 0** — "environment and state are coherent"; only the two standing WARNs (uncommitted mid-session changes; `pnpm test` not run by init) |

The only console noise remains the pre-existing kafkajs `TimeoutNegativeWarning` documented in `create-kafka-client.ts`.

## S6. Traceability — the FS5 rows now hold

- `requirements.md:75` (**unit**) → the `it.each` block at `stock-reservation.handler.spec.ts:133`. Both instantiations exist and both die under M5.
- `requirements.md:76` (**integration**) → the original re-issue case (line 95, still green) **and** the new released-reservation case (line 124). Both `DONE` claims are now earned by tests that exercise FS5's distinguishing "(in any status)" branch.
- `requirements.md:96` still records the FS5 wording as a **promotion candidate** for `saga.md` §6, which is now backed by executable evidence rather than a comment — the point of the rejection.

## S7. Non-blocking nits found this pass (recorded, not blocking)

- **N1 — citation is a rendered template, not a literal title.** `requirements.md:75` cites *"…on a released/consumed reservation (any status)…"*; the two real titles are *"…on a **released** reservation…"* and *"…on a **consumed** reservation…"*, rendered from `%s`. The row unambiguously identifies the `it.each` block, so traceability holds, but a strict verbatim-title grep does not match. Harmless; worth knowing for #8/#9, where parameterised-test naming differs again (`[Theory]`/`InlineData` in .NET, `@pytest.mark.parametrize` in FastAPI) — **a traceability matrix that cites test names must state how it cites parameterised cases.**
- **N2 — one line of the addendum's transcript is not corroborated by the timeline.** §10 claims a post-restore `pnpm --filter @otc/fulfillment test:integration` re-run reporting "11 files / 37 tests". The handler was restored at 06:04:03 and the impl report written at 06:08:13; the interval (4m10s) is already occupied by the typecheck artefacts (06:04:40–06:04:50), the contracts regeneration (06:05:43) and `./init.sh`, and a full Fulfillment integration run measured 332.77s here. The mutated run *is* corroborated (its "1 failed / 36 of 37" matches my own run exactly, and it fits the 06:00:36→06:04:03 window). This is why I re-ran it myself: **the substance is verified green (S2/S5), so nothing is owed** — but the implementer should report only runs actually performed. Not a defect of the feature.

## S8. CHECKPOINTS re-walked (only boxes this pass could move)

- **C2** — [x] `feature_list.json` flipped `in_review` → `done` by this verdict; [x] statuses valid; [x] every `done` feature has passing tests; [x] `current.md` describes this session (it still reads `in_review`, consistent with the pre-verdict state; the leader resets it at session close); [x] no `blocked` features.
- **C4** — [x] `pnpm quality` green; [x] domain tests pure; [x] integration on Testcontainers; **[x] coverage — box now closed**: the numeric gates were always met, and the FS5 branch that made the number misleading on pass 1 is now guarded by three tests, proved by M5; [x] no Jest.
- **C5** — [x] no suspicious untracked files (scope table S4); **[x] history entry with effort record appended** (`progress/history.md`); [x] `feature_list.json` reflects true state; [x] human told what/how to test (impl §4 + §10); [x] no commit or push by Claude.
- **C6** — [x] `specs/fulfillment_stock/` complete; [x] EARS with ids; [x] all tasks genuinely done; **[x] every `R`/`FS` covered by a test that exercises it — FS5 box now closed** (S6, proved by M5); [x] spec precedes implementation.
- **C7** — [x] `specs/shared/` untouched by the fix and still stack-agnostic; [x] n8n untouched; [x] effort records honest (with N2 noted).
- **C1 / C3** — unchanged from pass 1, re-confirmed incidentally by `./init.sh` exit 0 and `pnpm lint` exit 0.

## S9. Carried forward (unchanged, still owed)

The pass-1 §4 ruling stands: the **`apps/seed` stock/demo-order incoherence** is a pre-existing feature-12 defect, not feature 17's, and is owed to the leader **no later than feature 28**, most naturally folded into feature 18's live-boot pass.

## S10. What this rejection bought — for the trilogy

The defect was found by a **fifth, unplanned mutation** invented while reading the requirement text, after the four planned mutations had all been killed. The four planned mutations came from the design's own hot spots; the one that bit came from asking "which clause of the *sentence* has no test?" — here, FS5's parenthetical **"(in any status)"**, a gate ruling on spec open point 7 whose whole purpose was to prevent a double-reserve after a saga compensation. Portable rule for #8 and #9: **mutate the sub-clauses of the requirement, not only the branches of the design.** A requirement that survives implementation as a comment (`// FS5 — … ANY reservation rows … whatever their status`) and not as a test exports to the next assessment as an untested ruling, and the comment is exactly where to look.
