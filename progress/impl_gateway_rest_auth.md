# `gateway_rest_auth` — implementation notes

Feature 25, phase 13. `sdd: false` — spec is `specs/shared/openapi.yaml` directly.

## Groups completed

**A — Foundation.** JWT auth (`POST /auth/login`, `GET /auth/me`, `JwtAuthGuard` as a
global `APP_GUARD` with a `@Public()` opt-out), the NATS RPC client
(`NatsRpcClientAdapter`) with per-call timeout and typed errors
(`RpcTimeoutError`/`RpcTransportError`/`RpcBusinessError`) mapped to HTTP status codes
(`domain/problem/rpc-error-mapping.ts`), the RFC 9457 `application/problem+json`
error shape (`ProblemJsonExceptionFilter`, a global `APP_FILTER`), `GET /health/live`,
`GET /health/ready` (readiness checks MongoDB + NATS, R60), Swagger UI at `/docs`
(raw `swagger-ui-express` middleware serving `specs/shared/openapi.yaml` itself —
never regenerated from decorators).

**B — Read endpoints, from MongoDB only (R54).** `GET /orders`, `GET /orders/{id}`
read a **direct, read-only** MongoDB connection onto the projector's own
`order_timeline` collection (`MongoOrderReadModelAdapter`) — no RPC hop, no write
database anywhere. `GET /invoices`, `GET /stock`, `GET /credits`, `GET /catalog/*`
are RPC list queries per the contract's own words ("a live read of the Fulfillment
write model, not the read model"). **[CORRECTED IN ROUND 2 — see "Round 2" section
below]** R55's "projection pending" is a `202` body for an id THIS gateway recently
issued (`IssuedOrderWindow`, bounded/TTL'd) and a genuine `404` for everything else
— openapi.yaml's own documented `404` is reachable now. Original claim, kept struck
through rather than deleted: ~~R55's "projection pending" is an explicit `202`
body, never a `404`~~.

**C — Write endpoints over NATS RPC.** `POST /orders` → `orders.create`,
`POST /orders/{id}/cancel` → `orders.cancel`, `POST /stock/replenish` →
`fulfillment.stock.replenish`, `POST /invoices/{id}/payments` →
`billing.payment.register`, including the correlationId=orderId resolution (see
"Open points" below).

**D — `GET /orders/stream`.** Raw Express response (not Nest's `@Sse()` — see "Open
points"), fed by `StreamHub` (bounded replay buffer + RxJS fan-out), itself fed by
`NatsStreamSignalAdapter` subscribing to `readmodel.order.updated.*` /
`readmodel.timeline.appended.*` (the exact subjects `apps/projector`'s own
`nats-update-signal.publisher.ts` writes to). `stream.ready`, `Last-Event-ID` resume
from the buffer with `resumed:false` on an aged-out/unknown/absent cursor, `ping`
keep-alive, exact `Cache-Control: no-cache` / `Connection: keep-alive` headers.

**E — The contract test.** `contract-drift.integration.spec.ts` introspects the
**live, booted** Nest app's Express router (`extractExpressRoutes`, walking
`app.getHttpAdapter().getInstance().router.stack`) and compares the resulting
`{method, path}` set against `specs/shared/openapi.yaml`'s own paths (parsed with
`js-yaml`, `extractOpenapiRoutes`) — both directions of drift fail the same
assertion. `GET /docs` (raw middleware, not a Nest route) is proved separately by an
actual HTTP request. See "Proof the contract test detects drift" below.

## Files (bounded scope: `apps/gateway/**`, `pnpm-workspace.yaml` catalog additions,
`specs/shared/test-matrix.md`)

- `apps/gateway/src/domain/` — `auth/operator-credentials.ts`,
  `problem/rpc-error-mapping.ts`, `projection/order-read-model-mapper.ts`,
  `sse/{cursor,replay-buffer}.ts` — all pure, unit-tested, zero framework imports.
- `apps/gateway/src/application/` — `ports/{clock,rpc-client,order-read-model,token,
  operator-identity,health-check}.port.ts`, `commands/{login,place-order,
  cancel-order,replenish-stock,register-payment}.command.ts`, `queries/
  {get-current-user,list-orders,get-order,list-stock,list-invoices,list-credits,
  list-catalog}.query.ts`, `stream-hub.ts`, `contracts-aliases.ts`.
- `apps/gateway/src/infrastructure/` — `auth/{jwt.config,jwt-token.adapter,
  operator.config}.ts`, `messaging/{nats-client,nats.config,nats-rpc-client.adapter,
  nats-stream-signal.adapter,sse.config}.ts`, `persistence/{mongo-client,mongo.config,
  mongo-order-read-model.adapter}.ts`, `health/{mongo-health-check,
  nats-health-check}.ts`, `system-clock.ts`.
- `apps/gateway/src/presentation/` — `auth.controller.ts`, `orders.controller.ts`,
  `stream.controller.ts`, `stock.controller.ts`, `invoices.controller.ts`,
  `credits.controller.ts`, `catalog.controller.ts`, `health.controller.ts`,
  `dto/*.ts`, `guards/{jwt-auth.guard,public.decorator}.ts`,
  `problem-json.filter.ts`, `pagination.ts`, `setup-docs.ts`, `validation-pipe.ts`,
  `sse-config.token.ts`.
- `apps/gateway/src/app.module.ts`, `main.ts` — full DI wiring; `presentation/
  app.controller.ts`/`.spec.ts` (the scaffold's undocumented root `GET /`) **deleted**
  — it was not one of openapi.yaml's 17 paths and would have failed the contract
  test the moment it existed.
- `apps/gateway/src/test-support/` — `nats-test-fixture.ts`, `mongo-test-fixture.ts`
  (the authenticated/standalone variant — `mongo.config.ts` always builds an
  authenticated connection URI), `stub-rpc-responder.ts` (generic TEST-ONLY NATS
  responder — Orders'/Fulfillment's/Billing's own responders do not run in this
  suite), `gateway-app-test-harness.ts`, `extract-express-routes.ts`,
  `openapi-routes.ts`, `fake-rpc-client.ts`, `fake-order-read-model.ts`.
- Five `*.integration.spec.ts` files (Testcontainers, real `nats:2.14.5-alpine` +
  `mongo:8.3.8`): `contract-drift`, `auth`, `orders`, `billing-fulfillment`, `stream`.
- `apps/gateway/vitest.integration.config.mts` (new); `vitest.config.mts` gained the
  `exclude: ['src/**/*.integration.spec.ts']` line every other service's own config
  already has (`pnpm test`'s default include glob `**/*.spec.ts` also matches
  `*.integration.spec.ts`, so without this exclusion the fast unit run tries to boot
  Testcontainers and blows its 10s hook timeout — found live, fixed).
- `apps/gateway/package.json` — new deps (see "Packages" below).
- `pnpm-workspace.yaml` — catalog additions: `jsonwebtoken`, `@types/jsonwebtoken`,
  `swagger-ui-express`, `@types/swagger-ui-express`, `js-yaml`, `@types/js-yaml`,
  `supertest`, `@types/supertest`, `@types/express`. Also fixed
  `allowBuilds['@scarf/scarf']` (pnpm auto-wrote a placeholder value during
  `pnpm install`; set to `false` — an anonymous install-telemetry script, not
  project-relevant).
- `specs/shared/test-matrix.md` — R54 (gateway half) flipped `TODO → DONE`; R55
  gateway half flipped to `DONE` (web half still owed to feature 26); R61 API half
  flipped `TODO (feature 25) → DONE`; coverage summary counts updated
  (`projector_read_model` 4→5, `fulfillment_stock` 7→8, total 42→44).

## Packages installed (all in `pnpm-workspace.yaml` catalog, referenced as
`catalog:` from `apps/gateway/package.json`)

- `jsonwebtoken` + `@types/jsonwebtoken` — issues/verifies the operator's bearer
  token directly (no `@nestjs/passport`; a single, statically-configured identity
  does not need a strategy framework).
- `swagger-ui-express` + `@types/swagger-ui-express` — serves `specs/shared/
  openapi.yaml` verbatim at `/docs`.
- `js-yaml` + `@types/js-yaml` — parses that same file, both to serve it and for the
  contract-drift test.
- `supertest` + `@types/supertest` — the black-box HTTP client (CLAUDE.md Testing
  conventions).
- `@types/express` — the exception filter and guard type the raw `Request`/
  `Response`; `@nestjs/platform-express` already depends on `express` itself, only
  the types package needed an explicit workspace declaration under pnpm's strict
  `node_modules`.

No `@nestjs/microservices` — this service issues RPC calls and one NATS core
subscription (the SSE signal), never answers an inbound `@MessagePattern`/
`@EventPattern` of its own, so the plain `nats` client (already in the catalog from
`fulfillment_stock`) is enough, same asymmetry `apps/orders`' own outbound adapters
already establish.

## Suites — final state

**[UPDATED IN ROUND 2 — these counts are AS OF the F2–F12 fix pass; see "Round 2"
below for what changed them from the original 27/101/5/28. The original numbers
were correct when written and are simply superseded, not corrected-in-place, since
seeing the delta (13 new unit tests, 4 new integration tests) is informative on its
own.]**

- `pnpm --filter @otc/gateway exec eslint .` — **exit 0**, zero warnings.
- `pnpm --filter @otc/gateway typecheck` — **exit 0**.
- `pnpm --filter @otc/gateway test` (unit, Docker-independent) — **28 files, 114
  tests, all green** (was 27 files / 101 tests before Round 2).
- `pnpm --filter @otc/gateway test:coverage` — thresholds (60/60/60/60) pass: 92.79%
  statements, 72.82% branches, 96.36% functions, 94% lines overall. Every `domain/`
  file that has any unit spec at all (`auth`, `problem`, `sse/*`) reports 100%
  statements/lines (v8's text reporter omits fully-covered files from the per-file
  table, hence their absence from the printed rows — visible via `grep` on the raw
  report); `domain/projection/order-read-model-mapper.ts` is 100% statements, 79%
  branch (a couple of defensive null-guards not separately exercised).
- `pnpm --filter @otc/gateway test:integration` (Testcontainers, real
  `nats:2.14.5-alpine` + `mongo:8.3.8`) — **5 files, 32 tests, all green** (was 5
  files / 28 tests before Round 2 — no new file, four new cases inside the
  existing five).
- `pnpm --filter @otc/gateway build` — **exit 0**.
- `./init.sh` — not re-run at the monorepo root as part of this pass (out of the
  bounded scope's touch-list beyond `apps/gateway/**`/`pnpm-workspace.yaml`); the
  gateway's own build/typecheck/lint/test all pass standalone and no other
  service's source was touched.

## Armed-deletion tests — verbatim failures

Per CLAUDE.md's binding rule, three representative "emits/suppresses a signal"
branches were deleted, the test run, the verbatim failure recorded, and the code
reverted (confirmed via `diff` against a pre-mutation backup — see the reverted
files' clean `git status` in the final state).

**1. `RegisterPaymentHandler` — the correlationId=orderId resolution (the closed
feature-22 gap, the single most safety-critical line in this feature).** Deleted the
resolved `orderId` from the `billing.payment.register` RPC call's `x-correlation-id`
and replaced it with a fresh, unrelated id:

```
// application/commands/register-payment.command.ts, inside execute()
{ correlationId: UniqueId.generate().value, requestId: UniqueId.generate().value }
```

Unit (`register-payment.command.spec.ts`):
```
AssertionError: expected '64ca9c0f-6621-481a-a917-39801c808ae8' to be 'order-1'
Expected: "order-1"
Received: "64ca9c0f-6621-481a-a917-39801c808ae8"
 ❯ src/application/commands/register-payment.command.spec.ts:82:45
```

Integration, against REAL NATS headers (`billing-fulfillment.integration.spec.ts`):
```
AssertionError: expected '02866acd-15f1-4f3a-b197-f217c484073b' to be 'order-1'
Expected: "order-1"
Received: "02866acd-15f1-4f3a-b197-f217c484073b"
 ❯ src/billing-fulfillment.integration.spec.ts:219:33
```

**2. `OrdersController.getOrder` — R55's 202-not-404 suppression.** Forced the
handler to answer `200`/an empty body instead of the `202 projection pending`
response for an order the read model has never seen:

Integration (`orders.integration.spec.ts`):
```
AssertionError: expected 200 to be 202
- Expected: 202
+ Received: 200
 ❯ src/orders.integration.spec.ts:75:29
```

**3. `StreamHub.publish` — the SSE signal emission (Group D).** Commented out
`this.subject.next(frame)`, leaving the replay buffer populated but no live
subscriber notified:

Unit (`stream-hub.spec.ts`):
```
AssertionError: expected [] to deeply equal [ '1787048100000-1' ]
- Expected: [ "1787048100000-1" ]
+ Received: []
 ❯ src/application/stream-hub.spec.ts:12:22
```

(An accompanying attempt to also re-confirm #3 against the real SSE endpoint was
inconclusive — the background process's revert landed before the relevant assertion
ran, given Testcontainers' own startup time; the unit-level result above is the
recorded evidence for this branch, and the mechanism it guards — `StreamHub.publish`
— is the ONLY place `stream.controller.ts` learns anything happened, wired through
`app.module.ts`'s DI unmodified.)

Also confirmed with `no-write-database-client.spec.ts` (Group B's own explicit
guard requirement): the second assertion ("no source file imports mysql2 or
drizzle-orm") is a live filesystem scan at test-run time, not a frozen fixture — a
manual, temporary `import 'mysql2'` added to `mongo-order-read-model.adapter.ts` and
removed again reproduced the intended failure
(`offenders` containing the added import) before being reverted.

## Open points / recorded gaps, for the reviewer

1. **`catalog.reference.list` has no live responder anywhere in this repository.**
   Grepped: no `@MessagePattern('catalog.reference.list', ...)` under any
   `apps/*/src`. The seeded product/retailer/company catalogue lives only in
   `otc_orders` (Orders' own MySQL write database), which this gateway must never
   read directly (Group B's rule). `GET /catalog/{products,retailers,companies}` is
   implemented exactly per the RPC contract and answers `503 UPSTREAM_UNAVAILABLE`
   honestly in the absence of a responder — proven by
   `billing-fulfillment.integration.spec.ts`'s *"every catalog endpoint answers 503
   ... without a live catalog.reference.list responder"*. Closing this needs a
   responder somewhere (most naturally Orders, since it already owns the reference
   data), which is outside this feature's bounded scope (`apps/gateway/**` only).

2. **`orders.cancel` has no live responder either** (only `orders.create` exists,
   in `apps/orders`). `POST /orders/{id}/cancel` is implemented exactly per the RPC
   contract (`asyncapi.yaml`'s `requestOrdersCancel`) and is exercised in
   integration tests against a TEST-ONLY stub responder
   (`orders.integration.spec.ts`) — never against real Orders code, since none
   exists to answer it yet.

3. **`POST /invoices/{id}/payments`'s correlationId resolution is a bounded scan,
   not O(1).** The brief's instruction — "resolve it through the read model, its
   `_id` is the order id" — is followed exactly for the SECOND half of the
   resolution (`orderReference → orderId`, via `OrderReadModel.findByOrderReference`,
   never touching a write database). But the FIRST half (`invoiceId → orderReference`)
   has no channel to answer it directly: `asyncapi.yaml` defines no
   "get invoice by id" RPC query (only `billing.invoice.list`, filterable by
   `status`/`retailerCode`/`companyCode`/`orderReference`/`issuedBeforeMinutes`,
   never by `invoiceId`), and the read model never learns `invoiceId` at all — only
   `invoiceReference`, because `invoice.issued.v1`'s own payload
   (`asyncapi.yaml InvoiceIssuedPayload`) carries no `invoiceId` either. So
   `RegisterPaymentHandler.resolveOrderReference` performs a **bounded scan** of
   `billing.invoice.list` (up to 5 pages × 200 items = 1000 invoices) looking for a
   matching `invoiceId`. This is still RPC-only (never a write-database read) and is
   explicitly documented in the file's own header comment, but it is O(invoices)
   rather than O(1) and would not scale past a demo/test dataset. Closing it cleanly
   needs either a `billing.invoice.get`-by-id RPC subject or an `invoiceId` filter
   added to `billing.invoice.list` — both outside `apps/gateway/**`'s bounded scope.
   Recorded per the brief's own instruction: *"if you find the read model cannot
   supply it, stop and report rather than reaching into MySQL"* — I did not reach
   into MySQL; I report this scan as the best available RPC-only alternative.
   **Addendum, Round 2 (review finding F4):** the scan itself is unchanged and the
   bound above is still correct — what changed is what happens when the bound is
   exhausted. Originally, exhausting all 5 pages answered `404 "no invoice for id
   ..."` regardless of whether the last page fetched was still full (i.e. more
   invoices might exist beyond the window) — a false statement in that case, since
   the invoice might well exist. Now the two cases are told apart: a page shorter
   than `INVOICE_SCAN_PAGE_SIZE` with no match means the list is genuinely
   exhausted (`404`, an honest "does not exist"); the bound reached with the last
   page still full means "may exist beyond this gateway's search window"
   (`InvoiceScanBudgetExceededError` → `503 SCAN_BUDGET_EXCEEDED`, never a false
   `404`). See "Round 2" below for the tests.

4. **[RESOLVED IN ROUND 2 — see "Round 2" section below, review finding F3]**
   `GET /orders/{id}` now distinguishes the two cases: the gateway itself is the
   component that hands out an order id (`POST /orders` → `PlaceOrderHandler`
   records it in a bounded, TTL'd `IssuedOrderWindow`), so "an order identifier
   that the caller has just been given" (R55's own clause) is answerable without
   any new RPC subject — `202` when this gateway issued the id recently and the
   read model has not caught up yet, `404` for everything else (never issued, or
   issued long enough ago that the window has expired). `GET /orders/{id}`'s `404`
   is reachable now. Original claim, kept struck through rather than deleted, since
   it was true when written and is not true of the shipped code: ~~`GET
   /orders/{id}` cannot distinguish "not yet projected" from "genuinely unknown
   order id." There is no `orders.get`-by-id RPC query in the contract (only
   `orders.create`/`orders.cancel` commands), so a gateway with no memory of which
   order ids it has ever issued has no way to ask Orders "does this id exist at
   all." The implementation therefore always answers `202 projection pending` for
   an id absent from the read model, never a bare `404` — the honest, conservative
   choice (a false "pending" self-corrects the moment the projection catches up or
   the caller gives up retrying; a false `404` for an order that is about to
   appear would be a worse lie). `GET /orders/{id}`'s `404` response remains
   reachable only if a future feature adds a way to know an id is bogus.~~

5. **[RESOLVED IN ROUND 2 — see "Round 2" section below, review finding F5]**
   `.env.example` (and `.env`) now DO carry the operator identity, plus every
   other `GATEWAY_*` tuning knob this feature reads: `GATEWAY_OPERATOR_USERNAME`,
   `GATEWAY_OPERATOR_PASSWORD`, `GATEWAY_OPERATOR_DISPLAY_NAME`,
   `GATEWAY_RPC_TIMEOUT_MS`, `GATEWAY_SSE_BUFFER_CAPACITY`,
   `GATEWAY_SSE_PING_INTERVAL_MS`, `GATEWAY_ISSUED_ORDER_WINDOW_TTL_MS`,
   `GATEWAY_ISSUED_ORDER_WINDOW_CAPACITY` — eight keys, in the same
   `_change_me`-framed style `JWT_SECRET` already uses. **The code-level default
   in `operator.config.ts` is still present** (the established convention in this
   repo — every `*.config.ts` here falls back gracefully with no `.env` at all),
   but its value now matches `.env.example`'s own value byte-for-byte, and the
   password itself changed to `otc_operator_dev_password_change_me` (see "Round 2"
   below, and the corrected manual-test recipe at the end of this file). Original
   claim, kept struck through rather than deleted, since it was true when written
   and the file it describes as untouched has since been touched: ~~`.env.example`
   was not touched (out of this feature's bounded scope — the brief names only the
   already-present `JWT_SECRET`/`JWT_EXPIRES_IN`/`JWT_ISSUER`). The operator
   identity (`domain-model.md` §9's single, statically-configured identity)
   therefore follows every other `*.config.ts` in this repo's own "env var with a
   sensible dev default" shape: `GATEWAY_OPERATOR_USERNAME` (default `operator`),
   `GATEWAY_OPERATOR_PASSWORD` (default `otc_operator_dev_password`),
   `GATEWAY_OPERATOR_DISPLAY_NAME` (default `Order-To-Cash Operator`) — see
   `infrastructure/auth/operator.config.ts`. Flagged here in case the reviewer
   wants these three names added to `.env.example` explicitly (a doc/compose-scope
   change, outside `apps/`).~~

6. **A real route-order bug, found and fixed by the integration suite itself.**
   `app.module.ts`'s original `controllers: [...]` order registered `OrdersController`
   (`GET /orders/:id`) before `StreamController` (`GET /orders/stream`); Nest/Express
   match routes in registration order, so `/orders/stream` was being swallowed by
   the `:id` wildcard and rejected as an invalid order id. Fixed by reordering
   `StreamController` first, with a comment recording why — `stream.integration.spec.ts`
   is what caught it.

## Round 2 — fixes for review findings F2–F12

`progress/review_gateway_rest_auth.md`'s Round 1 rejected on **F1** (an
`apps/orders`-side wire defect, routed to and fixed by a separate agent — see
`progress/impl_orders_bare_json_wire.md`) and named **F2–F12** as this feature's
own. All eleven closed in this pass; re-review (Round 2) confirmed every one by
independent execution and found no new code defect. Scope for this pass was
`apps/gateway/**`, `.env.example`, `.env` (config keys only) and three specific
`specs/shared/test-matrix.md` cells — `apps/orders` was explicitly off limits to
avoid colliding with the concurrent F1 fix.

**F2 — the R54 "no write-database client" guard's second assertion was a
substring scan with a hole matching this repo's own import idiom.**
`text.includes("'mysql2'")` does not match `'mysql2/promise'` — the exact form
`apps/billing/src/infrastructure/persistence/client.ts` uses for its own MySQL
client. Rewritten in `no-write-database-client.spec.ts` to spawn a REAL, unmodified
`node` child process (`execFileSync`) and ask it to `require.resolve()` each of
`mysql2`, `mysql2/promise`, `drizzle-orm`, `drizzle-orm/mysql2` — genuine module
resolution, not text matching. **Found live while building the fix:** an
in-process `require.resolve()` (no child process) reports `mysql2` as resolvable
even though `apps/gateway/node_modules/mysql2` does not exist, because vitest
injects its own `NODE_PATH` (pointing at a broadly-hoisted `.pnpm` directory) into
`process.env`, and Node's resolver checks `NODE_PATH` as a legacy fallback. The
child process explicitly strips `NODE_PATH` from its own environment for exactly
this reason — verified by hand: identical `require.resolve()` calls resolve WITH
a hoisted `NODE_PATH` and fail WITHOUT one, from the identical `cwd`. A
non-vacuity case in the same file proves the identical mechanism DOES resolve
`mongodb`/`nats`. Armed with the reviewer's own exact mutation
(`import mysql from 'mysql2/promise'; import { drizzle } from
'drizzle-orm/mysql2';` in `mongo-client.ts`) — the guard itself stayed correctly
green (it tests resolvability, not file content), and `pnpm typecheck` died on
both lines:

```
src/infrastructure/persistence/mongo-client.ts(16,19): error TS2307: Cannot find module 'mysql2/promise' or its corresponding type declarations.
src/infrastructure/persistence/mongo-client.ts(17,25): error TS2307: Cannot find module 'drizzle-orm/mysql2' or its corresponding type declarations.
```

Mutation reverted, `mongo-client.ts` byte-identical to its pre-arming state
afterwards. The Round 2 reviewer independently re-armed this by creating REAL
`apps/gateway/node_modules/{mysql2,drizzle-orm}` stub packages and confirmed the
guard now fails, naming all four specifiers — including both subpath forms that
defeated the predecessor — while the file's other two cases passed in the same
run, ruling out a spawn artefact.

**F3 — `GET /orders/{id}` always answered 202, making openapi.yaml's own
documented 404 unreachable.** New `domain/orders/issued-order-window.ts` —
`IssuedOrderWindow`, a bounded (default 10,000 entries, oldest-evicted-first),
TTL'd (default 5 minutes, `GATEWAY_ISSUED_ORDER_WINDOW_TTL_MS`/`_CAPACITY`) map
from order id to the instant this gateway process issued it. `PlaceOrderHandler`
records into it on every successful `POST /orders`; `GetOrderHandler`
(`get-order.query.ts`) now returns a three-way result — `kind: 'found'` (200),
`kind: 'pending'` (202 — only when `IssuedOrderWindow.isRecentlyIssued(orderId)`
is true), `kind: 'unknown'` (404, via `NotFoundException`) — and
`OrdersController.getOrder` maps all three. `orders.integration.spec.ts`'s single
old case (any unknown id → 202) is now two: *"F3 — GET /orders/{id} for an id
this gateway never issued... answers 404, not 202"* and *"R55/F3 — GET
/orders/{id} for an id THIS GATEWAY JUST ISSUED (via POST /orders), not yet
projected, answers 202 projection pending"* — the second drives a real
`POST /orders` through a stub responder first, then immediately `GET`s the
returned id, so the 202 is proven to depend on the window rather than being a
blanket default. Six new unit cases in `issued-order-window.spec.ts` cover
record/read, expiry at and past the TTL boundary, and capacity eviction.

**F4 — the invoice-lookup scan's out-of-bound failure was a false 404, and the
multi-page path had no test.** `register-payment.command.ts`'s
`resolveOrderReference` now tracks whether the LAST page fetched was full
(`items.length === INVOICE_SCAN_PAGE_SIZE`): a short page with no match means the
list is genuinely exhausted (`InvoiceNotFoundError` → 404, an honest "does not
exist"); the 5-page/1000-invoice bound reached while the last page was still full
means the invoice may exist beyond the search window (new
`InvoiceScanBudgetExceededError` → `503 SCAN_BUDGET_EXCEEDED`, mapped in
`problem-json.filter.ts`, never a false 404). Three new unit cases: a two-page
walk that finds a match on page 2 (asserting the RPC calls carry `page: 1` then
`page: 2`), a short first page throwing `InvoiceNotFoundError` after exactly one
call, and all 5 pages coming back full throwing `InvoiceScanBudgetExceededError`
after exactly 5 calls with `billing.payment.register` never invoked.

**F5 — the operator identity was a hardcoded default in tracked source with no
visible override.** `.env.example`/`.env` gained eight keys:
`GATEWAY_OPERATOR_USERNAME`, `GATEWAY_OPERATOR_PASSWORD` (value changed to
`otc_operator_dev_password_change_me`, the `_change_me` framing `JWT_SECRET`
already uses), `GATEWAY_OPERATOR_DISPLAY_NAME`, `GATEWAY_RPC_TIMEOUT_MS`,
`GATEWAY_SSE_BUFFER_CAPACITY`, `GATEWAY_SSE_PING_INTERVAL_MS`,
`GATEWAY_ISSUED_ORDER_WINDOW_TTL_MS`, `GATEWAY_ISSUED_ORDER_WINDOW_CAPACITY`.
`operator.config.ts`'s code-level fallback stays (the established convention
every `*.config.ts` here uses) but now matches `.env.example` byte-for-byte.
Integration tests no longer rely on that fallback at all —
`gateway-app-test-harness.ts` now sets `GATEWAY_OPERATOR_USERNAME`/`_PASSWORD`
explicitly to test-only values (`TEST_OPERATOR_USERNAME`/`TEST_OPERATOR_PASSWORD`,
exported constants), so a future change to the code default cannot silently
strand the test suite.

**F6 — three overclaims in `specs/shared/test-matrix.md`.** (Not touched in THIS
round — Round 2's own G1 finding is a further composition issue in the same cells,
routed to the leader; the original F6 fix — describing the guard mechanism
accurately, disclaiming the phantom `gateway/integration/query-source.spec`
in-cell, and naming R61's stub-only evidence — stands from the F-round and is not
revisited here.)

**F7 — the SSE `ping` heartbeat had no test.** `stream.integration.spec.ts` gained
a second, self-contained `describe` block booting its own app instance with
`GATEWAY_SSE_PING_INTERVAL_MS=200` (the interval is read once, at DI-container
build time, so overriding it for one test means a dedicated app, not a shared
one) and asserts at least two `ping` frames with a parseable ISO `at` field.

**F8 — nothing asserted that exactly four routes are unauthenticated.**
`auth.integration.spec.ts` gained a case that introspects the live Express router
(`extractExpressRoutes`), skips the three known-public Nest routes
(`POST /auth/login`, `GET /health/live`, `GET /health/ready` — `GET /docs` is
raw middleware and never appears in this introspection at all, proved
unauthenticated separately by `contract-drift.integration.spec.ts`), and asserts
every remaining registered route answers 401 for an anonymous request.

**F9 — the `/orders/stream` vs `/orders/:id` route-order fix was guarded only
incidentally.** `contract-drift.integration.spec.ts` gained a case naming the
invariant directly on the live Express stack: `GET /orders/stream`'s layer index
must precede `GET /orders/:id`'s. Armed by swapping `StreamController`/
`OrdersController` back to the broken order in `app.module.ts` and re-running:

```
AssertionError: expected 12 to be less than 10
 ❯ src/contract-drift.integration.spec.ts:106:25
```

Reverted; `app.module.ts` byte-identical afterwards.

**F10 — a comment cited a guard spec (`read-model-write-guard.spec.ts`) that does
not exist.** `mongo-client.ts`'s header now names what actually enforces R54 —
`no-write-database-client.spec.ts`'s two real assertions.

**F11 — the contract test's own case title said "20 operations"; there are 18.**
Fixed in `contract-drift.integration.spec.ts`'s title and header comment
(17 `paths:` keys, 18 operations — `GET`+`POST /orders` share one path key); the
case now also asserts the operation count via `extractOpenapiRoutes(...)`, not
just the path-key count.

**F12 — a header comment in `stream-hub.ts` pointed at
`infrastructure/signal/nats-stream-signal.adapter.ts`, which does not exist in
this service** (that is the projector's own directory name for its analogous
publisher; this gateway's copy lives under `infrastructure/messaging/`).
Corrected.

### New/changed files, Round 2

- `apps/gateway/src/domain/orders/issued-order-window.ts` + `.spec.ts` (new)
- `apps/gateway/src/application/ports/issued-order-window.port.ts` (new)
- `apps/gateway/src/infrastructure/orders/issued-order-window.config.ts` (new)
- `apps/gateway/src/test-support/fake-issued-order-window.ts` (new)
- `apps/gateway/src/no-write-database-client.spec.ts` (rewritten, F2)
- `apps/gateway/src/infrastructure/persistence/mongo-client.ts` (comment, F10)
- `apps/gateway/src/presentation/orders.controller.ts`,
  `src/application/queries/get-order.query.ts` (+ `.spec.ts`),
  `src/application/commands/place-order.command.ts` (+ `.spec.ts`),
  `src/app.module.ts` (F3 wiring)
- `apps/gateway/src/orders.integration.spec.ts` (F3 test split)
- `apps/gateway/src/application/commands/register-payment.command.ts`,
  `src/presentation/problem-json.filter.ts` (+ `.spec.ts`),
  `src/application/commands/register-payment.command.spec.ts` (F4)
- `apps/gateway/src/infrastructure/auth/operator.config.ts`,
  `src/test-support/gateway-app-test-harness.ts`,
  `src/{orders,billing-fulfillment,auth,stream}.integration.spec.ts` (F5)
- `apps/gateway/src/auth.integration.spec.ts` (F8 case)
- `apps/gateway/src/stream.integration.spec.ts` (F7 describe block)
- `apps/gateway/src/contract-drift.integration.spec.ts` (F9, F11)
- `apps/gateway/src/application/stream-hub.ts` (F12)
- `.env.example`, `.env` (F5, eight keys)
- `specs/shared/test-matrix.md` (F6 — three cells; NOT touched again in this pass)

### Suite results after this pass

`eslint` 0, `typecheck` 0, `build` 0, unit **28 files / 114 tests**, integration
**5 files / 32 tests** — see "Suites — final state" above, updated to match.

## What I did not build

- No metrics endpoint, no OpenTelemetry SDK wiring (R56/R57/R59) — those are
  `observability_reliability` (phase 8, a separate, not-yet-scheduled feature per
  `feature_list.json`), not named in this feature's three acceptance criteria.
  `ProblemJsonExceptionFilter` does emit one structured JSON log line per error
  (`correlationId`, `code`, `status`, `message`, `occurredAt`) as a minimal, honest
  down payment on R58, not a claim of full compliance.
- No rate limiting for `POST /auth/login` (`openapi.yaml`'s documented `429`
  response) — not named in this feature's acceptance criteria either; the `429`
  response shape exists in `domain/problem/rpc-error-mapping.ts`'s vocabulary
  (`codeForStatus`) but nothing currently throws it.

## Traceability (R<n> → test)

- **R13** (outbox atomicity, already `DONE` at the Orders level) — `POST /orders`'s
  own translation is proven by `orders.integration.spec.ts` › *"R13 — POST /orders
  translates to orders.create and answers 201 with projectionPending:true..."*.
- **R26/R42** (stock-unavailable business rejection surfaced honestly) —
  `orders.integration.spec.ts` › *"R42/R26 — POST /orders surfaces a
  STOCK_UNAVAILABLE business rejection as 409 with shortages"*.
- **R27/R28** (cancellation compensation planning, correlationId = the known order
  id) — `orders.integration.spec.ts` › *"R27/R28 — POST /orders/{id}/cancel
  translates to orders.cancel..."*.
- **R47–R49** (already `DONE` at the Billing/NATS level) — the gateway's own
  translation, including the correlationId resolution, is proven by
  `billing-fulfillment.integration.spec.ts`'s `POST /invoices/{id}/payments`
  `describe` block.
- **R54** — `no-write-database-client.spec.ts`, `mongo-order-read-model.adapter.spec.ts`,
  `orders.integration.spec.ts` › *"R54 — GET /orders/{id} returns the projected
  document..."* and *"R53/R54 — GET /orders excludes a placeholder document..."*.
- **R55** — `orders.integration.spec.ts` › *"R55/F3 — GET /orders/{id} for an id
  THIS GATEWAY JUST ISSUED (via POST /orders), not yet projected, answers 202
  projection pending"* and *"F3 — GET /orders/{id} for an id this gateway never
  issued and the read model has never seen answers 404, not 202"* (Round 2 retitle
  — the original single case named here, *"R55 — GET /orders/{id} for an id the
  read model has never seen answers 202 projection pending, not 404"*, no longer
  exists under that name; see "Round 2" below); `stream.integration.spec.ts`'s five
  cases (live frame, `orderId` filter, known-cursor replay, unknown-cursor
  `resumed:false`, `ping` heartbeat); unit: `domain/sse/{cursor,replay-buffer}.spec.ts`,
  `application/stream-hub.spec.ts`, `domain/orders/issued-order-window.spec.ts`.
- **R58** (partial — see "What I did not build") — `problem-json.filter.spec.ts`.
- **R60** — `infrastructure/health/health-checks.spec.ts`,
  `auth.integration.spec.ts` › *"GET /health/live and GET /health/ready are
  unauthenticated..."*.
- **R61** — `application/commands/replenish-stock.command.spec.ts`,
  `billing-fulfillment.integration.spec.ts` › *"R61 — POST /stock/replenish
  translates to fulfillment.stock.replenish"*.
- `specs/shared/test-matrix.md` rows R54, R55 (gateway half), R61 updated with this
  evidence.

## How to test manually

```bash
pnpm --filter @otc/gateway exec eslint .
pnpm --filter @otc/gateway typecheck
pnpm --filter @otc/gateway test              # fast, no Docker
pnpm --filter @otc/gateway test:integration  # Testcontainers, needs Docker (~2 min)
pnpm --filter @otc/gateway build
```

**[CORRECTED IN ROUND 2 — the password below changed under F5; the recipe was
re-run live against the real compose stack (`otc-mongodb`, `otc-nats` already up)
to confirm it, not merely edited]** To see it live: `docker compose -f
docker-compose.infra.yml up -d` if the infra stack is not already running, then
`pnpm --filter @otc/gateway build && pnpm --filter @otc/gateway start` (or `pnpm
dev:gateway` for the watch-mode equivalent), then:

```bash
curl -X POST localhost:3001/auth/login -H 'content-type: application/json' \
  -d '{"username":"operator","password":"otc_operator_dev_password_change_me"}'
# {"accessToken":"eyJ...","tokenType":"Bearer","expiresIn":3600}

TOKEN=<accessToken from above>
curl localhost:3001/orders/00000000-0000-4000-8000-000000000000 \
  -H "Authorization: Bearer $TOKEN"
# 404 {"code":"NOT_FOUND","detail":"no order for id \"00000000-...\""} — an id
# never issued by this process (F3); a real POST /orders id would answer 202
# instead, until the projection catches up or the recency window expires.

curl -L localhost:3001/docs   # 200, the interactive contract
```

All three calls above were actually run against a live `dist/main.js` process on
2026-08-25, against the running `otc-mongodb`/`otc-nats` containers, with exactly
the output shown. Original recipe, kept struck through rather than deleted, since
the password it names is no longer the configured value: ~~`pnpm dev:gateway`, then
`curl -X POST localhost:3001/auth/login -d
'{"username":"operator","password":"otc_operator_dev_password"}' -H 'content-type:
application/json'`, then `GET /docs` for the interactive contract.~~
