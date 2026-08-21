# Review — `orders_acceptance` (id 15, phase 8)

**Verdict: REJECTED** — 1 blocking defect, 7 non-blocking. **3 of 4 hostile mutations KILLED**; the survivor is the blocker.

`sdd: false` — reviewed against `feature_list.json`'s three acceptance items, `specs/shared/asyncapi.yaml` (authoritative request/reply schemas), `specs/shared/saga.md` §1–§3.1, and `CLAUDE.md`. Nothing in this review is a re-read of `progress/impl_orders_acceptance.md`; every claim below was re-derived by running something.

The rejection is narrow and cheap to clear. The architecture is right, the transaction boundary is right, and the concurrency and timeout claims survived my own probes rather than the implementer's. What fails is a single, objectively-demonstrated coverage hole on the money fields of the reply contract, plus one provably-inert shutdown provider that this feature shipped.

---

## 1. Suites, run by me

| Suite | Command | Result |
|---|---|---|
| Orders unit | `pnpm --filter @otc/orders test` | **206 passed, 17 files**, 2.06s — matches the claim |
| Orders integration | `pnpm --filter @otc/orders test:integration` | **35 passed, 11 files**, 61.05s — matches the claim |
| Monorepo | `pnpm quality` | green (lint + typecheck + 206 orders / 103 seed / 1 fulfillment / 1 billing / contracts) |
| Clean-clone gate | `./init.sh` | `exit=0` |
| Coverage | `npx vitest run --coverage` (apps/orders) | domain **98.5 %** stmts / 91.25 % br (gate ≥80 %); overall **90.93 %** (gate ≥60 %) |

Real containers observed mid-run via `DOCKER_HOST=unix:///var/run/docker.sock docker ps`: `mysql:8.4.11`, `apache/kafka:4.3.1`, `testcontainers/ryuk:0.14.0`, and `nats:2.14.5-alpine` for the NATS specs. The two-daemon split is environmental as documented and is not counted against the feature.

Two `TimeoutNegativeWarning` lines appear in the integration run. I traced every `setTimeout` call site in `apps/orders/src` — all four pass positive constants — so the warning originates in a dependency (testcontainers/kafkajs), not in this feature's code. Recorded as an observation, not a defect.

## 2. Kafka-vs-NATS discipline — the headline check

Verified by grep over production code (`apps/orders/src`, excluding `*.spec.ts` and `test-support/`), then by reading each hit:

- **Command `orders.create` → NATS request-reply.** `presentation/orders-create.controller.ts:37` `@MessagePattern('orders.create')`, served by the hybrid app's `connectMicroservice({ transport: Transport.NATS })` at `main.ts:15-19`. The end-to-end spec drives it through a real `ClientProxyFactory` over a real broker, so the wire protocol is exercised, not simulated.
- **Query `fulfillment.stock.check` → NATS request-reply.** `infrastructure/messaging/nats-stock-availability.adapter.ts:75` `connection.request(subject, data, { timeout })`. Read-only, mutates nothing, emits nothing — matches R31's "non-locking read, explicitly not a reservation".
- **Fact `order.placed.v1` → Kafka via the outbox, never NATS.** The only production emission path is `domain/order-events.ts:55` → `pullDomainEvents()` → `OutboxRecorder` (inside the same tx) → `OutboxRelay` → `KafkaFactPublisher`. There is **no** `.publish(` on any NATS connection anywhere in production code; the only NATS verbs in `apps/orders/src` outside tests are one `@MessagePattern` and one `.request(`.
- **Nothing publishes a fact directly.** `DrizzleOrderRepository.save` — not the handler — drains the aggregate (`order.repository.ts:125-126`), so a handler cannot emit by writing its own producer call.
- **NATS core only.** Repo-wide grep for `jetstream`/`.jsm()`/`withJetStream` returns **only comments** stating that JetStream is not used, plus `docker-compose.infra.yml:183-187` whose command is `["-p","4222","-m","8222"]` with no `-js`. `@testcontainers/nats` is started without `.withJetStream()`.

**PASS.** Every interaction is classifiable by the matrix: command and query over RPC, fact over the log.

## 3. Contract conformance

Types are imported from `@otc/contracts` (`packages/contracts/src/index.ts:93-100` re-exports `RpcError`, `OrdersCreateRequestPayload`, `OrdersCreateReplyPayload`, `StockCheckRequestPayload`, `StockCheckReplyPayload` out of `src/generated/`). No hand-written wire types were added — the only `interface *Payload` declarations outside `packages/contracts` are the six pre-existing `HealthPayload` health-endpoint types.

`OrdersCreateRequestDto` (`presentation/dto/orders-create.dto.ts:54`) `implements OrdersCreateRequestPayload`, which makes drift a compile error rather than a review opinion. Field-by-field against `asyncapi.yaml:2964-3003`: `requestId` optional UUID ✓, `retailerCode`/`companyCode` required strings ✓, `currency` `^[A-Z]{3}$` ✓, `lines` array `minItems: 1` with nested validation ✓, per-line `productCode`+`quantity` required and `quantity` strictly positive integer ✓ (matches `Quantity: minimum 1`), `unitPrice`/`lineDiscount` optional non-negative **integers** ✓ (`@IsInt() @Min(0)` — minor units, never a float), `orderDiscount` optional ✓, `notes` optional ✓. Required-ness matches the schema's `required:` list exactly.

Reply (`asyncapi.yaml:3005-3033`): all eight properties emitted, `status` the literal `'placed'`, every money field an integer minor-unit count sourced from `Money.amount`. `RpcError` codes used by `rpc-error-mapper.ts` — `VALIDATION_FAILED`, `NOT_FOUND`, `STOCK_UNAVAILABLE`, `TIMEOUT`, `UNAVAILABLE`, `INTERNAL_ERROR` — are all members of the schema's enum, and `code`+`message` (the only required fields) are always present.

The stock-check pair likewise conforms (`asyncapi.yaml:3074-3120`): request `{companyCode, lines[{productCode, quantity}]}`, reply `{available, lines[{productCode, requested, available, sufficient}]}`.

Reply-shape discrimination (success object vs `RpcError` object on the same reply address, never a thrown `RpcException`) is a defensible reading of `asyncapi.yaml:249-264`, which lists both messages on the one `ordersCreateReply` channel. Accepted.

**One behavioural gap against the authoritative contract:** `OrdersCreateRequestPayload.requestId`'s description is normative — *"A repeat with the same value returns the original order instead of placing a second one."* No replay lookup exists. The implementer disclosed this honestly and it is outside the three acceptance items, so it is **not** the reason for rejection, but it is currently recorded only in an implementation report. See D3.

## 4. Atomicity — proved by me, not re-read

I wrote a throwaway `zz-reviewer-probe.integration.spec.ts` (real MySQL + real NATS, since deleted; `md5sum -c` confirms every production file is byte-exact and `git status` is back to its 40 pre-review entries).

**P2 — outbox write forced to fail *after* the aggregate row is already in the transaction.** I injected an `OutboxRecorder` that runs exactly where the real one runs (`order.repository.ts:126`, after the `orders` and `order_items` inserts, inside the same `tx`), first `SELECT`s the `orders` table *through the transaction handle* to prove the row is really there, then throws:

```
P2 threw: probe: outbox write forced to fail | order rows visible inside tx before the failure: 1 | counter before/after: 25 25
```

After rollback: `orders` count unchanged, `outbox` count unchanged, `order_items` count unchanged, and the order-number counter unchanged. The aggregate row demonstrably existed inside the transaction and demonstrably does not exist after it. **Neither persists. R13 holds on the acceptance path.**

**P2b — the rejection path.** With the stock port answering `available: false`, `execute()` rejects and `orders` and `outbox` counts are both unchanged. The `UnitOfWork` is never opened at all (`place-order.handler.ts:91-93` throws before line 99), so there is no transaction to leak and no fact to suppress. **Nothing persisted, no fact emitted.**

## 5. Timeout handling — proved by me

**P5 —** a subscriber present on `fulfillment.stock.check` that accepts every request and never replies (deliberately not the fast `NoResponders` path), against an adapter with an 800 ms budget:

```
P5 elapsed= 808 ms err= StockCheckTimeoutError fulfillment.stock.check: no reply within 800ms on subject "fulfillment.stock.check"
```

Bounded at the configured deadline, typed distinctly from a business rejection, and mapped to `RpcError.code = 'TIMEOUT'` by `rpc-error-mapper.ts:44-51` — which is exactly what `asyncapi.yaml:2705-2708` says `TIMEOUT` is for ("produced **by the caller**, not by a responder"). The full-RPC equivalent in `orders-acceptance.integration.spec.ts:161-188` bounds the *responder's* own reply too. **No hang. Meaningful, distinguishable failure.**

## 6. Order-number allocation — proved by me

**P1 — concurrency.** 24 allocators racing in 24 separate transactions against real MySQL:

```
P1 base= 1 allocated= 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24
```

Gap-free, duplicate-free, `Set` size 24. This is my own probe at 24 callers, not a re-run of the implementer's 10.

**P4 — continuation past pre-existing references.** I placed a real order at `ORD-900000` through the real repository, then deleted the counter row to simulate a virgin counter over a populated `orders` table:

```
P4 after MAX=ORD-900000 with an empty counter, next= ORD-900001
```

The self-initialising `INSERT ... ON DUPLICATE KEY UPDATE` seeded from `MAX(orders.order_reference) + 1` genuinely continues past whatever the database already holds — including the seed's `ORD-000001..006`.

**P3 — rollback.** A transaction that allocates and then throws:

```
P3 rolled-back allocation= ORD-000025  next allocation= ORD-000025
```

**Ruling on gaps-on-rollback: gap-free is the correct contract here, and it is what is implemented.** `ORD-######` is a human-facing business reference printed on documents and quoted in support conversations; a burned number invites "where did ORD-000042 go?" every time a placement fails, and `domain-model.md` §2.3 calls the reference *sequential*. Because allocation happens inside the placing transaction (`place-order.handler.ts:100`), a rollback returns the number rather than burning it. The price is real and should be recorded: the exclusive row lock on the single counter row is held for the **whole** placing transaction, so every concurrent `orders.create` serialises behind the slowest one. That is acceptable at this scale and correct at any scale — but it is the throughput ceiling of order acceptance and belongs in a design note (D7).

## 7. Feature 14's D1 fix

`OUTBOX_PUBLISH_TIMEOUT_MS` is now genuinely enforced: `outbox-relay.ts:116` races `publisher.publish(facts)` against a `setTimeout(publishTimeoutMs)` and treats expiry like any other publish failure — batch left unstamped, retried unchanged on the next poll (OI8). Mutation M1 below proves the enforcement is load-bearing, not decorative. `design.md` §5.2's claim that the open claim transaction is bounded is now true as shipped. **D1 from `review_outbox_and_idempotency.md` is closed.**

## 8. The stub responder

`infrastructure/messaging/test-support/stub-stock-check-responder.ts` is referenced from exactly two files, both `*.integration.spec.ts`. No production module imports it, and there is no always-yes shortcut inside the service: point the adapter at a broker with no Fulfillment listening and you get a genuine `StockCheckTransportError`/`StockCheckTimeoutError`. **No test double on a production code path.**

One hygiene miss: `tsconfig.build.json` excludes `src/**/*.spec.ts` but not `test-support/`, so `apps/orders/dist/infrastructure/messaging/test-support/stub-stock-check-responder.js` is compiled into the shippable build artefact. Dead weight, reachable by nothing — see D5.

## 9. Mutation probe — 3/4 KILLED

Each edit applied to a pristine tree and restored byte-exact afterwards (`md5sum -c` verified, `git status` back to its 40 pre-review entries).

| # | Hostile edit | File | Result |
|---|---|---|---|
| M1 | Remove the publish-timeout race — `await this.publisher.publish(facts)` directly | `infrastructure/outbox/outbox-relay.ts:116` | **KILLED** — `outbox-relay.integration.spec.ts` › *bounds the open claim transaction by OUTBOX_PUBLISH_TIMEOUT_MS ...* hung and failed on the 60 s test timeout |
| M2 | Make the rejection path persist anyway — neuter the `!stockResult.available` throw | `application/place-order.handler.ts:91` | **KILLED** — `place-order.handler.spec.ts:118` › *rejects when the stock check reports unavailability* (`executeSpy` was called, an order was returned) |
| M3 | Break the reply contract mapping — `totalAmount: result.initialAmount` | `presentation/orders-create.controller.ts:53` | **SURVIVED** — 206/206 unit **and** 3/3 acceptance integration tests still green. See D1 |
| M4 | Allocate outside the row lock — drop `.for('update')` | `infrastructure/persistence/order-number-allocator.ts:73` | **KILLED** — `order-number-allocator.integration.spec.ts` › *is concurrency-safe: N callers racing next() ...* |

M3 is the blocker. Returning the **pre-discount** amount in a field the contract defines as the payable total is a plausible, silent, money-affecting bug, and the entire suite is blind to it.

## 10. Acceptance items → tests I verified

| Acceptance item | Test that actually exercises it | Verified |
|---|---|---|
| Synchronous stock check via NATS `fulfillment.stock.check` | `stock-check.integration.spec.ts` (real broker, real request/reply/timeout); `nats-stock-availability.adapter.spec.ts`; `orders-acceptance.integration.spec.ts:123` | Yes — plus my own P5 |
| Order id returned synchronously | `orders-acceptance.integration.spec.ts:123-141` (real `ClientProxy` → real NATS → real MySQL, `orderId` matched and the row re-read by that id) | Yes |
| Rejection when stock check fails | `orders-acceptance.integration.spec.ts:143-159` (business rejection, run twice) and `:161-188` (timeout), both asserting the `orders` table did not grow; `place-order.handler.spec.ts:118` asserts the `UnitOfWork` is never opened | Yes — plus my own P2b |

No `R<n>` row in `specs/shared/test-matrix.md` is newly proven by this feature, and none was flipped. I checked the one candidate: **R31**'s row (line 124) is scoped to `fulfillment/integration/stock-check.spec` › *answers per line without mutating a stock item and without emitting a fact* — that is the **responder-side** proof and belongs to feature 17. Leaving it `TODO` is correct, not an omission. R6 and R13 were already `DONE`. **The implementer's traceability claim is accurate.**

## 11. CHECKPOINTS walked

### C1 — harness
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds all five agents.
- [x] Every agent definition declares its model.
- [x] `./init.sh` exits 0 (re-run by me).

### C2 — state
- [x] At most one feature `in_progress` — 23 pending, 14 done, 1 `in_review` (this one), 0 `in_progress`.
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests.
- [ ] **`progress/current.md` is out of lockstep** — it reads `Status: in_progress` while `feature_list.json` says `in_review`. Recurrence of feature 13's D4. See D4.
- [x] No `blocked` features.

### C3 — architecture
- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import in any `domain/` folder — ESLint's `no-restricted-imports` block covers `apps/*/src/domain/**` and `pnpm quality`'s lint step is green. (`@otc/contracts` type imports in `domain/` are pre-existing and permitted by the rule.)
- [x] No cross-service database access; no FK crosses a boundary. This feature reads only `otc_orders`.
- [x] No new shared runtime code — the two new packages (`nats`, `class-validator`/`class-transformer`) are per-app dependencies via the catalog.
- [x] `packages/shared-kernel` still dependency-free.
- [x] Every interaction classifiable Kafka-fact vs NATS-RPC — §2 above.
- [x] No stray debug logging, no context-free TODOs. The four `console.*` sites are the pre-existing bootstrap banner, the migrate CLI, and the relay's structured-JSON error logger.

### C4 — verification
- [x] `pnpm quality` passes (run by me).
- [x] Domain tests pure — no framework, DB or broker.
- [x] Integration tests use Testcontainers against real MySQL / Kafka / NATS — containers observed running.
- [x] Coverage: domain 98.5 % (≥80 %), overall 90.93 % (≥60 %).
- [x] No Jest anywhere — repo-wide grep for `jest`/`ts-jest`/`jest.config` returns nothing.
- [ ] **Tests would not fail if the behaviour regressed** — M3 survived. This is the box that fails.

### C5 — session close
- [ ] **No suspicious untracked files** — clean in the tree, but `dist/` carries a compiled test double (D5).
- [ ] **`progress/history.md` entry with effort record** — absent, correctly: the reviewer writes it on approval.
- [ ] **`feature_list.json` reflects true state** — set back to `in_progress` by this review.
- [ ] The human has been told what was done and how to test manually — pending the re-review.
- [x] **Claude did not commit.** No `git commit` or `git push` was run at any point in this review.

### C6 — SDD
Not applicable: `orders_acceptance` is `"sdd": false`. No `specs/orders_acceptance/` is required and none exists — correct.

### C7 — trilogy reusability
- [x] `specs/shared/` untouched by this feature and still free of NestJS/Drizzle/Nuxt/MySQL specifics.
- [x] `n8n/workflows/` untouched.
- [ ] `progress/history.md` effort records complete — pending this feature's entry.

## 12. Ruling on the DI-metadata blast radius

**The implementer's finding is real, is more general than Orders, and must not be left as a local `@Inject()`.** I confirmed the mechanism rather than taking it on trust:

- `tsconfig.base.json:10` sets `emitDecoratorMetadata: true`, so **`pnpm build` (tsc) emits `design:paramtypes`**.
- Every one of the six services' `dev` script is `tsx watch src/main.ts`, and **esbuild does not implement `emitDecoratorMetadata`**, so `pnpm dev:*` does not emit it.
- Nest's reflection-based token inference falls back to `undefined` for a bare-typed parameter rather than throwing, so the container builds cleanly and the failure appears only at first use.

This is the most dangerous shape a bug can take: **the same source behaves differently under `pnpm dev:*` and under `pnpm start`**, and Vitest catches neither (the specs construct classes with `new` or wire them with `useValue`, so paramtypes are never consulted). Only the live-service step caught it, and features 17–26 will not always have a live-service step.

Blast radius today is nil — Orders is consistent. I audited every constructor in `apps/*/src`: exactly two classes are decorator-injected (`OutboxRelayService`, `OrdersCreateController`) and **both** use explicit `@Inject()`; every other provider in `app.module.ts` is `useFactory` + explicit `inject: [...]`, which is entirely metadata-independent. The other five services have no DI graph yet.

Blast radius tomorrow is large. Feature 16 is the saga orchestrator, which the plan builds on `@nestjs/cqrs` — and `@CommandHandler`/`@EventsHandler` classes are conventionally written with bare-type constructor injection. Written that way here, they will work in tests, work in `pnpm start`, and silently inject `undefined` under `pnpm dev:orders`. Features 17–26 repeat that across five more services.

**What should be done now, in this order:**

1. **Close the divergence at source (preferred).** Make the dev runner emit the metadata the compiler emits — either move `dev` to SWC with `legacyDecorator: true, decoratorMetadata: true`, or to `tsc --watch` + `node --watch dist/main.js`. Then `pnpm dev` and `pnpm start` cannot disagree, and the convention below becomes belt-and-braces rather than the only defence. This is a root-level change (`apps/*/package.json` scripts + one dev-dependency), so it is the leader's call, not an implementer's.
2. **Make the existing convention explicit and checkable.** `CLAUDE.md`'s architecture conventions should state the rule this repo has been following by accident: *every constructor parameter of an `@Injectable()`/`@Controller()` class carries an explicit `@Inject(TOKEN)`; provider wiring otherwise uses `useFactory` + `inject: [...]`, never bare-type inference.* Back it with an ESLint `no-restricted-syntax` selector that flags a parameter property inside a Nest-decorated class with no `@Inject` decorator — the same "convert a rule reviewers enforce by hand into a check" instrument this project already used for `OI11`/`OI12`.
3. **At minimum, tell the next features.** Even if 1 and 2 are deferred, features 16, 17, 21, 23, 25 and 26 must be briefed, because each of them is the first DI graph in its service.

I am **not** rejecting on this — Orders is internally consistent and the local fix is correct. But it is a harness-level hazard, and leaving it in one implementation report is how it gets rediscovered five more times.

## 13. Defects

### D1 — BLOCKING. The reply's money mapping is vacuously covered

**Files:** `apps/orders/src/presentation/orders-create.controller.ts:47-56` (the mapping); `apps/orders/src/presentation/orders-create.controller.spec.ts:33-35`, `apps/orders/src/application/place-order.handler.spec.ts:104-106` (both fixtures use `initialDiscount: 0`, so `totalAmount === initialAmount`); `apps/orders/src/orders-acceptance.integration.spec.ts:123-141` (asserts `status`, `orderId`, `orderReference` — **no money field at all**).

Replacing `totalAmount: result.totalAmount` with `totalAmount: result.initialAmount` leaves **206/206 unit and 3/3 acceptance integration tests green**. No test anywhere constructs a reply in which `initialDiscount != 0`, so nothing can distinguish the payable total from the pre-discount amount.

**Why it matters:** minor-unit money is a `CLAUDE.md` non-negotiable and `totalAmount` is a *required* field of `OrdersCreateReplyPayload`. `asyncapi.yaml:1811` further notes that the `.99` credit-simulator predicate (R42) reads `totalAmount mod 100 = 99` — so a wrong `totalAmount` would not merely mis-report to the caller, it would change which orders the saga rejects for credit in feature 22. This is the single highest-consequence mapping in the feature and it is the one the suite cannot see.

### D2 — `NatsConnectionCloser` is provably dead, and it takes the relay's graceful drain with it

**Files:** `apps/orders/src/app.module.ts:33-42` (the class) and `:80-84` (the provider); `apps/orders/src/main.ts` (no `app.enableShutdownHooks()` anywhere — repo-wide grep returns zero hits).

Nest invokes `onApplicationShutdown` only from `app.close()`, and only `enableShutdownHooks()` wires process signals to it. I probed it with a minimal Nest app: without `enableShutdownHooks()`, `SIGTERM` fires the hook **0 times**.

**Why it matters:** the class exists for exactly one purpose — closing the outbound NATS connection on shutdown — and it cannot ever run. Worse, the same missing line makes `OutboxRelayService.onApplicationShutdown` (feature 14, `outbox-relay.service.ts:43-52`) equally inert, so the relay's "no cycle is left running after shutdown resolves" guarantee is not in force either: a container stop can kill the process mid-publish. One line in `main.ts` fixes both. Ship a lifecycle provider or do not, but do not ship one that cannot fire.

### D3 — `requestId` idempotent replay is unimplemented and untracked

**File:** `apps/orders/src/application/place-order.handler.ts:35-36` and `:156-165`.

`asyncapi.yaml:2968` states the behaviour normatively: *"A repeat with the same value returns the original order instead of placing a second one."* The field is accepted and validated but only ever seeds `causationId`; a repeated `requestId` places a second order. The implementer disclosed this clearly and it is genuinely outside the three acceptance items, so it does not block — but it currently lives only in an implementation report. **Why it matters:** the Gateway (feature 30) and the n8n workflows will assume the contract, and a client retry after a network blip will silently create a duplicate order. It needs a `feature_list.json` entry or an explicit line in the affected feature's acceptance list, not a paragraph in a progress file.

### D4 — `progress/current.md` contradicts `feature_list.json`

**File:** `progress/current.md:7` reads `**Status:** in_progress` while `feature_list.json` had the feature at `in_review`. Exact recurrence of feature 13's D4. **Why it matters:** `current.md` is the working memory a fresh session reads first; when it disagrees with the state machine, the next agent starts from a false premise.

### D5 — a test double is compiled into the shippable build

**File:** `apps/orders/tsconfig.build.json` excludes `src/**/*.spec.ts` but not `test-support/`, so `apps/orders/dist/infrastructure/messaging/test-support/stub-stock-check-responder.js` and `nats-test-fixture.js` are emitted. **Why it matters:** nothing imports them, so this is not a C3 violation today — but a stub that answers `fulfillment.stock.check` with `available: true` sitting inside the production artefact is precisely the thing that must never become one `require` away from a code path. Add `"src/**/test-support/**"` to the exclude list.

### D6 — the allocator's self-initialisation uses a lexical MAX

**File:** `apps/orders/src/infrastructure/persistence/order-number-allocator.ts:56-59`.

`max(orders.order_reference)` is a **string** max. Correct while every reference is `ORD-` plus six digits, but once the sequence crosses 999 999 (`OrderNumber.fromSequence` widens to seven digits) `'ORD-1000000' < 'ORD-999999'` lexically, so a virgin counter would re-seed **backwards** and collide with existing references. It only bites when the counter row is absent — first-ever call or a manual wipe — which is exactly the disaster-recovery moment. **Why it matters:** a silent wrong answer on a uniqueness-critical business reference. Ordering by `LENGTH(order_reference), order_reference`, or by `CAST(SUBSTRING(order_reference, 5) AS UNSIGNED)`, closes it.

### D7 — the counter row serialises the whole placing transaction (design note, not a bug)

**File:** `apps/orders/src/application/place-order.handler.ts:100` allocates inside the `UnitOfWork`, and `order-number-allocator.ts:73`'s `FOR UPDATE` holds the exclusive lock until commit. My P1/P3 probes confirm this is what makes the sequence gap-free, which I ruled correct in §6. **Why it matters:** it is nonetheless the throughput ceiling of order acceptance — every concurrent `orders.create` queues behind the slowest transaction — and the trade (gap-free references bought with serialised placement) is currently only implicit in a source comment. It should be an explicit, dated design note so feature 16 and the load-testing feature do not rediscover it as a mystery.

### D8 — `TimeoutNegativeWarning` in the integration run (observation)

Two `TimeoutNegativeWarning: -1787287509809 is a negative number` lines appear during `test:integration`. All four `setTimeout` call sites in `apps/orders/src` pass positive constants, so this comes from a dependency. Not attributable to this feature; recorded so it is not mistaken for a regression later.

## 14. What must change before re-review

1. **D1 (required).** Add at least one test in which `initialDiscount != 0`, asserting `totalAmount === initialAmount - initialDiscount` on the reply object. A unit case in `orders-create.controller.spec.ts` with a line carrying a non-zero `lineDiscount` is enough; better still, also assert the four money fields plus `currency` in `orders-acceptance.integration.spec.ts`'s happy-path test, so the contract's money fields are proven over the real wire. Then re-run mutation M3 (`totalAmount: result.initialAmount`) and confirm it now fails.
2. **D2 (required).** Either call `app.enableShutdownHooks()` in `apps/orders/src/main.ts` — which also re-arms feature 14's relay drain — or remove `NatsConnectionCloser` and say plainly that the connection is not closed on shutdown. Do not ship an inert lifecycle provider. If the hook is enabled, add a test or a documented manual step proving it fires.
3. **D5 (required, one line).** Exclude `src/**/test-support/**` from `apps/orders/tsconfig.build.json`.
4. **D4 (required, one line).** Bring `progress/current.md` back into lockstep with `feature_list.json`.
5. **D6 (recommended).** Make the self-initialisation ordering numeric, with a test that seeds `ORD-1000000` and asserts the next allocation is `ORD-1000001`.
6. **D3, D7 (recommended, cheap).** Raise `requestId` idempotency as a tracked backlog item rather than a report paragraph, and record the gap-free-vs-serialised trade as a design note.
7. **DI metadata (leader-level, not the implementer's).** Act on §12 items 1–3 **before feature 16 starts**. The saga is the first `@nestjs/cqrs` graph in this repository and is the most likely place for this to recur.

Everything in §2–§8 — the transport discipline, the transaction boundary, the timeout bound, the allocator's concurrency safety and continuation, the D1-from-feature-14 fix, and the stub's containment — I re-derived independently and **all of it passed**. This rejection is one missing assertion and one dead provider away from an approval.

---

# Second pass — re-review (2026-08-21)

**Verdict: APPROVED.** The blocking defect **D1 is dead**: hostile mutation **M3 is now KILLED at unit *and* integration level**, and two further money-field mutations of my own are killed too. Every other required fix (D2, D5) and every recommended one (D3, D6, D7, D8) is verified by my own probe, not by re-reading the report. Part 2's DI-metadata fix is real across all six services and its ESLint guard fires on violations *I* wrote. **6 defects remain open, none blocking** — one of them pre-existing and in another package, one leader bookkeeping.

Everything below was re-derived by running something. Every file I mutated was restored byte-exact: a 382-file `md5sum -c` baseline taken before the review re-verifies clean at the end, and `git status` is back to its 53 entries.

## 1. Suites, re-run by me

| Suite | Command | Result |
|---|---|---|
| Orders unit | `pnpm --filter @otc/orders test` | **212 passed, 19 files** — green in 7 of 8 runs. **1 red run**, see N1 |
| Orders integration | `vitest run --config vitest.integration.config.mts` | **36 passed, 11 files** (real MySQL + Kafka + NATS) |
| Monorepo | `pnpm quality` | **exit 0** (lint + typecheck + 212 orders / 103 seed / 6 contracts / 1 fulfillment / 1 billing) |
| Build | `pnpm build` | exit 0, all six services |
| Clean-clone gate | `./init.sh` | exit 0 |
| Coverage | `vitest run --coverage` (apps/orders) | domain **98.5 %** stmts / 91.25 % br; overall **90.93 %** — unchanged from pass 1, both gates clear |

## 2. D1 — BLOCKING, now CLOSED

**M3 re-run by me, exactly as specified in pass 1** (`totalAmount: result.initialAmount` at `orders-create.controller.ts:54`):

- Unit: `orders-create.controller.spec.ts` › *maps initialAmount, initialDiscount and totalAmount onto DISTINCT reply fields when the order carries a discount* → **FAILS** (`expected { …(8) } to match object { currency: 'EUR', …(3) }`).
- Integration, over the **real NATS wire against real MySQL**: `orders-acceptance.integration.spec.ts` › *returns an order id synchronously, and the order row + its outbox record commit together* → **FAILS**. Pass 1's exact blind spot is now covered at the contract boundary, not only in a unit fixture.

**The coverage genuinely discriminates all three money fields, not just the one I named.** Two additional mutations of mine, applied to `place-order.handler.ts:184-195`'s `toResult` (a different layer from M3, so these could not be satisfied by a test written against the controller alone):

| Mutation | Result |
|---|---|
| `initialDiscount: order.totalAmount.amount` | **KILLED** |
| `initialAmount: order.totalAmount.amount` | **KILLED** |

The fixtures are `2000 / 300 / 1700` — three pairwise-distinct values with a non-zero `lineDiscount`, so no two fields can stand in for each other. `totalAmount !== initialAmount` is asserted explicitly at all three levels. This is a fixture fix, which is the correct fix: pass 1's hole was that every money field collapsed to the same number.

## 3. D2 — closed, and verified against the **real** AppModule

The implementer proved the mechanism with two synthetic Nest apps. That is a proof about `enableShutdownHooks()`, not about *this service*, and the review asked specifically about feature 14's relay drain. So I wrote my own probe against the **real `AppModule`** (`NestFactory.create(AppModule)` + `connectMicroservice(NATS)` + `listen`, against the live compose MySQL and NATS), monkeypatched the container's actual `OutboxRelayService` instance to log around its real `onApplicationShutdown`, and sent a genuine `kill -TERM`:

```
with:    exited after 108ms
         READY
         RELAY_DRAIN_STARTED:SIGTERM
         RELAY_DRAIN_COMPLETED
without: exited after 107ms
         READY
```

The `without` run is the identical file with the single `enableShutdownHooks()` call skipped. **Feature 14's graceful drain is genuinely re-armed in the shipped service**, and `NatsConnectionCloser` with it. The silent casualty is no longer silent, and it is no longer a casualty. Probe deleted afterwards.

## 4. D3 — the scope-out is honest

I checked every place that could lie about it:

- `place-order.handler.ts:35` now says, in the code: *"NOT resolved against a stored request — a repeated `requestId` places a second order today"*, and names feature 39. No code, DTO, comment or test claims replay works.
- `feature_list.json` id **39** `orders_idempotent_replay` (`sdd: true`, `pending`) carries three acceptance criteria including the concurrent-duplicate race, plus a `notes` field recording *why* it was not folded in. That is a tracked backlog item, not a paragraph in a progress file — which is what D3 asked for.
- `specs/shared/asyncapi.yaml:2970` is **untouched**, still normative. Correct: it is the target contract for #8 and #9, and weakening it here to match one stack's current state would corrupt the shared spec. The honest position — contract states the target, state machine tracks the gap, code says plainly it is unimplemented — is the one taken.

**Judgement: honest.** Nothing overclaims.

## 5. D5 — no test double reaches `dist/`

`rm -rf apps/orders/dist && pnpm --filter @otc/orders build`, then a `find` for `*test-support*`, `*spec*`, `*probe*`, `*stub*`, `*fixture*` across `dist/`: **no matches**, 59 emitted `.js` files. `tsconfig.build.json` excludes both `src/**/*.spec.ts` and `src/**/test-support/**`. Closed. (Latent gap recorded as N4.)

## 6. D6 — fixed, and **my stated mechanism was wrong; the implementer is right**

The fix is real and discriminating: I reverted the SQL to a lexical max (`cast(substring(max(order_reference), 5) as unsigned)`) and `order-number-allocator.integration.spec.ts` › *computes the numerically-correct MAX(order_reference), not the lexical one, across a digit-width crossing* **fails** (`expected [Function] to throw error including '1000001' but got '"1000000" is not a valid ORD-######…'`). Restored; 36/36 green again.

**Correction to pass 1, recorded because reviewing the reviewer is exactly what a re-review is for.** Pass 1's D6 said *"once the sequence crosses 999 999, `OrderNumber.fromSequence` widens to seven digits"*. That is false. `BusinessReference.format()` (`packages/shared-kernel/src/domain/business-reference.ts:56-63`) throws when the zero-padded string is not exactly 6 characters, and `parse()` rejects a 7-digit value too. Verified directly:

```
999999  => ORD-999999
1000000 => THROWS InvalidBusinessReferenceError: "1000000" is not a valid ORD-###### business reference
of(ORD-1000000) => THROWS "ORD-1000000" is not a valid ORD-###### business reference
```

So no reference the domain can produce is ever anything but 6 fixed digits, and for equal-width zero-padded decimals lexical order *is* numeric order. **The lexical-MAX bug is unreachable through the domain**: it needs a legacy row, a manual `UPDATE`, or a future width change to bite. The fix is correct defence-in-depth and worth keeping — the implementer kept it while saying plainly that it does not close a live bug — but pass 1's severity framing overstated the blast radius. **The implementer's correction stands; mine does not.**

Separate observation raised by that check, belonging to nobody yet: **the domain has a hard ceiling of 999 999 orders per reference type, enforced by a throw.** That is a deliberate shape (`domain-model.md` §2.3), not a defect, but no feature currently owns what happens at the ceiling.

## 7. D7, D8 — recorded reasoning judged

**D7 (design note).** Landed above `unitOfWork.execute(...)` in `place-order.handler.ts`, dated 2026-08-21, stating the lock scope, why allocation must stay inside the transaction, the resulting serialisation, and that feature 16 and any load-testing feature should treat it as known. That is what was asked for; the ruling ("gap-free is correct here") is unchanged.

**D8 (`TimeoutNegativeWarning`).** I read the cited upstream source rather than trusting the citation. `node_modules/.pnpm/kafkajs@2.2.4/.../requestQueue/index.js:306-321`:

```js
let scheduleAt = this.throttledUntil - Date.now()
if (!this.throttleCheckTimeoutId) {
  if (this.pending.length > 0) {
    scheduleAt = scheduleAt > 0 ? scheduleAt : CHECK_PENDING_REQUESTS_INTERVAL
  }
  this.throttleCheckTimeoutId = setTimeout(..., scheduleAt)
}
```

The clamp is inside `if (this.pending.length > 0)`. With an empty pending queue and the never-throttled default `throttledUntil = 0`, `scheduleAt` is exactly `-Date.now()` — and the observed value, `-1787293684517`, is current epoch milliseconds to the digit. Node clamps a negative delay to 1 ms, so nothing is scheduled early or dropped. **The diagnosis is correct and specific, not a convenient dismissal**; leaving a vendored dependency unpatched over a cosmetic log line is the right call, and the dated comment in `create-kafka-client.ts` means it will not be re-litigated.

## 8. Part 2 — the DI-metadata fix

**Verified real, on real code.** I stripped the `@Inject(PlaceOrderHandler)` from the actual `OrdersCreateController` constructor and compiled the same source both ways:

```
NEW dev path compiler (tsc, what tsc-watch runs):  design:paramtypes = [ 'PlaceOrderHandler' ]
OLD dev path compiler (tsx / esbuild):             design:paramtypes = undefined
```

Bare-type constructor injection resolves under the new `dev` path and would have resolved to `undefined` under the old one. Restored byte-exact. The implementer's `di-metadata-divergence.spec.ts` proves the same thing with two real child processes and is non-vacuous.

**All six services actually changed.** `apps/{orders,fulfillment,billing,gateway,notifications,projector}/package.json` all run `dotenv -e ../../.env -- tsc-watch --noClear -p tsconfig.build.json --onSuccess "node dist/main.js"`; all six carry the `tsc-watch` catalog devDependency and have the binary linked. I did not stop at reading the scripts — **I started all six**, and each one compiles and boots:

```
[orders] listening on port 3002 (HTTP) and NATS (nats://localhost:4222)
[gateway] listening on port 3001        [fulfillment] listening on port 3003
[billing] listening on port 3004        [notifications] listening on port 3005
[projector] listening on port 3006
```

`apps/web` (Nuxt) and `apps/seed` (no DI container) correctly untouched.

**ESLint guard armed with my own deliberate violations** — two of them, neither the implementer's:

1. Stripped `@Inject(OUTBOX_RELAY_CONFIG)` from the **real** `OutboxRelayService` (a feature-14 file, a different site from the one the implementer used) → `error … no-restricted-syntax` at `outbox-relay.service.ts:32:5`.
2. Wrote a throwaway class in the **feature-16 shape** — `@CommandHandler(PlaceThing)` with `constructor(private readonly dep: Dep) {}` → flagged at `10:15`. This is the case that actually matters, and the selector catches it.

Both restored/deleted; `pnpm lint` back to 0 problems.

**Ruling on `tsc-watch` vs SWC: sound choice, keep it.** Measured, not assumed (median of two runs each, same machine, same conditions):

| | `tsc-watch` (new) | `tsx watch` (old) |
|---|---|---|
| Cold `dev` start → listening | **7.0 s** | 2.0 s |
| Edit → recompiled + restarted | **1.8 s** | 2.1 s |
| Behaviour on a type error | keeps the last good build running, prints `error TS2322`, **does not restart** | restarts anyway with the error in place |

The whole cost is **≈5 s once per dev session**. Watch latency — the number a developer actually feels, dozens of times an hour — is *unchanged, marginally better*, because `tsc --watch` keeps the program in memory and rebuilds incrementally. The `pnpm dev:*` experience is otherwise identical (same command, same restart-on-save loop), with one real change: a type error now blocks the restart instead of shipping into the running process. I judge that an improvement, not a regression — it is the same feedback `pnpm typecheck` gives, moved into the loop — but it *is* a behaviour change and is correctly written into `CLAUDE.md`. SWC would buy back the 5 s at the cost of adding a *third* compiler to the repo whose `decoratorMetadata` is a re-implementation of `tsc`'s, i.e. a parity approximation — precisely the class of "dev compiles differently from prod" divergence this fix exists to eliminate. Paying 5 s a session for exact compiler identity is the right trade at five more services. **Do not revisit for SWC.** If the cold start ever grates, the cheap win is `"incremental": true` + a `tsBuildInfoFile`, not a different compiler.

## 9. The `packages/contracts` flake — confirmed, and it is a different test

**Confirmed: a different test from the one phase 6 fixed.** The two 30 s timeouts sit on the CLI specs (`check.spec.ts:72-82` region — *exits 0 and prints OK against the real committed files*, which genuinely takes **6.7 s** because it spawns `tsx scripts/check.mts`). The flaky one the implementer hit is `check.spec.ts:22` › *reports ok against the real, up-to-date committed directory*, which is still on Vitest's **default 5 s** and calls `checkGenerated` in-process. Measured unloaded: **683 ms** — so it needs roughly a 7× slowdown to trip, which `pnpm quality` (five packages testing in parallel) can produce on a loaded machine. It passed in all four of my runs, including inside a full `pnpm quality`.

**Ruling: it can wait, but it should not wait long, and it is not this feature's.** Nothing in `orders_acceptance` touches `packages/contracts`. It is a one-line fix (`testTimeout: 30_000` in `packages/contracts/vitest.config.mts`, which is the right shape — the whole file spawns or regenerates) and belongs to a `test_maintainer` pass folded into the next change that touches contracts. Recorded as N5 so it is not rediscovered a third time.

## 10. Features 13 / 14 — no regression

- **Outbox / parity guards green:** `apps/seed` 103 unit incl. `outbox-parity.spec.ts` › *defines outbox and processed_events identically in the three committed migration sets* (OI11); `idempotent-consumer.parity.spec.ts` (OI12) green in the orders suite. Feature 15's new migration `0003` did not disturb the three-database byte-identity.
- **Relay:** `outbox-relay.integration.spec.ts` green inside the 36-test integration run, including the publish-timeout bound that closed feature 14's own D1.
- **Domain purity:** no `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import anywhere under `apps/orders/src/domain` (direct grep), ESLint's restricted-imports block green, and `git status` shows **not one file under `src/domain/` touched** by this feature or its fix pass.
- **Coverage, build, quality, init:** all as tabulated in §1, unchanged or better.

## 11. Transport discipline, contract conformance, atomicity, timeouts, allocator

Unchanged from pass 1 and re-confirmed by the green integration suite: the only NATS verbs in production code remain one `@MessagePattern` and one `.request(`, the only publish path is outbox → relay → Kafka (`outbox-relay.ts:116`), and no production module imports anything under `test-support/`. Pass 1's P1–P5 probes are not re-run; nothing in this pass touched the code they exercised, and the mutation that guards each of them is still in place.

## 12. Defects open after this pass — 6, none blocking

### N1 — the new shutdown-hook spec is timing-fragile, and I saw it turn the gate red

**File:** `apps/orders/src/main-shutdown-hooks.spec.ts:77` (15 s child-exit cap) and `:109`/`:117` (20 s test timeouts).

On the **first** full unit run of this session — a cold Vitest cache, `transform 43.42s` — **both** tests failed with `probe … did not exit within the test timeout`, taking `pnpm --filter @otc/orders test` red. I then ran the full suite **seven** more times, including two more cold-cache runs and one cold-cache run under twelve saturating CPU loops: all green. In isolation the pair takes 14–22 s of test time, i.e. each probe sits at roughly half its own cap. **1 red run in 8.**

**Why it matters:** these two tests are new in this pass, and they are the only thing in the repo that spawns a real child process inside the *fast* gate. A gate that is red 12 % of the time on a cold cache trains people to re-run rather than read. The fix is a constant: raise the child cap to ~60 s and the test timeouts to ~90 s, or move these two process-spawning specs to `vitest.integration.config.mts` where seconds are already expected. Not blocking — the assertion is right, the proof is real, and 7 of 8 runs including adversarial ones are green — but fix it before it becomes background noise.

### N2 — the DI fix guards the symptom, not the two settings that cause it

**Files:** `apps/orders/src/di-metadata-divergence.spec.ts:57-84` reconstructs the compiler flags by hand (`--experimentalDecorators --emitDecoratorMetadata …`) instead of compiling with `-p tsconfig.build.json`.

Flip `emitDecoratorMetadata` to `false` in `tsconfig.base.json`, or revert one service's `dev` script to `tsx watch`, and **every test in the repository still passes** while the hazard is fully reopened. The spec proves *that the two compilers differ*, which will be true forever; it does not prove *that this repo is on the right one*. **Why it matters:** this is exactly the "accidental invariant broken by an unrelated tooling change" that `CLAUDE.md`'s own new bullet warns about. A pure-text spec — assert `tsconfig.base.json` sets `emitDecoratorMetadata: true`, and assert every `apps/*/package.json` with a `main.ts` has a `dev` script running `tsc-watch` — costs ten lines, needs no Docker, and is the same instrument as `OI11`/`OI12`.

### N3 — the ESLint guard's selector has one evasion, demonstrated

**File:** `eslint.config.mjs:45-48`. The selector matches `TSParameterProperty`, so a Nest-decorated class written as `constructor(dep: Dep) { this.dep = dep; }` — bare-typed, no accessibility modifier, assigned by hand — is **not** flagged. I confirmed it in the same probe run that fired the other two violations. **Why it matters:** it is not this codebase's style today, and `CLAUDE.md`'s prose covers it, but the guard exists precisely because prose is not checkable. Either widen the selector to plain `Identifier` parameters with a type annotation inside a decorated class's constructor, or record the limitation in the rule's own comment so the next reader does not over-trust it.

### N4 — the `test-support` build exclude landed in one service only

**Files:** `apps/{fulfillment,billing,gateway,notifications,projector}/tsconfig.build.json` still exclude only `src/**/*.spec.ts`. No defect today — none of the five has a `test-support/` directory — but D5's lesson is one line and five files, and features 17/21/23/25/26 each create the first one in their service.

### N5 — `packages/contracts` `check.spec.ts:22` on the default 5 s timeout (pre-existing, not this feature)

See §9. Baseline 683 ms, default 5 s, load-sensitive; a different test from the two the phase-6 `test_maintainer` pass fixed. Hand to `test_maintainer` with the next contracts-touching change.

### D4 (carry-over) — `progress/current.md` still contradicts `feature_list.json`

`progress/current.md:7` reads `**Status:** in_progress — REJECTED at review` while `feature_list.json` had the feature at `in_review`, and this review now sets it `done`. Third occurrence across features 13, 15 and 15-again — and `current.md` itself already carries a *"Leader lesson (D2, twice)"* note about this exact failure. It is the leader's file, so it is not the implementer's defect; it must be reset at session close along with the history entry.

## 13. CHECKPOINTS walked — second pass

### C1 — harness
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` present.
- [x] `progress/current.md` and `progress/history.md` present.
- [x] `.claude/agents/` holds all five agents, each declaring its model.
- [x] `./init.sh` exits 0 (re-run by me).

### C2 — state
- [x] At most one feature `in_progress` — 24 pending, 14 done, 1 `in_review` (this one, now `done`).
- [x] Every status is in `rules.valid_status`; new id 39 is `pending`, a valid status.
- [x] Every `done` feature has passing tests (`pnpm quality` exit 0, integration suite green).
- [ ] **`progress/current.md` in lockstep** — still `in_progress`/REJECTED. See D4 carry-over.
- [x] No `blocked` features.

### C3 — architecture
- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats`, `mongodb` import in any `domain/` folder — direct grep plus green ESLint; no `src/domain/` file touched by this feature at all.
- [x] No cross-service database access; no FK across a boundary.
- [x] No new shared runtime code. The one new dependency (`tsc-watch`) is a per-app devDependency via the catalog.
- [x] `packages/shared-kernel` still dependency-free.
- [x] Every interaction classifiable Kafka-fact vs NATS-RPC — pass 1 §2, re-confirmed by grep.
- [x] No stray debug logging, no context-free TODOs.

### C4 — verification
- [x] `pnpm quality` passes (run by me).
- [x] Domain tests pure.
- [x] Integration tests use Testcontainers against real MySQL / Kafka / NATS.
- [x] Coverage: domain 98.5 % (≥80 %), overall 90.93 % (≥60 %).
- [x] No Jest anywhere.
- [x] **Tests would fail if the behaviour regressed** — the box that failed pass 1. M3 killed at two levels, two further money mutations killed, the D6 fix killed by reverting it, the ESLint guard fired on two violations of mine, and pass 1's four mutations remain covered. **This box now passes.**

### C5 — session close
- [x] No suspicious untracked files; `dist/` carries no test double (D5 closed). Every probe of mine deleted, 382-file md5 baseline clean, `git status` back to 53 entries.
- [x] `progress/history.md` entry with effort record — appended by this review.
- [x] `feature_list.json` reflects true state — set to `done` by this review.
- [ ] The human has been told what was done and how to test manually — the leader reports next.
- [x] **Claude did not commit.** No `git commit` or `git push` at any point in either review pass.

### C6 — SDD
Not applicable: `orders_acceptance` is `"sdd": false`. Correctly no `specs/orders_acceptance/`. Note that the deferred work it spawned, id 39 `orders_idempotent_replay`, **is** `sdd: true` and will need the full triple-doc plus the human gate.

### C7 — trilogy reusability
- [x] `specs/shared/` untouched by this feature and by its fix pass — verified in `git status`. `asyncapi.yaml`'s normative `requestId` sentence deliberately left standing as the target contract for #8 and #9.
- [x] `n8n/workflows/` untouched.
- [x] `progress/history.md` effort records complete — this feature's is appended below with the two-pass record.

## 14. Traceability — unchanged and still accurate

No `R<n>` row in `specs/shared/test-matrix.md` is newly proven or flipped by this pass; `R6`/`R13` were already `DONE` and are now *better* covered (the money-field fixtures strengthen R6's totals computation; the atomicity assertions are untouched), and `R31` correctly remains `TODO` for feature 17's responder side. The three acceptance items map to the tests tabulated in pass 1 §10, all re-run green, with the happy-path item now additionally asserting `currency` and all three money fields over the real wire.

## 15. What the leader must do at close

1. Reset `progress/current.md` (D4) — it is the only piece of state still telling a fresh session the wrong thing.
2. Brief feature 16 on two things it inherits: the counter-row serialisation design note (D7) and the `@Inject(TOKEN)` convention now backed by lint (Part 2) — the saga is the first `@nestjs/cqrs` graph and the exact place the DI hazard would have recurred.
3. Schedule N1 (one constant) and N2 (ten lines) into the next `test_maintainer` pass; N5 with the next contracts-touching change.
