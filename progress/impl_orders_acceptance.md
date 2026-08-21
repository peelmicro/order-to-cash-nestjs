# Implementation report — `orders_acceptance` (id 15, phase 8)

> `sdd: false` — worked from `feature_list.json`'s `acceptance` list. This
> revision is the **fix pass** after `progress/review_orders_acceptance.md`
> rejected the feature (1 blocking defect, 7 non-blocking), plus a
> cross-cutting DI-metadata divergence the leader folded into this pass.
> The original "What was built" narrative is preserved below (§1); this
> report leads with what the review caught and why, per the review's
> defect numbering (D1–D8), then the DI-metadata fix (Part 2).

## 0. What the review caught, and why the first pass missed it

The rejection was narrow: the architecture, transaction boundary,
concurrency behaviour and timeout handling all held up under the
reviewer's own hostile probes. What failed was **test-coverage
vacuousness**, not a code bug — `orders-create.controller.ts` already
mapped `totalAmount: result.totalAmount` correctly; the defect was that
**no fixture anywhere used a non-zero `initialDiscount`**, so a mutation
that silently substituted `initialAmount` for `totalAmount` (a real,
plausible, money-affecting bug class) left all 206 unit + 3 acceptance
integration tests green. This is the kind of gap that is easy to miss
when writing tests alongside the implementation, because the "happy path"
fixture (no discount) is the simplest one to reach for — every money
field collapses to the same number, so the assertions LOOK complete
without actually being discriminating. The fix is not a smarter
assertion, it is a fixture that makes the three money fields **provably
distinct values**.

## 1. What was built (original implementation, unchanged by this pass)

### 1. NATS transport (hybrid app)

- `apps/orders/src/main.ts` — `app.connectMicroservice({ transport: Transport.NATS, ... })` alongside the existing HTTP `listen()`. NATS core only (no JetStream), servers from `NATS_URL`.
- `apps/orders/src/infrastructure/messaging/nats.config.ts` — `loadNatsConfig` / `loadStockCheckTimeoutMs`.

### 2. `orders.create` handler

- `apps/orders/src/presentation/dto/orders-create.dto.ts` — `OrdersCreateRequestDto` (`implements OrdersCreateRequestPayload` from `@otc/contracts`), `class-validator` decorators.
- `apps/orders/src/presentation/orders-create.controller.ts` — `@MessagePattern('orders.create')`. Never throws: `success`/`error` are two payload shapes on the same reply address.
- `apps/orders/src/presentation/rpc-error-mapper.ts` — pure function, every application/domain error → `RpcError.code`.

### 3. Stock-check RPC client

- `apps/orders/src/application/ports/stock-availability.port.ts` — `StockAvailabilityPort` + `StockCheckTimeoutError`/`StockCheckTransportError`.
- `apps/orders/src/infrastructure/messaging/nats-stock-availability.adapter.ts` — plain `nats` client, explicit per-call `request(subject, data, { timeout })`.

### 4. Place-order command handler

- `apps/orders/src/application/place-order.handler.ts` — resolves reference data, calls the stock check **before opening any transaction**, and on success runs `OrderNumberAllocator.next(tx)` + `Order.place(...)` + `OrderRepository.save(order, tx)` inside one `UnitOfWork.execute(...)`.
- `apps/orders/src/application/ports/order-reference-data.port.ts` + `apps/orders/src/infrastructure/persistence/order-reference-data.repository.ts`.
- `apps/orders/src/application/place-order.errors.ts` — `ReferenceDataNotFoundError`, `StockUnavailableError`, `OrderDiscountNotSupportedError`.

### 5. Order-number allocation

- `apps/orders/src/infrastructure/persistence/schema/order-number-sequences.schema.ts` + migration `apps/orders/drizzle/0003_smooth_machine_man.sql` — a single-row counter table.
- `apps/orders/src/infrastructure/persistence/order-number-allocator.ts` — `DrizzleOrderNumberAllocator`, `SELECT ... FOR UPDATE` inside the placing transaction, self-initialising from the existing `orders` table.

## 2. Defects fixed (review_orders_acceptance.md §13)

### D1 (BLOCKING) — reply money mapping vacuously covered

**Fixed by adding coverage that distinguishes `initialAmount`/`initialDiscount`/`totalAmount` with a non-zero discount, at all three levels:**

- `apps/orders/src/presentation/orders-create.controller.spec.ts` — new test *maps initialAmount, initialDiscount and totalAmount onto DISTINCT reply fields when the order carries a discount* (fixture: `2_000 / 300 / 1_700`, asserts `totalAmount !== initialAmount`).
- `apps/orders/src/application/place-order.handler.spec.ts` — new test *computes initialAmount, initialDiscount and totalAmount as distinct values when a line carries a discount* (a real line with `lineDiscount: 300`, quantity 2 @ 1000 → `2000/300/1700`).
- `apps/orders/src/orders-acceptance.integration.spec.ts` — the happy-path test now sends a line with `lineDiscount: 300` and asserts all four money fields (`currency`, `initialAmount`, `initialDiscount`, `totalAmount`) over the REAL NATS wire against REAL MySQL.

**Mutation M3 re-run and confirmed KILLED.** Applied the reviewer's exact edit (`totalAmount: result.initialAmount` at `orders-create.controller.ts:54`), ran `pnpm --filter @otc/orders test`: the new controller test fails with `expected 2000, received 1700` (i.e. the mutant is caught). Restored the file byte-exact (`git diff` empty afterwards) and re-ran — 208/208 unit tests green (206 original + 2 new: the controller test above plus the handler test above; the third new assertion lives inside an *existing* integration test, not a new one, so the integration count is 36 including the D6 test below, not +1 for D1).

### D2 — `NatsConnectionCloser` provably dead / relay drain inert

**Fixed:** `apps/orders/src/main.ts` now calls `app.enableShutdownHooks()` before `connectMicroservice`, re-arming both `NatsConnectionCloser.onApplicationShutdown` (`app.module.ts`) and `OutboxRelayService.onApplicationShutdown` (feature 14).

**Proved with two real child processes, not a mocked lifecycle:**

- `apps/orders/src/test-support/shutdown-probe-with-hooks.ts` / `shutdown-probe-without-hooks.ts` — two minimal, otherwise-identical Nest apps (a provider implementing `OnApplicationShutdown`), one calling `enableShutdownHooks()` (the fixed shape), one not (the old shape). Both write to a file (not stdout — `appendFileSync`, synchronous, so nothing is lost to the process's own signal-triggered exit racing an async pipe flush; see the file header for the debugging story).
- `apps/orders/src/main-shutdown-hooks.spec.ts` — spawns each probe as a **real** child process via `tsx`, waits for its readiness marker, sends a genuine `SIGTERM`, and asserts on the resulting log file: the WITH-hooks probe logs `SHUTDOWN_HOOK_FIRED:SIGTERM`; the WITHOUT-hooks probe does not. A fixed 300ms settle delay between "ready" and the signal is deliberate and documented in the spec — reproduced directly that sending SIGTERM in the very same tick the readiness marker appears races `tsx`'s own `sh`→`node` exec/bootstrap sequence on a loaded machine (~40% silent-drop rate without the delay, 15/15 clean with it), a timing hazard in the PROBE HARNESS, not in `main.ts`'s own fix.
- **Live check** (§5 below): sent a real `SIGTERM` to the actual compiled `orders` service (`pnpm start`) running against the compose stack — the process terminated cleanly with no crash and no leftover handle.

### D3 — `requestId` idempotent replay

**Decision: scoped out, tracked.** Added `feature_list.json` id **39**, `orders_idempotent_replay` (`sdd: true`, `pending`), with acceptance criteria matching `asyncapi.yaml`'s normative claim (repeat `requestId` → original order; concurrent duplicates never double-place; `requestId` stays optional). Not folded into this defect-fix pass because it needs a persisted `request_id` column/lookup and a decision on the concurrent-first-request race — a schema-affecting, feature-sized change, not a local bug fix. `place-order.handler.ts`'s `PlaceOrderCommand.requestId` docstring now points at feature 39 instead of a progress-file paragraph, so the gap is trackable from the code, not just documented in prose. `specs/shared/asyncapi.yaml` is left untouched — it is the target contract for all three trilogy stacks, none of which implement this yet, and the gap is now tracked where the state machine actually lives (`feature_list.json`), not silently claimed anywhere in code (nothing in `place-order.handler.ts` or the DTO claims replay works).

### D4 — `progress/current.md` lockstep

Already fixed by the leader before this pass started, per the task brief — not touched.

### D5 — test double compiled into the shippable build

**Fixed, one line:** `apps/orders/tsconfig.build.json` now excludes `src/**/test-support/**` in addition to `src/**/*.spec.ts`.

**Proved:** `rm -rf apps/orders/dist && pnpm --filter @otc/orders build` then `find apps/orders/dist -iname "*test-support*"` → no matches. `dist/` now contains only `application/`, `domain/`, `infrastructure/`, `presentation/`, `app.module.js`, `main.js` (and `.map` files) — no `stub-stock-check-responder.js`, no `nats-test-fixture.js`, and (new in this pass) no `di-metadata-probe.js` or `shutdown-probe-*.js` either, since all new test-only probes also live under `test-support/`.

### D6 — allocator's self-initialisation uses a lexical MAX

**Fixed:** `order-number-allocator.ts`'s `next()` now computes `max(cast(substring(order_reference, 5) as unsigned))` instead of a plain `max(order_reference)` — a genuine numeric max regardless of digit width.

**Investigation note (important for accuracy):** the reviewer's stated mechanism — *"once the sequence crosses 999999, `OrderNumber.fromSequence` widens to seven digits"* — does **not** match the actual `packages/shared-kernel/src/domain/business-reference.ts` code. `BusinessReference.format()` hard-**refuses** to produce anything other than exactly 6 digits (`padded.length !== SEQUENCE_WIDTH` throws `InvalidBusinessReferenceError`); it never widens. Verified directly: `OrderNumber.fromSequence(1_000_000)` throws. So the lexical-vs-numeric MAX defect can never be reached by any reference the domain itself produces — every `OrderNumber` is always fixed 6-digit zero-padded, and for equal-width zero-padded decimal strings lexical order IS numeric order. The fix is still correct and worth keeping (belt-and-braces against a legacy row, a manual DB fix, or a future width change), but it closes a **theoretical/defence-in-depth** gap, not a reachable-today one — the review's own severity framing overstated the current blast radius. Recorded here so the fix isn't miscredited with closing a live bug it does not currently prevent.

**Proved (`order-number-allocator.integration.spec.ts`, new test):** places two real orders via the domain path (so all FKs are valid), then raw-`UPDATE`s their `order_reference` columns to `'ORD-999999'` and `'ORD-1000000'` (the only way to get an out-of-domain-range value into the table at all). Confirms `max(order_reference)` (lexical) resolves to `'ORD-999999'` while `max(cast(substring(...) as unsigned))` (numeric) resolves to `1_000_000` — the two genuinely disagree, proving the trap is real. Then drives the actual `DrizzleOrderNumberAllocator.next()` over this exact scenario: it throws `InvalidBusinessReferenceError` containing `"1000001"` (the NUMERICALLY correct next value — one past the domain's own ceiling, hence the throw — not `"1000000"`, which is what the buggy lexical query would have computed). 36/36 integration tests pass (35 baseline + 1 new).

### D7 — counter row serialises the placing transaction

**Judged: keep as designed, recorded as an explicit, dated design note** — the reviewer's own ruling ("gap-free is the correct contract here") is endorsed; the trade needed to be written down, not fixed. Added to `place-order.handler.ts` immediately above `this.unitOfWork.execute(...)`, dated 2026-08-21, explaining the lock scope, why allocation must live inside the transaction (rollback returns rather than burns the number), the resulting serialisation, and that feature 16 / any load-testing feature should treat this as known.

### D8 — `TimeoutNegativeWarning` (observation → investigated, root-caused)

**Investigated per the task's explicit instruction not to dismiss it.** Traced to `kafkajs@2.2.4`'s `RequestQueue.scheduleCheckPendingRequests()` (`node_modules/kafkajs/src/network/requestQueue/index.js:312`): `scheduleAt = this.throttledUntil - Date.now()` is only clamped to a safe positive fallback when `this.pending.length > 0`; called with an empty pending queue and the never-yet-throttled default `throttledUntil = 0`, `scheduleAt` stays `0 - Date.now()` — the exact sign/magnitude of the observed warning (`-1787...`, matching current epoch ms). Node clamps a negative `setTimeout` duration to 1ms itself, so this is cosmetic, not a functional bug — no request is scheduled early or dropped. `kafkajs@2.2.4` is the latest stable release (2.3.0 is beta-only), so there is no drop-in upstream fix. **Not fixed** (patching a vendored dependency from here is out of scope and riskier than the cosmetic warning it would silence); recorded as a dated comment in `create-kafka-client.ts` so it is never mistaken for a regression again, and reproduced again in this pass's full integration run (still present, still harmless, still traced to the same origin).

## 3. Part 2 — DI-metadata divergence (cross-cutting, leader-directed)

**1. Closed at source.** All six services' `dev` script (`apps/{orders,fulfillment,billing,gateway,notifications,projector}/package.json`) moved from `tsx watch src/main.ts` to:

```
dotenv -e ../../.env -- tsc-watch --noClear -p tsconfig.build.json --onSuccess "node dist/main.js"
```

`tsc-watch` (new catalog devDependency, `pnpm-workspace.yaml`) runs the exact same `tsc` compiler `pnpm build` uses, in watch mode, restarting `node dist/main.js` on every successful recompilation — so `pnpm dev:*` and `pnpm build`/`pnpm start` compile with the identical compiler and can no longer disagree on `emitDecoratorMetadata`. `apps/web` (Nuxt/Vite) and `apps/seed` (plain `tsx`, no DI container) are untouched.

**Proved, not asserted:**

- `apps/orders/src/test-support/di-metadata-probe.ts` — a class with **bare-type constructor injection** (no `@Inject`), the `@nestjs/cqrs` idiom feature 16 will use.
- `apps/orders/src/di-metadata-divergence.spec.ts` — runs the SAME probe source through two real compilations: `tsx` (the OLD dev script's compiler) → `DI_RESULT:DEPENDENCY_UNDEFINED`; `tsc` with `emitDecoratorMetadata`/`experimentalDecorators` (the compiler the FIXED `tsc-watch` runs under the hood) → `DI_RESULT:DEPENDENCY_RESOLVED`. Both reproduced live via `execFileSync` in the test.
- Manually verified `tsc-watch` itself end-to-end too (not re-asserted in the spec — a full-project watch build is too slow for the fast `pnpm test` gate): `tsc-watch -p tsconfig.json --onSuccess "node ... di-metadata-probe.js"` prints the same `DI_RESULT:DEPENDENCY_RESOLVED` line.

**2. `CLAUDE.md` updated** — a new Non-negotiables bullet ("Explicit DI tokens, always") stating the rule and the reason (metadata-dependent DI resolution is compiler-dependent, and a dev-only compiler mismatch makes it fail silently), plus an Environment notes line explaining why `dev` now runs `tsc-watch` instead of `tsx watch`.

**3. ESLint guard added.** `eslint.config.mjs` — a `no-restricted-syntax` rule (same "zero extra dependencies" instrument the domain-purity rule already uses, per the task's own suggestion) matching a `TSParameterProperty` with no `@Inject(...)` decorator inside the constructor of a class carrying `@Injectable`/`@Controller`/`@Catch`/`@CommandHandler`/`@EventsHandler`/`@QueryHandler`/`@Resolver`. Scoped to `apps/*/src/**`, excluding `**/test-support/**` and `*.spec.ts` (the two DI-divergence probes deliberately reproduce the violation on purpose, as the very thing this rule exists to prevent in production code).

**Demonstrated failing then passing**, exactly as required: temporarily stripped `@Inject(PlaceOrderHandler)` from `orders-create.controller.ts`'s real constructor — `pnpm lint` failed with `no-restricted-syntax: Bare-type constructor injection on a Nest-decorated class is forbidden here...` at the exact line. Restored the file byte-exact (`git diff` empty afterwards) — `pnpm lint` clean again (0 problems).

## 4. R → test mapping

No `R<n>` row in `specs/shared/test-matrix.md` was newly proven or flipped by this pass — the reviewer's traceability finding still holds (R6/R13 already `DONE`, R31 correctly `TODO` pending feature 17). The defect-fix tests below strengthen coverage of already-`DONE` rows (R6's totals computation, R13's transaction atomicity) rather than proving new ones.

| Fix | Test |
|---|---|
| D1 — money field mapping | `orders-create.controller.spec.ts` › *maps initialAmount, initialDiscount and totalAmount onto DISTINCT reply fields...*; `place-order.handler.spec.ts` › *computes initialAmount, initialDiscount and totalAmount as distinct values...*; `orders-acceptance.integration.spec.ts` › happy-path test (extended) |
| D2 — shutdown hooks | `main-shutdown-hooks.spec.ts` › both tests (fires WITH hooks, does not fire WITHOUT) |
| D5 — build artefact | Build + `find`, no automated test (a build-output assertion, documented above) |
| D6 — numeric allocator MAX | `order-number-allocator.integration.spec.ts` › *computes the numerically-correct MAX(order_reference), not the lexical one, across a digit-width crossing* |
| DI-metadata divergence | `di-metadata-divergence.spec.ts` › both tests (tsx fails, tsc resolves) |

## 5. Verification (real output)

**Unit.** `pnpm --filter @otc/orders test` → **212 passed (19 files)** (206 baseline + 2 D1 tests + 2 D2 shutdown-hook tests + 2 DI-metadata tests). 208/208 with just the D1 additions when isolated during the mutation re-run (see D1 above).

**Integration.** `pnpm --filter @otc/orders test:integration` → **36 passed (11 files)** (35 baseline + 1 D6 test). The `TimeoutNegativeWarning` (D8) still appears, root-caused, unrelated to this feature's code.

**M3 mutation re-run and killed** (see D1).

**Monorepo.** `pnpm quality` (lint + typecheck + test, all packages) → **exit 0**. `pnpm build` → **exit 0**; `apps/orders/dist` contains no `test-support/` output. `./init.sh` → **exit 0**.

**ESLint guard** — shown failing on a deliberate violation of the real `orders-create.controller.ts`, then passing after restoration (see Part 2).

**DI-metadata fix** — `tsx` shown resolving bare-type injection to `undefined`; `tsc`-compiled output (matching `tsc-watch`'s compiler) shown resolving it correctly (see Part 2).

**Live round trip against the compose stack** (infra already running: `mysql:8.4.11`, `apache/kafka:4.3.1`, `nats:2.14.5-alpine`, etc.):

```
$ pnpm --filter @otc/orders db:migrate
[orders] migrations applied against localhost:3306/otc_orders

$ pnpm --filter @otc/orders start
[Nest] ... Nest microservice successfully started
[Nest] ... Nest application successfully started
[orders] listening on port 3002 (HTTP) and NATS (nats://localhost:4222)
```

A real `orders.create` request over `@nestjs/microservices`' `ClientProxyFactory` (Transport.NATS) against the live compose NATS, with a stub `fulfillment.stock.check` responder (feature 17 still not built) and, deliberately, a **non-zero `lineDiscount`** to re-prove D1 over the real wire:

```json
{
  "orderId": "c888ff0e-bb9f-4393-89c3-f8723f7364b7",
  "orderReference": "ORD-000009",
  "status": "placed",
  "currency": "EUR",
  "initialAmount": 49998,
  "initialDiscount": 300,
  "totalAmount": 49698,
  "orderDate": "2026-08-21T06:07:17.895Z"
}
```

SQL, same database — the order row and its `order.placed.v1` outbox record exist together, and the running relay published it:

```
mysql> SELECT id, order_reference, status, initial_amount, initial_discount, total_amount FROM orders WHERE order_reference='ORD-000009';
id                                    order_reference  status  initial_amount  initial_discount  total_amount
c888ff0e-bb9f-4393-89c3-f8723f7364b7  ORD-000009       placed  49998           300               49698

mysql> SELECT event_type, aggregate_id, published_at FROM outbox WHERE aggregate_id='c888ff0e-...';
event_type       aggregate_id   published_at
order.placed.v1  c888ff0e-...   2026-08-21 06:07:18
```

**D2 confirmed live too:** sent a real `SIGTERM` (`kill -TERM <pid>`) to the running compiled service — the process terminated cleanly (no crash, no leftover `node`/`dotenv-cli` process afterwards), consistent with `main-shutdown-hooks.spec.ts`'s more granular, repeatable proof.

The order row this left in the dev database (`ORD-000009`) is an artifact of the live check, same as the previous pass's `ORD-000007` — a `docker compose down -v` → migrate → seed cycle clears it, the project's established convention. The temporary verification script (`apps/orders/scripts/tmp-live-check.ts`) was deleted after use; `git status` shows nothing left behind from the live check.

**A pre-existing, unrelated flake noted for the record:** `pnpm quality`'s root `pnpm test` run occasionally hits `packages/contracts`' `scripts/check.spec.ts` › *reports ok against the real, up-to-date committed directory*, a test with a 5000ms default Vitest timeout that this sandboxed machine's I/O load sometimes exceeds (observed both a fail and a pass across two back-to-back runs, no code involved was touched by this feature). Not investigated further — out of scope for `orders_acceptance`, and `pnpm quality`'s own successful run (§ above) shows it passing.

## 6. Files touched (this pass, on top of §1's original set)

New: `apps/orders/src/{main-shutdown-hooks.spec.ts,di-metadata-divergence.spec.ts,test-support/{shutdown-probe-with-hooks.ts,shutdown-probe-without-hooks.ts,di-metadata-probe.ts}}`.

Modified: `apps/orders/src/{main.ts (enableShutdownHooks), presentation/orders-create.controller.spec.ts (D1 test), application/place-order.handler.ts (D1 test + D3 docstring + D7 design note), application/place-order.handler.spec.ts (D1 test), orders-acceptance.integration.spec.ts (D1 assertions), infrastructure/persistence/order-number-allocator.ts (D6 numeric MAX), infrastructure/persistence/order-number-allocator.integration.spec.ts (D6 test), infrastructure/outbox/create-kafka-client.ts (D8 comment)}`, `apps/orders/tsconfig.build.json` (D5), `apps/{orders,fulfillment,billing,gateway,notifications,projector}/package.json` (dev script), `pnpm-workspace.yaml` (tsc-watch catalog entry), `eslint.config.mjs` (DI guard), `CLAUDE.md` (DI convention), `feature_list.json` (new id 39 `orders_idempotent_replay`; this feature → `in_review`).

## 7. What could not be done / left for later

- `requestId` idempotent replay — tracked as feature 39, not implemented here (D3, schema-affecting).
- D8's `TimeoutNegativeWarning` — traced to an upstream `kafkajs@2.2.4` bug, not patched (no stable fix available, cosmetic only).
- Everything else from the original implementation report's "What could not be done" section (W3C trace propagation, the reference-data-resolution TOCTOU window) is unchanged and still out of scope.

## 8. Anything that surprised me

- The **race condition inside my own D2 test harness**, not in the fix: sending `SIGTERM` in the same tick a child process reports itself ready silently dropped the signal listener's effect about 40% of the time, even though the listener is registered synchronously at module load, long before the race window. Traced to `tsx`'s launcher shim (`sh` → `exec node`) and the process's own bootstrap settling — a fixed, documented 300ms delay between "ready" and "signal" made it 15/15 reliable. Worth remembering for any future test that spawns a real process and signals it quickly.
- **The reviewer's own D6 root-cause was itself slightly wrong** (see §D6 above) — `OrderNumber.fromSequence` refuses to widen past 6 digits rather than "widening to seven digits" as stated. The fix is still correct and worth keeping, but it defends against a scenario the domain object cannot currently produce on its own. Reviewing the reviewer's reasoning, not just its conclusion, is what caught this — it changes the fix's practical urgency (defence-in-depth, not "live bug"), even though the recommended code change was right either way.
