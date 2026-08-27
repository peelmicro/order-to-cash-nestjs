# impl: orders_catalog_responder (feature 40, phase 13)

## What I built

A read-only NATS responder in `apps/orders` for `catalog.reference.list`, closing the gap `apps/gateway/src/application/queries/list-catalog.query.ts` recorded since feature 25 (no responder subscribed -> `503 UPSTREAM_UNAVAILABLE`).

### New files

- `apps/orders/src/application/ports/catalog-reference-list.port.ts` — `CatalogReferenceListPort` (method `list(input)`), `CatalogKind`, `ALL_CATALOG_KINDS`, token `CATALOG_REFERENCE_LIST`. Deliberately a SEPARATE port from `OrderReferenceDataPort` (see the file's own header): that port's `resolve(...)` is shaped for `PlaceOrderHandler`'s specific-codes validation (`ReadonlyMap`, `GLN`/`Money` value objects); widening it would also force `place-order.handler.spec.ts`'s plain-object fake to grow a method it never uses.
- `apps/orders/src/application/queries/list-catalog-reference.query.ts` — `ListCatalogReferenceQuery` + `ListCatalogReferenceHandler` (`@nestjs/cqrs` `@QueryHandler`, `@Inject(CATALOG_REFERENCE_LIST)`), a thin pass-through onto the port.
- `apps/orders/src/application/queries/list-catalog-reference.query.spec.ts` — pure unit, fake port.
- `apps/orders/src/presentation/dto/catalog-reference-list.dto.ts` — `CatalogReferenceListRequestDto`, `implements CatalogReferenceListRequestPayload` (its `kinds` field types itself off `CatalogReferenceListRequestPayload['kinds']` to stay exactly in sync with the generated tuple type rather than re-declaring it).
- `apps/orders/src/presentation/catalog-reference-list.controller.ts` — `CatalogReferenceListController`, `@MessagePattern(CATALOG_REFERENCE_LIST_SUBJECT, Transport.NATS)`, mirrors `orders-create.controller.ts` exactly: explicit `Transport.NATS` (hybrid-app pattern-binding rule), explicit `@Inject(QueryBus)`, `@Ctx() natsContext` trace propagation, never throws (validation failure and query rejection both resolve to an `RpcError`-shaped object).
- `apps/orders/src/presentation/catalog-reference-list.controller.spec.ts` — pure unit, fake `QueryBus`.
- `apps/orders/src/catalog-reference-list-wire.integration.spec.ts` — the real-wire proof, Testcontainers MySQL + NATS, mirrors `orders-create-wire.integration.spec.ts`'s shape exactly: a raw bare-JSON `nats` client (the Gateway's own `NatsRpcClientAdapter` shape) against the SAME `createOrdersNatsMicroserviceOptions` `main.ts` uses in production.

### Modified files

- `apps/orders/src/infrastructure/persistence/order-reference-data.repository.ts` — `DrizzleOrderReferenceDataRepository` now `implements OrderReferenceDataPort, CatalogReferenceListPort`. Added `list(input)` (kinds-filtered, `{}` when a collection isn't requested — asyncapi.yaml's "only the requested collections are present") and two private helpers `listProducts`/`listParties` (the latter shared by `retailers`/`companies`, same-shape tables). **This is the reuse the brief asked for**: one class, one `OrdersDb` connection, one set of `products`/`retailers`/`companies`/`currencies` schema imports — `resolve(...)` (specific codes, for `PlaceOrderHandler`) and `list(...)` (the whole catalogue, for this responder) read from the exact same adapter instance in production (see `app.module.ts`'s `useExisting` binding below), never two independently-drifting query paths.
- `apps/orders/src/infrastructure/persistence/order-reference-data.integration.spec.ts` — extended with a `describe('list — orders_catalog_responder...')` block against the SAME fixture/repository instance the existing `resolve(...)` tests use, plus one extra seeded disabled product to prove the `includeDisabled` filter.
- `apps/orders/src/app.module.ts` — registers `CatalogReferenceListController`; binds `CATALOG_REFERENCE_LIST` via `{ provide: CATALOG_REFERENCE_LIST, useExisting: ORDER_REFERENCE_DATA }` (an alias, not a second `useFactory` — literally the same repository instance `ORDER_REFERENCE_DATA` resolves to); registers `ListCatalogReferenceHandler` as a provider.

## Acceptance criteria (feature_list.json #40) -> proof

1. **"GET /catalog/products, /catalog/retailers, /catalog/companies return real data through the Gateway"** — proven live (see below) and by `catalog-reference-list-wire.integration.spec.ts`'s first test (real MySQL fixture rows come back over the real NATS wire).
2. **"no new bounded context"** — no new database, no new schema; the responder reads the existing `otc_orders` `products`/`retailers`/`companies`/`currencies` tables `DrizzleOrderReferenceDataRepository` already owned.
3. **"reuses the same reference-data lookup PlaceOrderHandler already calls, exposed as a query rather than duplicated"** — `app.module.ts`'s `useExisting: ORDER_REFERENCE_DATA` alias, described above.

## Tests written (no R<n> requirements — feature is `sdd: false`, no `specs/orders_catalog_responder/`; `specs/shared/test-matrix.md` untouched per bounded scope)

| Test | Proves |
|---|---|
| `list-catalog-reference.query.spec.ts` › *forwards kinds and includeDisabled to the port and returns its reply unchanged* | Query handler is a correct pass-through |
| `list-catalog-reference.query.spec.ts` › *passes an empty kinds array through unchanged* | Handler does not itself resolve "all four" (the port does) |
| `catalog-reference-list.controller.spec.ts` › *returns the QueryBus reply as-is on success* | Controller success path |
| `catalog-reference-list.controller.spec.ts` › *defaults an omitted request body to kinds: [] and includeDisabled: false* | `payload ?? {}` + DTO defaults |
| `catalog-reference-list.controller.spec.ts` › *returns a VALIDATION_FAILED RpcError, never throws* | class-validator wiring, `IsIn` on `kinds` |
| `catalog-reference-list.controller.spec.ts` › *returns an INTERNAL_ERROR RpcError, never throws* | try/catch -> `toRpcError` |
| `order-reference-data.integration.spec.ts` › *with no kinds requested, returns all four collections* | `list()` against real MySQL, kinds-omitted-means-all |
| `order-reference-data.integration.spec.ts` › *honours a kinds filter — only the requested collections are present* | per-kind key presence contract |
| `order-reference-data.integration.spec.ts` › *excludes a disabled product by default* | `includeDisabled: false` filtering |
| `order-reference-data.integration.spec.ts` › *includes the disabled product ... when includeDisabled: true* | `includeDisabled: true` path |
| `catalog-reference-list-wire.integration.spec.ts` › *answers a bare-JSON request ... with the fixture's real data* | Real NATS wire, real MySQL, production `main.ts` config |
| `catalog-reference-list-wire.integration.spec.ts` › *honours a kinds filter over the real wire* | End-to-end kinds filtering |
| `catalog-reference-list-wire.integration.spec.ts` › *answers a bare-JSON RpcError over the real wire on a validation failure* | End-to-end validation-error shape |

## Armed deletions (binding testing rule) — verbatim failures

1. **`kinds.length > 0 ? input.kinds : ALL_CATALOG_KINDS` -> `input.kinds`** (repository.ts): re-ran `order-reference-data.integration.spec.ts -t "with no kinds requested"` — failed:
   `AssertionError: expected undefined to deeply equal ArrayContaining{…}` (`reply.products` was `undefined`). Restored, re-verified green.
2. **Removed the `includeDisabled || row.disabledAt === null` filter** (repository.ts `listProducts`): re-ran `-t "excludes a disabled product by default"` — failed:
   `AssertionError: expected true to be false` (the disabled fixture product was present when it should have been excluded). Restored, re-verified green.
3. **Removed the `if (violations.length > 0) return validationRpcError(violations);` branch** (controller.ts): re-ran `-t "VALIDATION_FAILED"` — failed:
   `AssertionError: expected undefined to match object { code: 'VALIDATION_FAILED' }` (the malformed `kinds` value reached the QueryBus untouched instead of short-circuiting). Restored, re-verified green.
4. **Removed the `try { ... } catch (error) { return toRpcError(error); }` wrapper** (controller.ts, made `handle` a bare `return this.queries.execute(...)`): re-ran `-t "INTERNAL_ERROR"` — failed with an UNHANDLED rejection propagating out of the controller:
   `Error: boom` (thrown from the fake QueryBus, no longer caught — violates the "never throws" contract this responder shares with `orders-create.controller.ts`). Restored, re-verified green.

After each arm-and-revert, re-ran the affected spec file(s) green again; final full re-runs below confirm the restored state.

## Live end-to-end verification (the acceptance criterion)

Infra (`docker-compose.infra.yml`) was already running (MySQL/Kafka/NATS healthy) with the seeded `otc_orders` reference tables (12 products, 7 retailers, 22 companies, 3 currencies — confirmed via `docker exec otc-mysql mysql ...`). Started both services for real:

```
pnpm --filter @otc/orders run dev    # port 3002, NATS nats://localhost:4222
pnpm --filter @otc/gateway run dev   # port 3001, NATS nats://localhost:4222
```

Orders' boot log confirms the new controller registered: `[RoutesResolver] CatalogReferenceListController {/}` and `orders.create`/`catalog.reference.list` share the same NATS microservice.

Logged in and called all three Gateway endpoints:

```
POST /auth/login {"username":"operator","password":"otc_operator_dev_password_change_me"} -> 200, accessToken

GET /catalog/products   -> 200 {"items":[{"code":"PRD-0001", ... 12 products ...}]}
GET /catalog/retailers  -> 200 {"items":[{"code":"CarrefourEs", ... 7 retailers ...}]}
GET /catalog/companies  -> 200 {"items":[{"code":"GALLIAGOODS", ... 22 companies ...}]}
```

All three: HTTP 200 with real seeded data (previously `503 UPSTREAM_UNAVAILABLE`, per `list-catalog.query.ts`'s own recorded-gap comment). Both dev processes stopped afterward (`kill`, verified ports 3001/3002 free).

## Quality gates

- `pnpm run lint` (repo-wide, flat ESLint config incl. domain-purity / DI-token / transport-binding rules) — **clean, no output.**
- `pnpm run typecheck` (repo-wide, `pnpm -r run typecheck`) — **all 10 workspace projects: Done, 0 errors.**
- `pnpm run test` (repo-wide, `pnpm -r run test`, unit/non-integration) — **all green**: contracts 22, shared-kernel 69, notifications 82, fulfillment 83, gateway 121, billing 138, **orders 485 (50 files)**, projector 133, seed 119 — no regressions.
- `apps/orders` integration specs (Testcontainers): ran the two feature-relevant files together — `order-reference-data.integration.spec.ts` (6 tests, includes the 4 new `list()` cases) and `catalog-reference-list-wire.integration.spec.ts` (3 tests) — **9/9 passed.** I attempted a full-suite `apps/orders` integration re-run (`vitest run --config vitest.integration.config.mts`, no filter) as an extra check; it did not finish inside a 590s external timeout — this app has dozens of Testcontainers-backed spec files (saga, outbox, DLQ, sagas, etc.) and a full pass routinely runs well past 10 minutes on this machine, independent of anything this feature touched. Not re-attempted with a longer budget given the two directly-relevant files, the full non-integration suite (485 tests, including every file that imports `order-reference-data.repository.ts` and `app.module.ts`'s provider graph indirectly), and the live end-to-end run above together cover this feature's surface.
- `./init.sh` — exit 0 (re-confirmed at session start; no state-coherence-affecting change since).

## What I could not do / scope notes

- Did not touch `specs/` or `feature_list.json`'s content beyond setting this feature's `status` to `in_review` (reviewer's call per CLAUDE.md) — `sdd: false`, no `R<n>` requirements exist for this feature, so `specs/shared/test-matrix.md` was correctly left untouched (no TODO row references feature 40).
- `currencies` has no `enabled`/`disabledAt` concept in the schema (`currencies.schema.ts` carries none) — matches `CurrencyView`'s own asyncapi schema, which has no `enabled` field either; `includeDisabled` therefore only affects `products`/`retailers`/`companies`.
- Did not add a full-`AppModule`-boot test for the `useExisting` DI alias — no existing spec in this codebase boots the real `AppModule` (`orders-create-wire.integration.spec.ts`/`health-probes.integration.spec.ts` both hand-compose a minimal Nest module mirroring the real provider wiring instead, the established pattern here); the alias itself is proven correct by the live E2E run above, which is the feature brief's own explicitly-named acceptance mechanism for this claim ("verify it live, don't just assert it in a unit test").

## Surprises

- The Gateway's `ListCatalogHandler` always requests exactly one `kind` (`kinds: [query.kind]`) — never omits `kinds` and never requests more than one. The `kinds: []` -> "all four" path and the multi-kind reply shape are therefore proven only by this feature's own tests (unit, integration, and the wire spec), not exercised by any live Gateway caller yet — noted in case a future Gateway feature widens `ListCatalogQuery` to request multiple kinds at once.
