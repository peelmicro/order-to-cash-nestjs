# Review — `gateway_rest_auth` (id 25, phase 13, `sdd: false`)

**Verdict: REJECTED — 1 blocking defect (F1), 5 material, 8 minor.**

Spec of record: `specs/shared/openapi.yaml` + `feature_list.json` id 25's three acceptance criteria + `specs/shared/requirements.md` R54/R55. Status was `pending`; treated as submitted, and set back to `in_progress` on this verdict.

The build is, on the whole, careful and honest work — clean layering, real Testcontainers, four self-declared gaps that all turned out to be truthfully described. It is rejected for one thing the submission did not know about: **the flagship write endpoint, `POST /orders`, cannot work against the real Orders service, and the feature's own test suite is structurally incapable of noticing, because it tests that endpoint against a stub the implementer wrote to speak a wire the real responder does not.** That is the exact trap probe 7 was asked to look for, and it is live rather than hypothetical.

---

## What I did not re-run

Per the brief I did **not** re-run the full unit suite as verification of the implementer's counts, nor the full integration suite, nor `pnpm quality` across the monorepo. What I ran myself:

- `pnpm --filter @otc/gateway exec eslint .` → **0**; `pnpm typecheck` → **0**; `pnpm test` → **27 files / 101 tests passed** (run once only, at the end, to confirm my own mutations were fully reverted — the counts happen to match the claim).
- `vitest run --config vitest.integration.config.mts src/contract-drift.integration.spec.ts` — **twice, each time with a different hostile mutation armed**.
- `vitest run --config vitest.integration.config.mts src/stream.integration.spec.ts` — **once, with the controller registration order deliberately regressed**.
- `vitest run src/no-write-database-client.spec.ts` — once, with a forbidden import armed in the form this repo actually uses.
- `pnpm --filter @otc/gateway typecheck` — once, with the same forbidden import armed, to find out what *actually* enforces R54.
- A bespoke wire probe (`/tmp/.../wire-probe.cjs`) against a disposable `nats:2.14.5-alpine` container: a Nest NATS microservice configured **byte-identically to `apps/orders/src/main.ts`**, driven once with the gateway's bare-JSON encoding and once with the Nest envelope.
- `./init.sh` → **exit 0** (the implementer records not having run it; the leader's brief said it was green. It is green.)
- Static walks: `openapi.yaml` (17 paths / **18** operations) → routes → tests; `git status --porcelain`; `git diff` on the lockfile and workspace manifest; domain-purity grep; `@Public()` grep; a repo-wide sweep for `catalog.reference.list` and `orders.cancel` responders.

---

## CHECKPOINTS.md — boxes walked

### C1 — The harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer (6 definitions).
- [x] Every agent definition declares its model (verified by `init.sh` §2).
- [x] `./init.sh` exits 0.

### C2 — State is coherent
- [x] At most one feature `in_progress` (none was; id 25 set to `in_progress` by this verdict).
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it.
- [ ] **`progress/current.md` describes the active session** — it still describes `projector_read_model` (id 24) as `in_progress` with a Phase 12 goal, and line 73 still asserts "apps/projector is still a scaffold". This is finding **N11** carried over unfixed from the feature-24 review. Leader's.
- [x] Every `blocked` feature records why (none blocked).

### C3 — Architecture is respected
- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside any `domain/` folder — `eslint .` exit 0, and confirmed independently by grep across `apps/gateway/src/domain/**` (zero hits, including `rxjs` and `jsonwebtoken`).
- [x] No cross-service database access. The gateway opens exactly one MongoDB connection, onto the projector's own `order_timeline` — the read model, not a write model. No MySQL client exists (see F2 for what actually enforces that).
- [x] No shared runtime code beyond `shared-kernel` and `contracts` (`contracts-aliases.ts` re-exports generated types only).
- [x] `packages/shared-kernel` untouched.
- [x] Every interaction correctly classified: NATS-RPC for the six command/query subjects; the SSE feed is a NATS **core subscription** on the projector's update signal, which is neither a fact nor an RPC and is correctly not on Kafka. The gateway registers no `@MessagePattern`/`@EventPattern` at all, so the `Transport`-naming rule is vacuously satisfied.
- [x] No stray debug logging (three `console` calls, all deliberate: the structured error line, the signal-decode warning, the boot banner). No context-free TODOs.

### C4 — Verification is real
- [x] lint + typecheck + unit test pass for this package.
- [x] Domain tests are pure.
- [x] Integration tests use Testcontainers against real NATS and real MongoDB, never mocked brokers. **But see F1** — real *brokers* is not the same as real *counterparties*, and this suite has none.
- [x] Coverage thresholds met (92.79% statements overall; every `domain/` file with a spec at 100% statements).
- [x] No Jest.

### C5 — The session closed cleanly
- [x] No suspicious untracked files. Every mutation I armed is reverted; `git status --porcelain` at the end of this review is byte-identical to its state at the start.
- [ ] **`progress/history.md` has no entry for `gateway_rest_auth`, and therefore no effort record.** A feature without an effort record is not closeable (assessment #7 baseline). Leader's.
- [ ] **`feature_list.json` did not reflect the true state** — id 25 was left `pending` after a full implementation pass. Corrected to `in_progress` by this verdict.
- [x] The implementer's record states what was done and how to test it manually.
- [x] Claude did not commit.

### C6 — Spec-Driven Development
- n/a for this feature (`sdd: false`). The three `specs/shared/` documents it is measured against all exist and were read.
- [ ] "Every `R<n>` is covered by at least one concrete named test, recorded in `specs/shared/test-matrix.md`" — recorded, but **overclaimed**: see F6.

### C7 — Trilogy reusability
- [x] `specs/shared/openapi.yaml` untouched by this feature (verified: not in `git status`).
- [x] `n8n/` untouched.
- [ ] Effort records complete and honest — blocked by C5 above.

---

## Probe 1 — the contract test. What it does and does not detect.

**Both directions genuinely fire, and both name the offending route.** I re-armed each independently.

Direction A — I commented out `OrdersController`'s `@Get(':id')` handler:

```
AssertionError: spec routes the running app does NOT expose: GET /orders/{id}: expected [ 'GET /orders/{id}' ] to deeply equal []
 ❯ src/contract-drift.integration.spec.ts:63:105
```

Direction B — I restored that and instead added a stray `@Get('debug')` to `HealthController`:

```
AssertionError: app routes NOT documented in openapi.yaml: GET /health/debug: expected [ 'GET /health/debug' ] to deeply equal []
 ❯ src/contract-drift.integration.spec.ts:64:95
```

The two assertions are sequential, so a run with **both** mutations only reports the first — worth knowing when reading a future failure, not a defect.

The introspection is real: `extractExpressRoutes` walks `app.getHttpAdapter().getInstance().router.stack` of a booted app, and the spec side is `js-yaml`-parsed from the file itself. Neither side is a hand-copied list. The `appRoutes.length > 10` non-vacuity guard is present and meaningful.

**It detects:** a documented `{method, path}` the running app does not register; a registered `{method, path}` not in `openapi.yaml`. Nothing else.

**It does not detect:**

- **Response status codes.** I left `@HttpCode(418)` on `POST /stock/replenish` in place across *both* mutated runs. The contract test never mentioned it.
- **Request or response schemas** — body shapes, required fields, `Money` minor units, enum values.
- **Parameters** — names, `in: query|header|path`, types, defaults, `minimum`/`maximum`. `GET /orders`'s `status` array, `GET /stock`'s `belowThreshold`, `IncludeDisabled`, `Page`/`PageSize` are all invisible to it.
- **Headers** — `Location`, `X-Correlation-Id`, `Retry-After`, `Idempotent-Replay`, `Cache-Control: no-cache`, `Connection: keep-alive`.
- **Content types** — `application/problem+json` vs `application/json` vs `text/event-stream`.
- **Security requirements** — which operations carry `security: []`.
- **Anything not registered as a top-level Express route layer.** `extractExpressRoutes` reads `layer.route` only and never descends into `layer.handle.stack`, so a route mounted on a nested router or as middleware is invisible in *both* directions. `GET /docs` is hand-exempted for exactly this reason — which means the same hole would silently hide an *undocumented* middleware route too.

**Partial mitigation, and it is real:** `ListStockHandler`, `ListInvoicesHandler`, `ListCreditsHandler` and `ListCatalogHandler` each declare `Promise<GatewayComponents['schemas'][…]>` and return the asyncapi reply payload type, so `tsc` checks those two generated shapes are assignable. That covers reply *bodies* for the RPC pass-through endpoints. It covers no status code, no parameter, no header, and nothing on the read-model or command endpoints.

**Ruling on acceptance criterion 1:** the criterion says "no drift". The test asserts no *route* drift. It is a good test, correctly armed, and materially weaker than the criterion it is cited for. That is a documentation defect in the acceptance record, not grounds for rejection on its own — but it must be stated plainly rather than left as "contract test asserts no drift".

---

## Probe 2 — `GET /orders/{id}` always answers 202. My ruling: **a genuine defect, MEDIUM, and the stated justification is over-stated.**

`GET /orders/00000000-0000-4000-8000-000000000000` returns **`202 Accepted`**, `Retry-After: 2`, body `{ orderId, status: 'projection_pending', message: 'The order was accepted and is not projected yet…', retryAfterMs: 2000 }`. Verified by reading `orders.controller.ts:74-92` and by `orders.integration.spec.ts:70-78`, which uses a fresh `randomUUID()` and asserts exactly this.

**It should not.** R55's clause is scoped: *"WHILE no read-model document yet exists for an order identifier **that the caller has just been given**"*. A caller who was never given that id is not in that clause. And `openapi.yaml` `/orders/{id}` says so explicitly, in the operation's own description: *"A genuine `404` means the identifier is unknown to the system."* The implementation makes that documented `404` **unreachable**. Since `openapi.yaml` is this feature's spec of record, an unreachable documented response is a spec deviation.

The implementer's defence — *"a gateway with no memory of which order ids it has ever issued has no way to ask Orders 'does this id exist at all'"* — is true about the RPC surface and **false about the gateway**. The gateway is precisely the component that hands the caller the id: `OrdersController.placeOrder` returns it and sets `Location: /orders/{id}`. "An order identifier the caller has just been given" is, by construction, an identifier *this service just gave them*. The honest answer is available without any new RPC subject:

- Answer `202` for an id absent from the read model **that this gateway itself issued within a bounded recency window** (a small TTL map, or simply the `Retry-After` budget), and `404` otherwise; or
- if a process-local memory is judged unacceptable across replicas, say so in the record and answer `404` for the unknown case, because a false `404` for an id the caller cannot have has no victim, whereas an indefinite false `202` teaches every client to retry forever on a typo.

Either is defensible. "Always 202" is the one option that contradicts the written contract. And the test that locks it in (`orders.integration.spec.ts:70`) is titled as an R55 proof while asserting something R55 does not require.

**Not blocking on its own.** It is a conscious, documented, conservative choice, and the read model genuinely cannot distinguish the two cases by itself. But the framing must change from "cannot" to "chose not to", and the `404` must either become reachable or be struck from the contract by an explicit ruling.

---

## Probe 3 — R54, no write database. **Substantively holds. The dedicated guard greps, and the grep has a hole that matches this repo's own import idiom.**

I armed the forbidden import in the form **every other service in this repository actually uses** — `apps/billing/src/infrastructure/persistence/client.ts:5-6`, `apps/billing/.../migrator.ts:10-12`:

```ts
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
```

…prepended to `apps/gateway/src/infrastructure/persistence/mongo-client.ts`, then ran the guard:

```
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

**The guard reports green.** `no-write-database-client.spec.ts:70` tests `text.includes("'mysql2'")` — a substring with **both** quotes. `'mysql2/promise'` does not contain it. Neither does `'drizzle-orm/mysql2'` contain `'drizzle-orm'`. The implementer's own armed mutation (recorded in the impl notes as `import 'mysql2'`) used the single form the check happens to catch. This is the Phase 11 OI12 lesson repeating: a text-matching guard that passes its author's chosen mutation and fails nobody else's.

**What actually enforces R54 — and it does execute.** I ran `pnpm typecheck` with the same mutation armed:

```
src/infrastructure/persistence/mongo-client.ts(1,19): error TS2307: Cannot find module 'mysql2/promise' or its corresponding type declarations.
src/infrastructure/persistence/mongo-client.ts(2,25): error TS2307: Cannot find module 'drizzle-orm/mysql2' or its corresponding type declarations.
```

and confirmed `apps/gateway/node_modules/mysql2` and `.../drizzle-orm` do not exist. Under pnpm's strict `node_modules`, a source file in this package **cannot resolve** either package, in any import form, and both `tsc` and the runtime say so. Adding the dependency to make it resolve would trip the guard's *first* assertion (`package.json` declares neither), which is a real structural property and is sound.

So: **R54 is enforced, by the manifest check plus pnpm isolation, and I verified that enforcement by execution.** The second assertion of the guard spec is decorative and, worse, *misleadingly* named — `specs/shared/test-matrix.md` now cites it as "behavioural, walks the live filesystem" (see F6). Fix the substring check (match the import specifier's *prefix*, or parse the imports) or delete it and let the manifest assertion carry the row honestly.

I also confirmed by reading that `GET /orders` and `GET /orders/{id}` reach only `MongoOrderReadModelAdapter` (`find`/`findOne`/`countDocuments` on `order_timeline`, with `statusRank`/`processedEventKeys` projected out), and that `orders.integration.spec.ts` starts **no MySQL container of any kind** — a write-model read in that suite is structurally impossible, not merely unobserved. Acceptance criterion 3 is met.

---

## Probe 4 — the payment correlation-id resolution. **The feature-22 gap is genuinely closed. The bound is 1000 invoices, and past it the failure is loud but mislabelled.**

The bound: `INVOICE_SCAN_MAX_PAGES = 5` × `INVOICE_SCAN_PAGE_SIZE = 200` = **1000 invoices**, and `billing.invoice.list` orders `desc(invoiceDate), desc(invoiceReference)` (`apps/billing/src/infrastructure/persistence/invoice-read.repository.ts:47`) with `pageSize` capped at 200 by its DTO (`invoice.dto.ts:153`). So the scan covers the **1000 most recently issued invoices** and no more.

**Beyond the bound it fails loudly, not silently** — `InvoiceNotFoundError` → `404 NOT_FOUND`, `"no invoice for id \"…\""`. That is the right *shape*: it never proceeds with a fabricated correlationId. Two problems remain:

1. **The 404 is a false statement.** The invoice exists; the gateway simply stopped looking. `openapi.yaml` `/invoices/{id}/payments`'s `404` is `NotFound` — "the identifier is unknown". A payment against a legitimately old invoice gets told the invoice does not exist. A `503`/`507`-class "could not resolve within the scan budget" would be honest; a `404` is not.
2. **The multi-page path is untested.** Every test — unit (`register-payment.command.spec.ts:65, 89, 109, 118`) and integration (`billing-fulfillment.integration.spec.ts:160-177`) — scripts a **single** page. Neither `INVOICE_SCAN_MAX_PAGES` nor the early-break condition `listReply.items.length < INVOICE_SCAN_PAGE_SIZE` is exercised by anything. The loop that is the whole point of the mitigation is unguarded.

**The gap it was supposed to close is closed, and closed well.** `register-payment.command.spec.ts:116-125` proves the branch that matters: when the read model has no document for the resolved `orderReference`, the handler throws `OrderNotYetProjectedError` and `billing.payment.register` is **never called** (`expect(rpc.calls.map(c => c.subject)).toEqual([INVOICE_LIST_SUBJECT])`). And `billing-fulfillment.integration.spec.ts:218-219` asserts the correlationId on **real NATS headers**, not on a fake. The implementer's armed-deletion evidence for this branch reproduces. This is the strongest-guarded part of the feature.

**Ruling: the gap is closed, not moved.** F4 below is about the bound's failure mode and its missing test, not about the resolution itself.

---

## Probe 5 — auth

- **`JWT_SECRET` is never logged.** Three `console` calls exist in the whole service; none touches config. `problem-json.filter.ts:41` logs `{ level, correlationId, code, status, message, occurredAt }` — `message` is the thrown error's own message, and `problem-json.filter.spec.ts:96` asserts the serialised problem body contains no `'secret'`. Clean.
- **The guard rejects missing, malformed, wrong-signature, wrong-issuer and expired tokens.** `jwt-auth.guard.spec.ts` covers missing header and invalid token; `jwt-token.adapter.spec.ts` covers all five verification failures against the **real** `jsonwebtoken` adapter (different secret, different issuer, garbage, `expiresIn: '-1s'`); `auth.integration.spec.ts:46` proves an unauthenticated `GET /orders` is `401 application/problem+json`. Well guarded.
- **Exactly four routes are unauthenticated, and they are the right four.** `@Public()` appears on exactly three handlers — `AuthController.login`, `HealthController.live`, `HealthController.ready` — and nowhere at class level. `GET /docs` is raw Express middleware mounted before Nest's router (`setup-docs.ts:17`), so the `APP_GUARD` never sees it. That is precisely `openapi.yaml`'s four `security: []` operations (lines 117, 833, 852, 875). **No test asserts this exhaustively**, though — see F8. The invariant currently holds by grep, not by execution.
- **Credentials are hardcoded in a tracked file.** `infrastructure/auth/operator.config.ts:14-16` defaults to `operator` / `otc_operator_dev_password` / `Order-To-Cash Operator`. `.env.example` is byte-untouched (`git diff --stat .env.example` → empty) and carries no `GATEWAY_OPERATOR_*` key at all. See F5.

---

## Probe 6 — the SSE stream

- **Bounded replay buffer: correct and well tested.** `ReplayBuffer` evicts oldest-first, and `replay-buffer.spec.ts:28` proves the openapi-documented boundary directly — capacity 2, three pushes, `c1` evicted → `replayAfter('c1')` is `{ resumed: false, missed: [] }` while `replayAfter('c2')` is `{ resumed: true, missed: ['c'] }`. Capacity enforcement and a non-positive-capacity rejection are covered too.
- **`Last-Event-ID` resumes after the cursor, over real HTTP and real NATS.** `stream.integration.spec.ts:139-170` disconnects a client, publishes a frame it therefore misses, reconnects with the cursor, and asserts `resumed: true`, `cursor === cursorAfterFirstFrame`, and the missed `timeline.appended` frame replayed. Correct: `replayAfter` returns `entries.slice(index + 1)` — strictly *after*.
- **Exhausted / unknown buffer yields `stream.ready` with `resumed: false`, not silence and not an error.** `stream.integration.spec.ts:172-178` sends `Last-Event-ID: not-a-real-cursor` and gets a 200 stream with `resumed: false`. `replay-buffer.spec.ts:38` makes the aged-out and never-issued cases explicitly indistinguishable, which is the honest behaviour openapi.yaml describes.
- **Exact headers verified** against the contract's `const` values: `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive` (`stream.integration.spec.ts:101-103`). The deliberate bypass of Nest's `@Sse()` is correctly reasoned — `@Sse()` sends a longer `Cache-Control` than the contract's `const: no-cache`.
- **The heartbeat is not tested at all.** See F7.
- **The route-order bug is genuinely fixed, and guarded — but only incidentally.** I regressed `app.module.ts`'s `controllers` array to register `OrdersController` before `StreamController` and re-ran the stream suite: **all four tests failed**, the first with `AssertionError: expected 400 to be 200`. So the regression cannot land silently. But no test *names* the invariant, and the failure message ("400 to be 200") does not lead a reader to controller registration order — only the comment in `app.module.ts:97-102` does. See F9.

---

## Probe 7 — stubbed responders. **The claim is true of the repo. The client side is correct for two of the three. For `orders.create` it is not, and that is F1.**

Repo sweep confirms the implementer's two recorded gaps exactly:

- **`catalog.reference.list`** — zero occurrences anywhere outside `apps/gateway`. No responder exists. `GET /catalog/*` correctly answers `503 UPSTREAM_UNAVAILABLE` via `ErrorCode.NoResponders`, and that is proven in integration. Honest.
- **`orders.cancel`** — zero occurrences outside `apps/gateway`. The full set of registered `@MessagePattern` subjects in this repo is: `orders.create`; `fulfillment.stock.{check,reserve,release,list,replenish}`; `fulfillment.despatch.create`; `billing.invoice.{issue,list}`; `billing.payment.register`; `billing.credit.{hold,list}`. Honest.

**But "stubbed" is not the risk here — "stubbed with the wrong wire" is, and one stub is.**

`apps/fulfillment/src/main.ts:28-35` and `apps/billing/src/main.ts:29-34` install `BareJsonNatsDeserializer` + `BareJsonNatsSerializer`, so those services genuinely speak the bare-JSON wire the gateway's `NatsRpcClientAdapter` sends. `fulfillment.stock.list`, `fulfillment.stock.replenish`, `billing.invoice.list`, `billing.payment.register` and `billing.credit.list` are therefore correct against the real services, and the bare-JSON stubs used to test them encode the right wire.

**`apps/orders/src/main.ts:24-27` does not:**

```ts
app.connectMicroservice<MicroserviceOptions>({
  transport: Transport.NATS,
  options: { servers: [...natsConfig.servers] },   // no deserializer, no serializer
});
```

See F1 for the probe and the consequence. The same trap is now armed for `orders.cancel`: whoever writes that responder inherits `apps/orders`' current framework-default configuration, and the gateway's stub has already recorded the *opposite* wire as correct.

---

## Probe 8 — scope. **Clean.**

`git status --porcelain` is confined to `apps/gateway/**`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `specs/shared/test-matrix.md` and `progress/impl_gateway_rest_auth.md`. **No other app, no `packages/`, no other `specs/` file is touched** — including `openapi.yaml`, `asyncapi.yaml` and `requirements.md`, all byte-identical.

`git diff --numstat pnpm-lock.yaml` → **448 additions, 0 deletions**, and `git diff -U0 | grep '^-'` returns nothing but the `---` header. **No version bump of any existing package.** The nine catalog additions are all new entries, each with a rationale comment.

`pnpm-workspace.yaml` also gains `allowBuilds['@scarf/scarf']: false`, which is one line outside "catalog entries only" but is declared in the impl record and is the correct call for an anonymous install-telemetry postinstall.

The deletion of the scaffold's `app.controller.ts`/`.spec.ts` (root `GET /`) is right: an undocumented route that would have failed the contract test.

---

## `openapi.yaml`'s 18 operations → route → test

17 `paths:` keys, **18** operations (the contract test's own title says "20 operations" — see F11).

| # | Operation | Route | Named test |
|---|---|---|---|
| 1 | `POST /auth/login` | `AuthController.login` | `auth.integration` › *POST /auth/login is unauthenticated and issues a bearer token…*, *…answers 401 problem+json on bad credentials*; `login.command.spec` |
| 2 | `GET /auth/me` | `AuthController.me` | `auth.integration` › *GET /auth/me describes the operator once authenticated*; `get-current-user.query.spec` |
| 3 | `POST /orders` | `OrdersController.placeOrder` | `orders.integration` › *R13 — POST /orders translates to orders.create…* (**stub only — F1**), *…409 with shortages*, *…503 when no responder*, *…400 VALIDATION_FAILED*; `place-order.command.spec` |
| 4 | `GET /orders` | `OrdersController.listOrders` | `orders.integration` › *R53/R54 — GET /orders excludes a placeholder document…*; `list-orders.query.spec`; `mongo-order-read-model.adapter.spec` |
| 5 | `GET /orders/{id}` | `OrdersController.getOrder` | `orders.integration` › *R54 — …returns the projected document…*, *R55 — …answers 202 projection pending, not 404* (**F3**), *…rejects a malformed id with 400*; `get-order.query.spec` |
| 6 | `POST /orders/{id}/cancel` | `OrdersController.cancelOrder` | `orders.integration` › *R27/R28 — …correlationId = the KNOWN order id…* (**stub only; no live responder**); `cancel-order.command.spec` |
| 7 | `GET /orders/stream` | `StreamController.stream` | `stream.integration` × 4 (live frame, `orderId` filter, known-cursor resume, unknown-cursor `resumed:false`); `replay-buffer.spec`, `cursor.spec`, `stream-hub.spec`. **`ping` untested — F7** |
| 8 | `GET /stock` | `StockController.listStock` | `billing-fulfillment.integration`; `list-stock.query.spec` |
| 9 | `POST /stock/replenish` | `StockController.replenish` | `billing-fulfillment.integration` › *R61 — POST /stock/replenish translates to fulfillment.stock.replenish*; `replenish-stock.command.spec` |
| 10 | `GET /invoices` | `InvoicesController.listInvoices` | `billing-fulfillment.integration`; `list-invoices.query.spec` |
| 11 | `POST /invoices/{id}/payments` | `InvoicesController.registerPayment` | `billing-fulfillment.integration` › *…correlationId…*, *…404 when no invoice matches*; `register-payment.command.spec` × 4. **Scan bound untested — F4** |
| 12 | `GET /credits` | `CreditsController.listCredits` | `billing-fulfillment.integration`; `list-credits.query.spec` |
| 13-15 | `GET /catalog/{products,retailers,companies}` | `CatalogController` × 3 | `billing-fulfillment.integration` › *every catalog endpoint answers 503 …without a live responder*; `list-catalog.query.spec`. **No live responder — recorded gap, honest** |
| 16 | `GET /health/live` | `HealthController.live` | `auth.integration` › *GET /health/live and GET /health/ready are unauthenticated…*; `health-checks.spec` |
| 17 | `GET /health/ready` | `HealthController.ready` | same; `health-checks.spec`. **The 503 branch is not exercised end-to-end** |
| 18 | `GET /docs` | `setup-docs.ts` middleware | `contract-drift.integration` › *GET /docs answers 200 text/html…* |

**R → test:** R13 ✔, R26/R42 ✔, R27/R28 ✔ (stub), R47–R49 ✔, R54 ✔ (see F2 for what enforces it), R55 ✔ gateway half (see F3 for the scope overreach), R58 partial ✔ (declared), R60 ✔, R61 ✔ (stub — F6).

**Acceptance criteria:**
1. *"contract test asserts no drift from openapi.yaml"* — **partially met.** No *route* drift, proven both ways. No schema, status, parameter or header coverage. Restate the criterion or extend the test.
2. *"RPC timeouts mapped to HTTP status codes"* — **met.** `RpcTimeoutError` → `503 UPSTREAM_TIMEOUT`, `RpcTransportError` → `503 UPSTREAM_UNAVAILABLE`, `RpcBusinessError` → the specific code via `classifyRpcError`, with `details.code` overrides for the five contract-named business codes. `problem-json.filter.spec` and `rpc-error-mapping.spec` cover it; `orders.integration` › *…503 when no orders.create responder is subscribed* proves it over a real broker.
3. *"list/detail served from MongoDB, never from a write DB"* — **met**, verified by execution (Probe 3).

---

## Findings

### BLOCKING

**F1 — CRITICAL — `POST /orders` cannot work against the real Orders service. The stub encodes a wire `orders.create` does not speak, and the order is created anyway while the caller is told 503.**
*Files:* `apps/gateway/src/infrastructure/messaging/nats-rpc-client.adapter.ts:55`; `apps/orders/src/main.ts:24-27`; `apps/gateway/src/orders.integration.spec.ts:126`; `apps/gateway/src/test-support/stub-rpc-responder.ts`.

The gateway sends bare JSON (`JSONCodec.encode(payload)`). `apps/fulfillment/src/main.ts:28-35` and `apps/billing/src/main.ts:29-34` install `BareJsonNatsDeserializer`/`BareJsonNatsSerializer` for exactly this reason — the deserializer's own header states the finding: *"`ServerNats` treats a bare (id-less) JSON request as an EVENT (never replies)"*. **`apps/orders/src/main.ts` installs neither.**

I probed it against a disposable `nats:2.14.5-alpine`, with a Nest NATS microservice configured byte-identically to `apps/orders/src/main.ts`:

```
HANDLER INVOKED, side effect would happen
BARE-JSON ERROR: TIMEOUT TIMEOUT
HANDLER INVOKED, side effect would happen
NEST-ENVELOPE REPLY: {"response":{"orderId":"x","orderReference":"ORD-000001", …},"isDisposed":true,"id":"1"}
```

Two independent failures, in sequence:

1. **No reply at all.** Nest's default `NatsRequestJSONDeserializer` → `IncomingRequestDeserializer.mapToSchema` yields `{ pattern, data }` with **no `id`**; `ServerNats.handleMessage` then branches `if (isUndefined(message.id)) return this.handleEvent(...)`. The handler **runs** — the order is placed and its outbox row written — and the reply subject is never answered. The gateway times out at `GATEWAY_RPC_TIMEOUT_MS` (5000) and returns **`503 UPSTREAM_UNAVAILABLE`/`UPSTREAM_TIMEOUT` for an order that exists**. The caller has no id, no `Location`, and every reason to retry — placing a second order.
2. **Even with (1) fixed**, Nest's default `NatsRecordSerializer` wraps the reply as `{"response":{…},"isDisposed":true,"id":…}`. The gateway's `isRpcErrorReply` sees no string `code`, so it returns that envelope **verbatim** as the HTTP 201 body — `PlaceOrderResponse` becomes `{ response, isDisposed, id }`.

**Why no test sees it:** `orders.integration.spec.ts` answers `orders.create` with `startStubResponder`, a raw `nats` subscriber the gateway's own author wrote to speak bare JSON — so the stub agrees with the caller and both disagree with production. `apps/orders`' own `orders-acceptance.integration.spec.ts:120` drives the responder through a Nest `ClientProxy` (`client.send(...)`), i.e. the **envelope** protocol. Each side is tested only against the wire it prefers. Nothing in the repository ever puts the two together.

**Why it matters:** this is acceptance criterion territory for the whole feature and for `saga_e2e_verification` (28). It also pre-arms the same trap for `orders.cancel`, whose future responder will inherit `apps/orders`' current configuration while the gateway's stub has already recorded the opposite wire as correct.

*Owner:* implementer for the gateway-side test that would have caught it; **leader** to route the actual fix, since it lands in `apps/orders/src/main.ts` — outside this feature's bounded scope. The fix is three lines: import `BareJsonNatsDeserializer`/`BareJsonNatsSerializer` (or the Orders-local equivalents) and pass them in `connectMicroservice`.

**Before re-review, one of:** (a) the fix lands in `apps/orders` **and** an integration test boots the real `OrdersCreateController` over a real NATS microservice using `apps/orders`' production `connectMicroservice` options and asserts the gateway answers `201` with a well-formed `PlaceOrderResponse`; or (b) if the fix is out of scope by ruling, a test that pins the *expected* wire (e.g. asserting `apps/orders/src/main.ts` configures the bare-JSON pair, in the same shape as the existing cross-service guards) **plus** an explicit blocking-defect entry naming the owning feature. Prose in an "open points" section is not sufficient for a defect that silently creates orders.

### MATERIAL

**F2 — MEDIUM-HIGH — the R54 guard's second assertion is a substring grep whose hole exactly matches this repo's own import idiom.** `apps/gateway/src/no-write-database-client.spec.ts:70`. `import mysql from 'mysql2/promise'` and `import { drizzle } from 'drizzle-orm/mysql2'` — the forms used in `apps/billing/src/infrastructure/persistence/client.ts:5-6` — pass the guard green (probe run above). The implementer's own armed mutation used `import 'mysql2'`, the one form it catches. R54 is nonetheless enforced by the manifest assertion plus pnpm's strict `node_modules` (verified by `tsc` TS2307), so this is not blocking — but it is the Phase 11 OI12 lesson repeating, and the matrix now cites this exact assertion as "behavioural" (F6). *Owner: implementer.* Fix by matching the specifier prefix (`'mysql2` / `'drizzle-orm`) or by parsing imports; re-arm with the subpath form.

**F3 — MEDIUM — `GET /orders/{id}` always answers 202, making `openapi.yaml`'s documented `404` unreachable, and the recorded justification is over-stated.** `apps/gateway/src/presentation/orders.controller.ts:74-92`; test at `orders.integration.spec.ts:70-78`. Full ruling in Probe 2. *Owner: implementer.* Either bound the 202 to ids this gateway itself issued (which is exactly R55's "just been given"), or answer 404 for the unknown case, or obtain an explicit gate ruling striking the 404 from the contract. Also retitle the test — it is cited as R55 evidence while asserting more than R55 requires.

**F4 — MEDIUM — the invoice scan's out-of-bound failure is a false `404`, and the multi-page loop has no test at all.** `apps/gateway/src/application/commands/register-payment.command.ts:97-115`. Bound is 5 × 200 = 1000, over `invoiceDate DESC`; the 1001st-oldest invoice gets `404 "no invoice for id …"` for an invoice that exists. Every test scripts a single page, so neither `INVOICE_SCAN_MAX_PAGES` nor the `items.length < PAGE_SIZE` early break is exercised. *Owner: implementer* for the tests and a truthful error for scan-budget exhaustion; *leader* for the durable fix (a `billing.invoice.get`-by-id subject or an `invoiceId` filter on `billing.invoice.list`) — correctly recorded as out of scope.

**F5 — MEDIUM — operator credentials are hardcoded as defaults in a tracked source file, and `.env.example` gives a deployer no signal to override them.** `apps/gateway/src/infrastructure/auth/operator.config.ts:14-16` defaults to `operator` / `otc_operator_dev_password`. `.env.example` is byte-untouched and carries no `GATEWAY_OPERATOR_*`, `GATEWAY_SSE_*` or `GATEWAY_RPC_TIMEOUT_MS` key. `JWT_SECRET` at least appears there (line 228) so its `change_me` default is visible; the operator password is not visible anywhere outside the source. The implementer flagged this and correctly declined to edit `.env.example` (leader scope). *Owner: leader.* Add the five `GATEWAY_*` keys to `.env.example` with the same `change_me` framing as `JWT_SECRET`.

**F6 — MEDIUM — `specs/shared/test-matrix.md` — a file assessments #8 and #9 inherit verbatim — now carries two overclaims.** (a) The R54 row describes `no-write-database-client.spec.ts` as *"(behavioural, walks the live filesystem)"*; F2 shows the filesystem half is a grep with a hole, and the load-bearing half is the manifest check. (b) The R54 row's own specified test, `gateway/integration/query-source.spec` › *"answers order list and detail queries with every write model disconnected"*, does not exist — different tests are substituted without the row saying so. (c) The R61 row is flipped to DONE on evidence that runs against a **stub** `fulfillment.stock.replenish` responder; that particular wire happens to be correct (Fulfillment installs the bare-JSON pair), but F1 shows the reasoning does not generalise and the row should say what it was tested against. *Owner: implementer* (or `test_maintainer`).

### MINOR

**F7 — LOW-MEDIUM — the SSE `ping` heartbeat has no test.** `apps/gateway/src/presentation/stream.controller.ts:65-67`. `ping` is a contract-declared event type (`openapi.yaml` `x-sse-events.ping`, `StreamPing`). The default interval is 15 000 ms and the integration harness never overrides `GATEWAY_SSE_PING_INTERVAL_MS`, so no test can reach it; `collectUntil`'s 5 s budget guarantees it never fires. The code is eight lines and correct by inspection — but delete `writeFrame(res, …, 'ping', …)` and the suite stays green. *Owner: test_maintainer.* Override the interval to ~200 ms in one test and assert two `ping` frames.

**F8 — LOW-MEDIUM — no test asserts that exactly four routes are unauthenticated.** `auth.integration.spec.ts` proves `GET /orders` is 401 and that `/auth/login`, `/health/live`, `/health/ready` are public; `contract-drift.integration.spec.ts` proves `/docs` is. Nothing asserts that `/orders/stream`, `/stock`, `/stock/replenish`, `/invoices`, `/invoices/{id}/payments`, `/credits`, `/catalog/*` and `/auth/me` **all** reject an anonymous request — a stray `@Public()` on any of them would land green. A loop over the introspected route set, skipping the four known-public entries and asserting 401, is a five-line test and closes the invariant by execution rather than by grep. *Owner: test_maintainer.*

**F9 — LOW — the route-order fix is guarded only incidentally.** `apps/gateway/src/app.module.ts:97-108`. Regressing the order fails all four `stream.integration` tests (`expected 400 to be 200`), so it cannot land silently — but nothing names the invariant, and the failure message does not point at controller registration order. A bug found by accident and fixed with only a comment tends to return. *Owner: test_maintainer.* One named case: *"GET /orders/stream is not swallowed by GET /orders/:id — StreamController must be registered first"*.

**F10 — LOW — a code comment cites a guard spec that does not exist.** `apps/gateway/src/infrastructure/persistence/mongo-client.ts:6-7` says enforcement is *"`read-model-write-guard.spec.ts` (Group B), which asserts no other file in this service imports `mongodb` for a write operation at all"*. No such file exists, and `no-write-database-client.spec.ts` asserts nothing of the kind. A comment promising a guard is worse than no comment. *Owner: implementer.*

**F11 — LOW — the contract test's third case has a false title.** `contract-drift.integration.spec.ts:79` claims *"17 `paths:` keys, 20 operations"*. There are **18** operations (I counted them with the same parser). The assertion it makes (17 path keys) is correct; only the title is wrong. Its header comment also says "eighteen paths" where it means eighteen operations. *Owner: test_maintainer.*

**F12 — LOW — a header comment points at a path that does not exist.** `apps/gateway/src/application/stream-hub.ts:11` cites `infrastructure/signal/nats-stream-signal.adapter.ts`; the file is at `infrastructure/messaging/nats-stream-signal.adapter.ts`. (The projector's own signal publisher *is* under `infrastructure/signal/`, which is probably where the confusion came from.) *Owner: implementer.*

**F13 — LOW — bookkeeping.** `progress/history.md` has **no `gateway_rest_auth` entry and therefore no effort record**, which alone forbids closing the feature. `progress/current.md` still describes `projector_read_model` (id 24) as the active `in_progress` feature with a Phase 12 goal — finding N11 from the previous review, still unfixed. `feature_list.json` had id 25 at `pending` through a completed implementation pass. *Owner: leader.*

**F14 — LOW, forward-looking — `GET /orders/stream` is reachable only by a client that can set an `Authorization` header.** The route is correctly non-`@Public()` and `openapi.yaml` correctly documents a `401` for it, so this is contract-conformant. But the browser `EventSource` API cannot set request headers, and the contract offers no query-parameter or cookie alternative. Feature 26 (`gateway_sse_push`) and 29 (`web_app`) will hit this on day one. Flagged now so it is a design decision then, not a surprise. *Owner: leader.*

---

## What must change before re-review

1. **F1 must be resolved or formally re-owned.** Either the `apps/orders` NATS (de)serializer pair lands and an integration test proves the gateway gets a real `201` from a real `OrdersCreateController` over a real broker, or a wire-pinning test plus an explicit blocking-defect entry naming the owning feature. A defect that creates an order and then reports `503` cannot be closed on prose.
2. **F2** — fix the forbidden-import check to catch subpath specifiers, and re-arm it with `'mysql2/promise'`, not `'mysql2'`.
3. **F3** — bound the `202` to ids this gateway issued, or answer `404`, or obtain a gate ruling striking the `404` from `openapi.yaml`. Retitle the test to match whatever is decided.
4. **F4** — make scan-budget exhaustion report something other than "no such invoice", and add a test that actually walks more than one page.
5. **F6** — correct the three overclaims in `specs/shared/test-matrix.md`; it is inherited verbatim by two other assessments.
6. **F5, F13** — leader: `.env.example` keys, the `history.md` effort record, `current.md` reset.
7. **F7–F12** — route to `test_maintainer` and a comment-correction pass; none of these needs the implementer's tier.

Findings **F5, F13, F14** and the durable half of **F4** are the leader's, not the implementer's. The re-review should re-run the contract-drift arming, the corrected R54 guard arming, and — above all — whatever test is offered as the answer to **F1**.

---

## Restoration statement

Every mutation armed during this review was reverted and verified. Files temporarily modified: `apps/gateway/src/presentation/{orders,health,stock}.controller.ts`, `apps/gateway/src/app.module.ts`, `apps/gateway/src/infrastructure/persistence/mongo-client.ts`. `git status --porcelain` at the end of this review is byte-identical to its state at the start, and `eslint` (0), `typecheck` (0) and `pnpm test` (27 files / 101 tests) were re-run afterwards to confirm. The disposable `nats:2.14.5-alpine` probe container was removed. No file under `apps/` or `packages/` was patched. No commit was made.

---

# Round 2 — re-review after the three-agent fix pass

**Verdict: REJECTED — but on close-out artefacts only. Every code defect from Round 1 is closed, and I verified each one by execution rather than by reading.** No new code defect was found. What blocks is C5 bookkeeping (no effort record) plus one spec-file staleness that the three concurrent agents introduced between them — which is exactly the composition failure this round was asked to look for.

This is the same standard applied to `billing_invoicing` (21) and `projector_read_model` (24), the latter *"the first whose rejection contained zero code defects"*. Applying a softer one here would make those rejections arbitrary. The engineering is done; re-review is an artefact check, not another code pass.

## What I ran

Targeted only. Not re-run: the repo-wide suite, `pnpm quality`, the other eight packages.

- `vitest run src/no-write-database-client.spec.ts` — **four times** (baseline; with both forbidden packages made genuinely resolvable; with both import forms armed in source; after cleanup).
- `pnpm --filter @otc/gateway typecheck` — with the import forms armed.
- Hand-run `node -e "require.resolve(…)"` from `apps/gateway/src`, six specifiers, **with and without** a hoisted `NODE_PATH`.
- `vitest run --config vitest.integration.config.mts src/orders-create-wire.integration.spec.ts` (apps/orders) — **twice**: baseline, and with the bare-JSON pair removed.
- `vitest run --config vitest.integration.config.mts src/orders.integration.spec.ts` (apps/gateway) — **twice**: baseline, and with `GATEWAY_ISSUED_ORDER_WINDOW_TTL_MS=1` forced from outside the code.
- `vitest run src/read-model-sole-writer.spec.ts` (apps/projector) — **four times**, arming a reader and two writer forms **the author did not arm**, in a **fourth** app.
- `pnpm --filter @otc/gateway test` → 28 files / **114 tests**; `eslint` 0; `typecheck` 0; `pnpm build` 0.
- Static: byte-comparison of the three `bare-json-nats.*` copies; a re-implementation of the projector guard's own scan to confirm its importer/writer partition; `tsconfig.build.json` exclude patterns across four services; `git status`/`git diff` scope walk.

## F2 — the new guard. **Closed, and it is the strongest guard in the feature.**

The predecessor was the third text-guard hole this project has found. The replacement is not a text guard at all.

**It executes.** `resolvesInARealNodeProcess` spawns a genuine `node` child (`execFileSync(process.execPath, ['-e', 'require.resolve(…)'])`) from `apps/gateway/src`, with `NODE_PATH` stripped from the child's environment.

**The `NODE_PATH` strip is load-bearing, and I confirmed the author's account of why.** Running the identical call by hand:

```
--- plain node, no NODE_PATH ---
mysql2                 MODULE_NOT_FOUND
mysql2/promise         MODULE_NOT_FOUND
drizzle-orm            MODULE_NOT_FOUND
drizzle-orm/mysql2     MODULE_NOT_FOUND
mongodb                RESOLVED …/mongodb@7.5.0/node_modules/mongodb/lib/index.js
nats                   RESOLVED …/nats@2.29.3/node_modules/nats/index.js
--- with a hoisted NODE_PATH (what vitest injects) ---
mysql2                 RESOLVED-VIA-NODE_PATH
drizzle-orm            RESOLVED-VIA-NODE_PATH
```

So the reported first attempt really was broken, really did produce a false green, and the strip really is what makes the child representative of `node dist/main.js`. That is a better failure than most guards ever get: the author found their own guard lying and rewrote it.

**Does it fail for the right reason?** I made the property genuinely false — created `apps/gateway/node_modules/{mysql2,drizzle-orm}` with real `package.json`/entry files — and re-ran:

```
× mysql2 and drizzle-orm cannot be resolved … in bare OR subpath form
AssertionError: expected [ …(4) ] to deeply equal []
+   "\"mysql2\" resolved to: …/apps/gateway/node_modules/mysql2/index.js",
+   "\"mysql2/promise\" resolved to: …/apps/gateway/node_modules/mysql2/promise.js",
+   "\"drizzle-orm\" resolved to: …/apps/gateway/node_modules/drizzle-orm/index.js",
+   "\"drizzle-orm/mysql2\" resolved to: …/apps/gateway/node_modules/drizzle-orm/mysql2/index.js",
```

All four specifiers named, with resolved paths — **including both subpath forms that defeated the predecessor**. Not a spawn failure, not an environment artefact: the two other cases in the file passed in the same run, so the child process itself was demonstrably working.

**Does a passing run prove resolvability?** Yes, and by two independent routes. The file's own third case asserts `mongodb` and `nats` *do* resolve through the identical mechanism, and my hand-run above confirms it from the shell. The check cannot be vacuously always-failing.

**One characterisation, not a defect.** The guard's subject changed: it now asserts the *enabling condition* (unresolvability) rather than the *absence of an import*. I armed both import forms in `mongo-client.ts` and the spec stayed green (3 passed) while `pnpm typecheck` died with `TS2307` on both lines. That is sound — an unresolvable import cannot construct a client, and `pnpm build` cannot ship one — and the test's own name says exactly what it tests (*"cannot be resolved from this service"*), so it is honestly labelled. Worth knowing when reading a future green.

## F1 — the fix, verified independently. **Closed.**

`apps/orders/src/main.ts` now installs the pair. The three copied files' **code bodies are byte-identical** across `fulfillment`, `billing` and `orders` (comments-and-blanks stripped: deserializer `ef55f4a2…`, serializer `2e2e9024…` in all three) — no drift smuggled in under the copy.

**Baseline:** `orders-create-wire.integration.spec.ts` — 4 passed, 15 s, against real MySQL + real NATS.

**Armed** (pair removed from the spec's `connectMicroservice` options):

```
× answers a bare-JSON request from a raw nats client … (the F1 regression)   10020ms
× answers a bare-JSON RpcError from a raw nats client …                      10010ms
NatsError: TIMEOUT
NatsError: TIMEOUT
Tests  2 failed | 2 passed (4)
```

Exactly the F1 failure mode — a 10-second silence, not a wrong reply.

**The `ClientProxy` claim — which is what keeps `pnpm order:place` working — I verified myself, and the evidence is stronger than the implementer claimed.** The two `ClientProxy` cases passed **both with and without** the pair (`2 passed` in the armed run above, `4 passed` in the baseline). So the fix is provably non-regressive for that caller under both configurations, not merely non-regressive under the new one. `scripts/place-order.mjs` uses `ClientProxyFactory` and is safe. The mechanism the implementer cited (`IncomingResponseDeserializer.isExternal` synthesizing `{ response, isDisposed }` for a non-enveloped reply) is consistent with what I observed, and — more to the point — the observation stands on its own without needing the framework-internals argument at all.

## Ruling on the F3 window

**The mechanism is correct and genuinely bounded.** `IssuedOrderWindow` is a `Map` with insertion-ordered eviction: `record()` evicts `keys().next().value` while `size > capacity` (default 10 000), and because every entry is stamped by the same clock, oldest-inserted is oldest-timestamped, so eviction order is correct. `isRecentlyIssued` also evicts on read when it finds an expired entry, so the map never answers `true` for a stale entry. **Bounded under load: yes — memory is O(capacity), not O(orders placed).** The TTL boundary is exact (`age > ttlMs`), and both sides of it are unit-tested.

**All three cases confirmed end to end**, the third by forcing the TTL from outside the code rather than editing anything:

| Case | Result |
|---|---|
| `POST /orders` → immediate `GET /orders/{id}` | **202** `projection_pending` + `Retry-After` (baseline, 10/10 green) |
| id never issued | **404** `{"code":"NOT_FOUND"}` problem+json |
| issued but TTL-expired (`GATEWAY_ISSUED_ORDER_WINDOW_TTL_MS=1`) | **404** `no order for id "a77d05db-…"` — and precisely one test flipped (`expected 404 to be 202`), the other nine unaffected |

**Is 404-after-TTL honest for an order that exists but has not projected?** **Yes, and it is the better of the two available lies.** After five minutes the gateway genuinely no longer knows the id — it evicted the only evidence it ever had — and `openapi.yaml`'s `404` is defined as *"the identifier is unknown to the system"*, which by then is a true statement *about the answering component*. The alternative, an unbounded 202, tells a client to keep retrying forever and is indistinguishable from a typo. Five minutes is also correctly chosen: two orders of magnitude above realistic outbox→Kafka→projector lag, so the 404 only appears once something is genuinely broken, at which point a hard error is more useful than an eternal "soon". I accept the design.

**One thing about it is not recorded, and should be — G3 below.** The window is process-local. Behind two gateway replicas, `POST /orders` on replica A followed by `GET /orders/{id}` on replica B yields **404 immediately**, for an order accepted seconds earlier — a sharper failure than the TTL case and not a function of the TTL at all. This project has already ruled multi-replica gateways in scope: feature 24 chose a NATS core publish over a Kafka topic for the update signal precisely because *"a shared Kafka consumer group delivers each signal to exactly one Gateway replica, a bug invisible at one replica and guaranteed at two."* The same standard applies here. Nothing in the code, the config or the records mentions it.

## Ruling on the `*.spec.ts` / `test-support/` exclusion

**The `*.spec.ts` exclusion is sound. The `test-support/` exclusion is not — for two of the four services, and by a margin I could measure.**

`*.spec.ts` is excluded from `tsconfig.build.json` in **every** service, so a spec file is never a root of the production build. "A production writer smuggled into a `*.spec.ts`" is close to a contradiction: it cannot reach `dist/main.js` unless production code imports it by name, which is visible on its face. Accept.

`test-support/` is different. `apps/orders` and `apps/billing` exclude `src/**/test-support/**` from their build; **`apps/gateway` and `apps/projector` do not** — they exclude only `src/**/*.spec.ts`. I ran `pnpm build` in `apps/gateway` and `dist/test-support/` exists, with `extract-express-routes.js`, `fake-issued-order-window.js`, `fake-order-read-model.js` and friends emitted. So for exactly the two services this guard most concerns — the read model's writer and its reader — `test-support/` **is** compiled build output, and a Mongo write placed there would be shipped and invisible to the guard.

**No current violation:** I scanned both `test-support/` trees for the guard's full write-method list and found nothing. So this is a latent hole, not an open wound. The cheap fix is not to change the guard at all but to add `"src/**/test-support/**"` to `apps/gateway`'s and `apps/projector`'s `tsconfig.build.json` excludes, matching the other two — which makes the guard's exclusion sound *by construction* rather than by assumption, and shrinks two `dist/` outputs as a bonus. Named as G4, LOW.

**The guard itself is otherwise excellent, and I armed it harder than its author did.** In a **fourth** app (`apps/fulfillment` — neither the projector, nor seed, nor the `notifications` fixture the file uses):

- a **reader** (`countDocuments` + `find().toArray()`) → **8 passed**, not reported;
- a **writer** via `.replaceOne(` → **fails**, `unexpected MongoDB writer(s): fulfillment`;
- a **writer** via `.dropDatabase(` (DDL, also unarmed by the author) → **fails**, same message;
- fixture removed → **8 passed** again.

Both forms I chose are outside the five the file arms itself with, which means the write-method list is genuinely broad rather than curated to the examples. I also re-implemented the scan independently and confirmed the partition it relies on: importers `{gateway, projector, seed}`, writers `{projector, seed}`, **read-only importers `{gateway}`** — so the non-vacuity case really is about the gateway, and the PR20 amendment is doing real work.

## The other Round 1 findings

| # | Status |
|---|---|
| **F4** | **Closed.** `InvoiceScanBudgetExceededError` → **503 `SCAN_BUDGET_EXCEEDED`**, distinct from `InvoiceNotFoundError` → 404. The discrimination is right: a page shorter than `INVOICE_SCAN_PAGE_SIZE` means the list is genuinely exhausted (404 is a true statement); the bound reached with the last page still full means "may exist beyond the window" (503). The message no longer asserts non-existence — *"was not found within the N most recently issued invoices scanned — it may exist beyond this gateway's search window"*. Three new cases cover the multi-page walk, the early break and budget exhaustion. `Problem.code` is `type: string` with examples, not an `enum`, so `SCAN_BUDGET_EXCEEDED` is contract-legal, and `/invoices/{id}/payments` already documents a 503. |
| **F5** | **Closed in shape.** Six `GATEWAY_*` keys in `.env.example` and `.env`, with the `_change_me` framing `JWT_SECRET` already uses. Minor correction to the coordinator's summary: the code-level default is *not* gone — `operator.config.ts:18` still falls back — but it is now byte-identical to the visible template value, which is the established convention here and the right call. |
| **F6** | **3 of 4 corrected; a fifth introduced — G1 below.** The "behavioural" claim is now accurate and precisely described; the phantom `gateway/integration/query-source.spec` is disclaimed in-cell (*"on the structural evidence named here, not the operational sketch above"*); R61 now names the stub it was tested against and cross-references F1 as the instance of that exact risk. |
| **F7** | **Closed.** A dedicated `describe` with its own short ping interval; asserts ≥2 `ping` frames and a parseable `at`. |
| **F8** | **Closed.** *"exactly the four documented public routes reject nothing; every other registered route rejects an anonymous request with 401"* — the invariant now holds by execution, not by grep. |
| **F9** | **Closed.** A named case in the contract-drift spec asserting `streamIndex < orderIdIndex` on the live router — so a regression now names the invariant instead of saying "expected 400 to be 200". |
| **F10 / F11 / F12** | **Closed.** The phantom `read-model-write-guard.spec.ts` reference replaced with what actually enforces R54; "20 operations" corrected to 18 (I recounted: 17 path keys, 18 operations); the `infrastructure/signal/` path corrected to `infrastructure/messaging/`. |
| **F13** | **OPEN — and blocking.** See G0. |
| **F14** | Open by design (forward-looking, feature 26's). |

## Composition — three agents, one repo

**Scope is clean.** `apps/billing`, `apps/fulfillment`, `apps/notifications`, `apps/seed`, `apps/web` and all of `packages/` are byte-untouched. Every untracked path is under `apps/gateway/`, `apps/orders/` or `progress/`. The lockfile still shows 448 additions and 0 deletions — no version bump.

**One agent's change genuinely depended on another's, and it was handled correctly.** The gateway's new `mongodb` import made `apps/projector`'s PR20 guard report the gateway as an R54 offender — for doing exactly what R54's second half *requires*. The projector agent rewrote the guard from "who imports" to "who writes", amended `PR20` in `specs/projector_read_model/requirements.md` inline rather than silently, and recorded the ruling. That is the right resolution and it is honestly documented. The dependency is one-directional; nothing else couples.

**But the composition leaked in one place — G1.** The projector agent renamed the guard's `describe` and its case; the gateway agent, writing `specs/shared/test-matrix.md`'s R54 cell concurrently, still cites the **old** titles. Neither could see the other. Details below.

**A second, narrower drift, in `apps/orders`.** That service now holds two hand-mirrored copies of `main.ts`'s NATS options: the new wire spec (with the pair, matching production) and `orders-acceptance.integration.spec.ts:81` (without it, no longer matching production). Both pass — I proved `ClientProxy` is wire-agnostic here — so there is no false green today, but the service's *primary* `orders.create` integration test no longer exercises the shipped configuration. (`saga-integration-harness.ts` is Kafka-only and unaffected.)

## Findings

### BLOCKING

**G0 — the feature cannot be closed: `progress/history.md` has no `gateway_rest_auth` entry and therefore no effort record; `progress/current.md` still describes feature 24.**
This was **F13** in Round 1, marked leader-owned, and it has not moved. `progress/history.md`'s last entry remains `projector_read_model (id 24, phase 12)`. `progress/current.md` still opens *"**Feature:** `projector_read_model` (id 24, phase 12 …) **Status:** `in_progress` — rejected at review on bookkeeping only"* — the same **N11** carry-over now three reviews old. The effort record is the assessment #7 baseline for the trilogy benchmark and a feature without one is not closeable; `CHECKPOINTS.md` C5 says so and I am bound by it. This round is unusually worth recording well: three concurrent agents, a rejection round, and a guard that caught its own author lying to itself. *Owner: leader.*

### MATERIAL

**G1 — composition defect: `specs/shared/test-matrix.md`'s R54 **projector half** now names a test that no longer exists under that name.** The cell cites `read-model-sole-writer — PR20` › *"permits a mongodb import in apps/projector and apps/seed only"*. After the concurrent rewrite the describe is `read-model-sole-writer — PR20 (tests WHO WRITES, not who imports — R54)` and the case is *"permits a MongoDB **WRITE operation** in apps/projector (the writer this feature builds) and the allow-listed apps/seed only"*. Both the group and the case title are stale, and the stale wording is precisely the framing PR20 was amended to **reject**. This is the fourth matrix overclaim in two rounds, in a file `#8` and `#9` inherit verbatim, and it was produced by exactly the concurrency this round introduced: the gateway agent owned the cell, the projector agent owned the test, neither could see the other. *Owner: leader to route (one cell, `test_maintainer` tier).* The feature-24 entry in `progress/history.md` names the old title too — that one is a historical record of what was true then and may stand; the matrix is a live index and may not.

**G2 — `progress/impl_gateway_rest_auth.md` was not updated for Round 2 and now contradicts the shipped code.** mtime 14:20, i.e. before this review was even written (14:42); no Round 2 section exists. Its "Open points" still assert that `GET /orders/{id}` *"always answers 202 projection pending … the `404` response remains reachable only if a future feature adds a way to know an id is bogus"* (F3 made it reachable), that *"`.env.example` was not touched"* (F5 touched it), and its "How to test manually" block still tells the human to `curl` with `"password":"otc_operator_dev_password"`, which is no longer the configured value. CLAUDE.md's anti-telephone-game rule makes these files the deliverable, and this is the artefact the human reads before committing. Contrast `progress/impl_orders_bare_json_wire.md`, which is exemplary — it even flags, unprompted, that no spec in this repo imports `main.ts` and that it therefore armed the deletion in the spec's own mirrored options rather than in `main.ts`. *Owner: implementer (gateway).*

### MINOR

**G3 — the F3 recency window is process-local, and that assumption is recorded nowhere.** `IssuedOrderWindow` lives in one process's heap. With two gateway replicas, a `GET /orders/{id}` routed to the replica that did not serve the `POST` returns **404 immediately** for an order accepted seconds earlier — worse than the TTL case, and not fixed by tuning the TTL. Feature 24 already established that multi-replica gateways are a live design consideration in this project. A sentence in `issued-order-window.ts` and in the impl record stating the single-replica assumption (and, if wanted, naming sticky sessions or a shared store as the escape) is enough; I am not asking for a distributed implementation. *Owner: implementer.*

**G4 — `test-support/` is build output for `apps/gateway` and `apps/projector`, so the PR20 guard's exclusion of it is unsound for exactly those two.** `apps/orders`/`apps/billing` exclude `src/**/test-support/**` from `tsconfig.build.json`; gateway and projector exclude only `src/**/*.spec.ts`. Verified by building: `apps/gateway/dist/test-support/*.js` exists. No current violation (I scanned both trees against the guard's full write-method list). Fix in the two `tsconfig.build.json` files, not in the guard. *Owner: leader to route.*

**G5 — no parity guard for the three `bare-json-nats.*` copies.** Code bodies are byte-identical today (verified). This repo has established the mechanical-parity pattern twice already — `idempotent-consumer.parity.spec.ts`, `outbox-relay.parity.spec.ts` — and feature 24's own history entry records the lesson in as many words: *"when a pattern is copied across services, compare the copies mechanically."* Three copies is where that starts to pay. The orders implementer checked for such a guard first, found none, and recorded the decision to follow the existing `// COPY OF —` banner convention instead — the right call under the brief, and the right thing to escalate now. *Owner: leader.*

**G6 — no guard ties any `main.ts` to its bare-JSON pair.** Removing the pair from `apps/orders/src/main.ts` alone leaves every test green, because no spec imports `main.ts`; all three services hand-mirror the options. Pre-existing and symmetric across orders, fulfillment and billing, so not a Round 2 regression — but F1 *was* a `main.ts`-only defect, and the repo already has the precedent for guarding `main.ts` config (`main-shutdown-hooks.spec.ts`, `main-kafka-options.spec.ts`). *Owner: leader.*

**G7 — `orders-acceptance.integration.spec.ts:81` is now a stale mirror of `main.ts`** (no pair), while `orders-create-wire.integration.spec.ts:126` is a current one. No false green today. Folds naturally into G6. *Owner: test_maintainer.*

**G8 — `scripts/place-order.mjs`'s header is now false.** It states *"A hand-rolled bare-JSON request does NOT work here — Nest treats an id-less packet as a fire-and-forget event and never replies"* — true before F1, false for `apps/orders` since. It is the human's manual-test path and the comment is the reason someone would not try the simpler thing. *Owner: leader (outside `apps/`).*

## What must change before re-review

1. **G0** — the `progress/history.md` entry with its effort record; reset `progress/current.md`.
2. **G1** — one cell in `specs/shared/test-matrix.md`.
3. **G2** — a Round 2 section in `progress/impl_gateway_rest_auth.md`, and correct the three statements that now contradict the code.
4. **G3** — one recorded sentence about the single-replica assumption.
5. **G4–G8** — leader's call whether to land now or carry; none blocks.

**Nothing here needs another code pass.** Items 1–4 are artefact edits; item 5 is a routing decision. Re-review should be a file check, not a suite run.

## Restoration statement — Round 2

Temporarily modified and restored: `apps/gateway/src/infrastructure/persistence/mongo-client.ts`, `apps/orders/src/orders-create-wire.integration.spec.ts`. Temporarily created and removed: `apps/gateway/node_modules/{mysql2,drizzle-orm}` (stub packages), `apps/fulfillment/src/__reviewer-probe.ts`. All confirmed gone. `apps/gateway/dist/` was regenerated by a `pnpm build` run and is gitignored. `git status --porcelain` contains no probe artefact; every untracked path is under `apps/gateway/`, `apps/orders/` or `progress/`. Afterwards: `eslint` 0, `typecheck` 0, `pnpm test` 28 files / 114 tests. No file was patched to fix a defect. No commit was made. `feature_list.json` id 25 remains `in_progress`.

---

# Round 3 — final

**Verdict: APPROVED.** Every finding from Rounds 1 and 2 is closed or explicitly ruled. `feature_list.json` id 25 → `done`; the effort record is appended to `progress/history.md`.

Two advisories survive (**H1**, **H2**), plus the three carried by ruling (**G3**, **G6**, **G7**). None blocks; all are named with owners below.

## What I ran

Targeted only. Not re-run: `pnpm quality`, the repo-wide suite, the gateway integration suite (the coordinator's 1125/11-package figure is cited as reported, not verified by me).

- `bare-json-nats.parity.spec.ts` — **eight** runs: baseline, four hostile mutations of my own, two registry probes, restore.
- `bare-json-nats.spec.ts` in all three copy-owning services — to test the parity guard's soundness *premise*.
- Clean `pnpm build` of `apps/gateway`, `apps/projector`, `apps/notifications`, then a filesystem sweep of all six `dist/` trees.
- `apps/notifications` unit suite (its `tsconfig.build.json` changed) — 71 passed.
- **A live stack**: `apps/gateway`, `apps/orders` and `apps/fulfillment` each started from their own built `dist/main.js` against the running `otc-nats`/`otc-mysql`/`otc-mongodb`, and the documented manual-test recipe executed verbatim, plus a full `POST /orders` round trip.
- A mechanical re-derivation of every `apps/**.spec.ts` path cited anywhere in `specs/shared/test-matrix.md`, checked against disk.
- `git status`/`git diff` scope walk; lockfile numstat.

## G5 — the parity guard. **Independent result: it holds, in every direction I could bend it.**

The implementer armed it by perturbing a string literal in the **orders serializer**. I used a different file, a different kind of change, and two abuse vectors they did not try.

**A — semantic change in the *deserializer*.** `hasId`'s predicate `!== undefined` → `!== null`: no string literal, no comment, a one-token change to a type-guard's meaning.

```
AssertionError: apps/orders's bare-json-nats.deserializer.ts diverges from the
canonical apps/fulfillment copy (banner-stripped)
Tests  1 failed | 4 passed (5)
```

Caught, and it names the service *and* the file.

**B — the banner-stripping abuse, done properly.** The interesting attack is not putting something in the banner (a comment cannot execute) but **deleting real code by commenting it out adjacent to the banner**, so `stripBanner`'s contiguous run swallows it. I commented out `import 'reflect-metadata';` — the first code line, immediately below the banner, and a genuinely load-bearing import:

```
AssertionError: … diverges from the canonical …
expected 'import { randomUUID } from \'node:cry…' to be 'import \'reflect-metadata\';\nimport …'
```

The strip *does* swallow the line — and that is precisely why it fails: the canonical body still contains it, so the comparison catches the deletion and the diff makes it visible in the message. Fail-safe, not fail-open.

**C — swap the `//` banner for a `/* */` block.** Not stripped (the strip is `//`-only), so it lands in the compared body and diverges loudly. Also fail-safe.

I could not construct a vector where a change to executable code survived. The strip is bounded to the *leading contiguous* `//` run, so the deserializer's own mid-file comment block (the "deep import" note) **is** inside the compared body — a divergence hidden in a comment anywhere but the header is caught outright.

**D — the registry, both directions.**

| Probe | Result |
|---|---|
| a brand-new `apps/__reviewer-newapp/` nobody registered | **fails loudly**: *"app(s) present under apps/ but missing from SERVICE_BARE_JSON_MODE … add an entry before this can pass"* |
| a real `@MessagePattern(…, Transport.NATS)` in a production file of a `'no-nats-responder'` app (`apps/gateway/src/presentation/`) | **fails loudly**: *"gateway: registered 'no-nats-responder' but has grown an @MessagePattern(…, Transport.NATS) handler — promote it to 'nats-bare-json-copy' and add the wire pair"* |
| the same decorator text inside a `*.spec.ts` | correctly ignored — the false positive the implementer reported |

An app genuinely cannot exempt itself by omission, which was OI12's pre-N5 failure.

**Ruling on the `*.spec.ts` exclusion here: sound, by the same reasoning I applied to the projector guard, and this one is easier.** `*.spec.ts` is excluded from `tsconfig.build.json` in all six services, so a decorator in a spec is never a deployed responder — it is either fixture text (which is exactly what `notifications-consumes-only.spec.ts` and `projector-consumes-only.spec.ts` embed) or a controller in a `TestingModule`. Probe D's second row proves the real signal is undiminished: a genuine production responder is still caught, named, and told what to do. One observation, not a finding: this guard excludes `*.spec.ts` but **not** `test-support/`, so a `@MessagePattern` in a harness would count. That errs toward flagging rather than missing, and there are none today (I checked), so it is conservative in the safe direction.

**The guard's soundness premise, which I checked rather than assumed.** Byte-identity only transfers correctness if the canonical is itself proven. All three copy-owning services own **and run** a real behavioural spec against the actual `ServerNats` call shape — `fulfillment` 5/5, `billing` 5/5, `orders` 5/5. The argument holds.

**One inherent property, stated not as a defect:** if the *canonical* (`apps/fulfillment`) is edited wrongly, all three stay identical and the parity test passes. That is true of every parity guard including OI12's, and it is why the behavioural spec in each service matters. The file's header says so itself.

## Does the manual-test recipe work? **Yes — I ran it verbatim against a live stack, and the control proves the correction was necessary.**

Gateway started from its own `dist/main.js` (`[gateway] listening on port 3001, NATS (localhost:4222), docs at /docs`), against the already-running `otc-mongodb`/`otc-nats`:

| Documented step | Actual |
|---|---|
| `POST /auth/login` with `otc_operator_dev_password_change_me` | `{"accessToken":"eyJ…","tokenType":"Bearer","expiresIn":3600}` — matches the documented output |
| `GET /orders/00000000-0000-4000-8000-000000000000` | `HTTP 404`, `{"code":"NOT_FOUND","detail":"no order for id \"00000000-…\""}` — matches, and is F3's behaviour |
| `curl -L /docs` | `HTTP 200  content-type=text/html` |
| **my control:** the struck-through old password | `HTTP 401 INVALID_CREDENTIALS` |

The control is the point: the retired recipe is now genuinely dead, so the correction fixed a real breakage rather than a cosmetic one. **The four reversed claims are struck through (`~~…~~`), not deleted** — lines 26-27, 288-298, 314-324 and 594-597 — following the feature-23 `:113` convention, so the record still shows what was believed and when.

**And, going beyond the recipe: the definitive F1 proof.** With `apps/orders` and `apps/fulfillment` also started from their own `dist/main.js`, `POST /orders` through the gateway:

```
HTTP/1.1 201 Created
Location: /orders/e06c90f8-6d8f-4a26-b33c-4a5272241f5d
X-Correlation-Id: e06c90f8-6d8f-4a26-b33c-4a5272241f5d
{"orderId":"e06c90f8-…","orderReference":"ORD-000031","status":"placed","currency":"EUR",
 "initialAmount":49998,"initialDiscount":0,"totalAmount":49998,"projectionPending":true}
```

A **bare** `PlaceOrderResponse` — no `{response, isDisposed, id}` envelope — from the real `main.ts` over the real broker. An intermediate run before Fulfillment was up is worth recording too: it returned an instant `503` naming `fulfillment.stock.check: no responder is subscribed`, **not** a 10-second timeout — proving the *error* direction of the bare-JSON wire round-trips through `main.ts` as well. Then, same instant, same processes, with the projector deliberately **not** running so the order genuinely cannot project: the real just-issued id → **202** `projection_pending`; a random id → **404**. F1 and F3 both closed against production wiring, which is a stronger statement than any test in this repository makes.

## G6 and G7 — my rulings

**G6 (owed, not built): I agree with the ruling, and I want to sharpen where it goes.** The argument is right and worth keeping: a `readFileSync('main.ts').includes('BareJsonNatsDeserializer')` guard would be a text check on a copied pattern — the exact shape F2 and OI12's N5 both punished — and building it would have been worse than leaving the gap. But "a trustworthy version needs each service's real `bootstrap()`" understates what is available:

1. **The full version's home is `saga_e2e_verification` (28), not a unit-tier guard.** I just demonstrated the only trustworthy form: start the shipped `dist/main.js` and speak the production wire to it. That is a compose-level test, feature 28 exists and is pending, and this should be written onto it rather than left unowned.
2. **A cheap intermediate exists inside a service that was already in scope.** Export the microservice options object from `apps/orders/src/main.ts` and have `orders-create-wire.integration.spec.ts` import it instead of hand-mirroring. One file, no grep, no off-limits service — and it removes the mirror drift for the exact service where F1 bit. I am not asking for it now; I am recording that "nothing cheap was available" is not quite true.

**G7 (left as-is): accepted — the reasoning is sound and the evidence is real.** `ClientProxy` is wire-agnostic here; I proved it in Round 2 by watching both `ClientProxy` cases pass **with and without** the pair installed. Adding the pair to that harness would duplicate coverage rather than extend it. The explanatory comment is accurate and points at the spec that does own the bare-JSON wire. It does, however, lean on a sentence that is now false — see **H1**.

## G0–G4, G8 — verification

| # | Result |
|---|---|
| **G0** | `progress/current.md` correctly reset to feature 25 with a full decisions entry; the `history.md` effort record was mine to write and is now written. Closed. |
| **G1** | **Closed, verified against disk.** The evidence cell now quotes `read-model-sole-writer — PR20 (tests WHO WRITES, not who imports — R54)` and both case titles **verbatim**, and the sketch cell was rewritten to the write/read framing *and* discloses that the sketched gateway-half test never existed. Mechanically: **53 concrete `apps/**.spec.ts` paths are cited across the whole file; 0 are missing on disk.** |
| **G2** | Closed — see above; verified by execution, which was the point. |
| **G3** | Recorded in `current.md` with the multi-replica consequence spelled out and the feature-24 precedent cited. Closed as a record. |
| **G4** | **Closed, and wider than I found it.** All six services now carry an identical `exclude` (`src/**/*.spec.ts`, `src/**/test-support/**`, `node_modules`, `dist`). Clean rebuilds: gateway 64 emitted `.js`, projector 29, notifications 34, **`dist/test-support/` absent from all three**, no `*fixture*`/`*harness*` file anywhere under any `dist/`, and no production file in any service imports from `test-support/`. The coordinator's extension to `apps/notifications` was correct — my finding named two apps, the defect was in three. Worth noting: `progress/current.md:122` records an advisory from the `orders_acceptance` review — *"N4 — the `test-support` build exclude landed only in apps/orders; features 17/19 replicate it when siblings gain test-support dirs"* — which predicted this exact gap and was parked rather than actioned. |
| **G8** | Closed. `scripts/place-order.mjs`'s header now records what it used to say, that it is false, and why. |

## Composition — final, four agents

**Scope is exact.** Nothing is modified outside `apps/{gateway,orders,projector,notifications}/`, `progress/`, `specs/`, `scripts/place-order.mjs`, `.env.example`, `feature_list.json` and the two pnpm manifests. `packages/`, `apps/billing`, `apps/fulfillment`, `apps/seed`, `apps/web`, `infra/`, `n8n/` and every compose file are **byte-untouched**. The lockfile is still **448 additions, 0 deletions** — no version bump across three rounds.

**No fix silently depends on another.** The one real cross-dependency — the gateway's `R54`-mandated `mongodb` import versus `apps/projector`'s `PR20` guard — was resolved by amending the requirement and rewriting the guard, both recorded inline. `apps/notifications`' `tsconfig.build.json` is independent. The new parity guard *does* reach across packages (it lives in `apps/orders` and reads `apps/fulfillment`'s canonical), so a change in Fulfillment can turn Orders' suite red — surprising but correct, and exactly the precedent `idempotent-consumer.parity.spec.ts` set.

## `CHECKPOINTS.md` — final walk

**C1** — [x] all harness files present; [x] `progress/` files present; [x] six agent definitions; [x] every agent declares or documents its model; [x] `./init.sh` exit 0.

**C2** — [x] at most one `in_progress` (now zero); [x] every status valid; [x] every `done` feature has passing tests; [x] `progress/current.md` describes the active session; [x] no `blocked` feature.

**C3** — [x] domain purity (ESLint 0, and grep-confirmed across `apps/gateway/src/domain/**`); [x] no cross-service DB access — the gateway constructs no write-DB client, proven by a real `node` process; [x] no shared runtime code beyond `shared-kernel`/`contracts`; [x] `shared-kernel` untouched; [x] every interaction classifiable — NATS-RPC for the six subjects, and the SSE feed is a NATS core subscription to the projector's update signal, correctly neither fact nor RPC; [x] no stray debug logging, no context-free TODOs.

**C4** — [x] lint + typecheck + test pass; [x] domain tests pure; [x] integration tests on real Testcontainers brokers — **and, uniquely for this feature, the critical seam additionally verified against a live stack**; [x] coverage thresholds met (92.79% statements); [x] no Jest.

**C5** — [x] no suspicious untracked files; [x] **`progress/history.md` entry with its effort record — written with this verdict**; [x] `feature_list.json` reflects true state (id 25 → `done`); [x] the human has been told what was done and how to test it manually, and the recipe is **verified working**; [x] Claude did not commit.

**C6** — n/a (`sdd: false`). The `specs/shared/` documents it is measured against were read; every `R<n>` it touches maps to a named test in `test-matrix.md`, all 53 cited paths verified present.

**C7** — [x] `specs/shared/openapi.yaml` byte-untouched, and `test-matrix.md`'s edits are stack-agnostic; [x] `n8n/` untouched; [x] effort records complete and honest.

## Findings surviving approval

**H1 — LOW — `apps/orders/src/orders-acceptance.integration.spec.ts:11-13` still carries the sentence that made F1 invisible.** It describes its `ClientProxy` as *"the same client a future Gateway feature would use"* and its own test as exercising *"the REAL wire protocol"*. Both became false the moment the Gateway shipped a raw bare-JSON client; that header is precisely why everyone believed `orders.create` was wire-covered. G7's new comment lower in the same file cites it — *"per this file's OWN header above"* — so a correction now rests on an uncorrected false premise. Two lines, same class as G8 which was fixed. *Owner: test_maintainer.*

**H2 — LOW, structural — `specs/shared/test-matrix.md` is the only artefact in this repository that indexes tests and has no guard, and it has now been corrected five times in three rounds, never by a check.** Its notation (`path › describe › *italic case name*`) is treated as verbatim quotation in some cells and as prose summary in others, with nothing distinguishing them: the `R54` cell's *"findById/findByOrderReference/list all issue `Collection.find*` calls…"* is a précis of three separate `it` titles presented in the verbatim position; the `R53/R54` title drops `(no orderReference yet)`. Neither misstates what is tested, and I verified all 53 cited paths exist — but the drift lives in the titles, not the paths. A ~30-line spec asserting (a) every cited `apps/**.spec.ts` path exists and (b) every string in the verbatim `› *…*` position appears literally in one of that row's cited files would have caught **G1 and F6 mechanically**, and will catch the sixth. One nuance for the leader: `specs/shared/` is inherited verbatim by #8 and #9, so the guard belongs beside it in each assessment's own harness rather than inside it. *Owner: leader.*

**Carried by ruling:** **G3** (process-local window, recorded), **G6** (`main.ts` config guard — owed; I name feature 28 as its home and an exported-options refactor as the cheap intermediate), **G7** (accepted as ruled, subject to H1).

## Restoration statement — Round 3

Temporarily modified and restored: `apps/orders/src/infrastructure/messaging/bare-json-nats.deserializer.ts` (three separate mutations; identity afterwards proven by the parity guard itself returning 5/5). Temporarily created and removed: `apps/__reviewer-newapp/`, `apps/gateway/src/presentation/__reviewer-probe.controller.ts`, `apps/gateway/src/__reviewer-probe.spec.ts`. Three services were started from their built `dist/main.js` for the live probe and all three stopped afterwards (ports 3001/3002/3003 confirmed closed, no `node dist/main.js` process remaining); the eleven infra containers were left exactly as found and none was created or removed. One real order — `ORD-000031`, `e06c90f8-6d8f-4a26-b33c-4a5272241f5d` — was placed in the dev database by the live probe and is left in place, since deleting it would be a write to a service's write model; it is recorded here so it is not mistaken for seeded or demo data. No file was patched to fix a defect. No commit was made.
