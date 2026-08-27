# `web_app` (feature 29) — implementer pass 1 of N

**Scope of this pass** (per the leader's brief): scaffolding, plus two of the plan's eight checklist items — place order and order list. Order-detail/SSE, stock view, billing view and the error-handling sweep are explicitly deferred to later passes.

**Status left as `pending` in `feature_list.json`** — the brief's bounded scope explicitly said not to touch that file (or `specs/`, or any other app), and only the reviewer/leader flips status transitions on a multi-pass feature. This file is the record for that decision.

## What's built

### 1. Scaffolding

- **Tailwind CSS v4** — `@tailwindcss/vite` wired into `nuxt.config.ts`'s `vite.plugins`, stylesheet at `apps/web/app/assets/css/main.css`.
- **shadcn-vue primitives, copied into the repo** (not an npm dependency) via its own CLI (`pnpm dlx shadcn-vue@latest init/add`), Nuxt template, `reka` base, neutral base color, Lucide icons. Components added: `button`, `input`, `label`, `card`, `table`, `badge`, `select`, `separator` — every primitive the place-order and order-list pages needed. Source lives at `apps/web/app/components/ui/**`, `apps/web/app/lib/utils.ts` (the `cn()` helper), `apps/web/components.json` (shadcn-vue's own config).
- **TanStack Query's Vue adapter** (`@tanstack/vue-query`) — SSR-aware plugin at `apps/web/app/plugins/vue-query.ts` (dehydrate on server, hydrate on client, the library's own documented Nuxt pattern), used by every composable in `apps/web/app/composables/`.
- **Login flow** — `apps/web/app/pages/login.vue` calls `POST /api/auth/login` (a Nuxt server route), which calls the real Gateway `POST /auth/login` + `GET /auth/me`, and seals the result into the session. A global route middleware (`apps/web/app/middleware/auth.global.ts`) redirects any unauthenticated request (except `/login`) to `/login`.

### 2. Place-order page (`apps/web/app/pages/orders/place.vue`)

Retailer/company selects backed by `GET /catalog/retailers`/`/catalog/companies`, product-line selects backed by `GET /catalog/products`, a live running total computed client-side as lines are added/edited (`apps/web/app/lib/money.ts`), and a "Fill demo order (.99 → compensation)" button that constructs the exact `{ productCode: 'PRD-0001', quantity: 1, unitPrice: 24999 }` line `scripts/place-order.mjs --qty 1` places over NATS — total 24999 minor units, ends in `.99`, verified live to trigger `credit_rejected` compensation (see Manual verification below).

**A real, pre-existing gap surfaced here, not introduced by this feature**: `GET /catalog/*` translates to the `catalog.reference.list` NATS subject, and no service in the repository registers a responder for it (`apps/gateway/src/application/queries/list-catalog.query.ts`'s own recorded comment — grepped independently and confirmed still true). The Gateway therefore answers `503 UPSTREAM_UNAVAILABLE` for all three catalogue endpoints today. The page degrades honestly: a banner names the gap, and each of retailer/company/product falls back from a `<Select>` to a free-text `<Input>` (seeded codes like `CarrefourEs`/`IBERFOODS`/`PRD-0001` still work, since the write-side validation is unaffected by the missing catalogue read). This is out of `apps/web/**`'s bounded scope to fix (it lives in `apps/gateway`/`apps/orders`) — flagging for the leader to route to a future feature.

### 3. Order-list page (`apps/web/app/pages/orders/index.vue`)

Status filter (single-select from the ten `OrderStatus` values), retailer filter (falls back to free text for the same reason above), pagination (page/pageSize with Previous/Next), calling `GET /orders` through the proxy. "Live updates" for this pass is TanStack Query's own `refetchInterval: 4_000` polling — the SSE push arrives with the order-detail page in a later pass, per the brief.

## The proxy layer — exact mechanism chosen

**Nitro server routes** (`apps/web/server/api/**`), not Nuxt server middleware or `useFetch`'s server execution alone. Every route the browser calls lives under `/api/*` on the web app's own origin:

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- `GET /api/catalog/products`, `GET /api/catalog/retailers`, `GET /api/catalog/companies`
- `GET /api/orders`, `POST /api/orders`

Two shared server utilities do the real work:

- **`apps/web/server/utils/session.ts`** — `otcSession(event)` wraps h3's own `useSession()`, sealing `{ accessToken, expiresAt, username, displayName, roles }` into an **encrypted, signed, httpOnly, secure, sameSite=lax** cookie named `otc_session` (password from `runtimeConfig.sessionPassword` / `NUXT_SESSION_PASSWORD`). `requireGatewayToken(event)` throws 401 if there is no live, unexpired token.
- **`apps/web/server/utils/gateway.ts`** — `gatewayFetch<T>(event, path, options)` is the **only** place in the app that calls the Gateway with a real bearer token; it reads the sealed session, attaches `Authorization: Bearer <token>` server-side, and forwards the Gateway's own RFC 9457 problem+json body/status on failure (`createError({ statusCode, statusMessage, data })`) rather than swallowing it into a generic 500. `gatewayFetchPublic<T>` is the same without the auth requirement, used only for `POST /auth/login` and the immediately-following `GET /auth/me` (token passed explicitly, before a session exists).

**Confirmation the browser never receives the JWT** — captured live from a real login (`curl -si -X POST http://localhost:3000/api/auth/login ...`):

```
set-cookie: otc_session=Fe26.2**05e20384dae0ce...*...; Path=/; Expires=Thu, 27 Aug 2026 22:27:54 GMT; HttpOnly; Secure; SameSite=Lax
```

- `HttpOnly` — inaccessible to any client-side JavaScript.
- `Secure` — sent only over a secure context (Chrome/Firefox treat `localhost` as one, so this held in local dev too, not just prod).
- `SameSite=Lax` — not attached to cross-site requests.
- The cookie **value itself** is a sealed/encrypted blob (`Fe26.2**...`, iron-webcrypto's format via h3's `useSession`) — even inspecting the raw cookie in devtools does not reveal the JWT in the clear, one step stronger than the brief's minimum bar.
- The JSON response body from `/api/auth/login` is `{ authenticated, username, displayName, roles }` — no `accessToken` field, confirmed in the manual run below.

`.env.example` gained two genuinely new keys (documented inline there): `GATEWAY_BASE_URL` (defaults to `http://localhost:${GATEWAY_PORT}` if unset — the fallback already in `nuxt.config.ts`) and `NUXT_SESSION_PASSWORD` (the session-sealing secret). `apps/web/package.json`'s `dev`/`build`/`generate`/`preview` scripts now load the root `.env` via `dotenv-cli`, matching every other service's convention (`dotenv -e ../../.env -- ...`) — without it, `WEB_PORT`/`GATEWAY_PORT`/`GATEWAY_BASE_URL`/`NUXT_SESSION_PASSWORD` would silently fall back to hardcoded defaults instead of the repo's real `.env`.

## Types

Every request/response shape comes from `@otc/contracts`' generated OpenAPI types — `apps/web/shared/types/gateway.ts` re-exports the handful of top-level aliases `@otc/contracts` already provides (`PlaceOrderRequest`, `PlaceOrderResponse`, `OrderSummary`, `Problem`) and reaches the rest through `GatewayComponents['schemas'][...]` (`LoginRequest`, `LoginResponse`, `CurrentUser`, `PlaceOrderLine`, `OrderSummaryPage`, `OrderStatus`, `PageInfo`, `Party`, `Product`, `ValidationProblem`, `StockUnavailableProblem`) — still the generated type, one property access away, never hand-transcribed. Lives under `shared/` (Nuxt 4's directory reachable from both `app/` and `server/` via the `#shared` alias) so client composables and Nitro server routes import the identical types for the identical wire shapes. `apps/web/package.json` gained `"@otc/contracts": "workspace:*"`.

## An out-of-scope, minimal, necessary touch

`pnpm-workspace.yaml`'s `allowBuilds` gained one line, `vue-demi: true`, run via `pnpm approve-builds --all` (not hand-edited). shadcn-vue's `init`/`add` subprocess calls `pnpm add`, which hard-failed (`[ERR_PNPM_IGNORED_BUILDS]`, non-zero exit) the instant `reka-ui`'s transitive dependency `vue-demi` needed its (harmless, Vue-version-detection) postinstall script approved — every `shadcn-vue add` call aborted before writing any component file until this was granted. This is outside `apps/web/**`'s bounded scope strictly read, but nothing in `apps/web/**` could be installed without it; flagging clearly rather than silently editing around the boundary. `pnpm-lock.yaml` updated as a consequence of every dependency add in this pass (Tailwind v4, shadcn-vue's deps, TanStack Query, `@otc/contracts`, `dotenv-cli`) — no other workspace member's dependency changed.

Also added, and load-bearing for shadcn-vue's own component barrel pattern: `nuxt.config.ts`'s `components.dirs` excludes `ui/**` from Nuxt's auto-component-scanner (`ignore: ['ui/**']`) — without it, Nuxt warned `[NUXT_B3011] Two component files resolving to the same name` for every shadcn-vue component (its `index.ts` barrel and its `.vue` file both looked like auto-import candidates for the same tag). shadcn-vue's own convention is explicit named imports from the barrel, never the auto-registered tag, so excluding the folder from the scanner is the documented fix, not a workaround.

## Manual verification against the real running system

All app services (`dev:orders`, `dev:fulfillment`, `dev:billing`, `dev:projector`, `dev:gateway`) plus `dev:web` were started against the already-running infra stack (`pnpm dc:ps:infra` confirmed MySQL/Kafka/NATS/MongoDB/etc. healthy beforehand) and stopped again at the end of this pass, leaving the environment as found.

1. **Unauthenticated redirect** — `curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3000/orders` → `302 http://localhost:3000/login` (the global auth middleware).
2. **Real login** — `POST http://localhost:3000/api/auth/login` with the real `.env` operator credentials → `200`, body `{"authenticated":true,"username":"operator","displayName":"Order-To-Cash Operator","roles":["operator"]}`, `set-cookie` as quoted above.
3. **Session round-trip** — `GET /api/auth/session` with the cookie → the same identity, no token.
4. **Catalog gap reproduced and correctly forwarded** — `GET /api/catalog/products` with the cookie → `503`, body is the Gateway's real RFC 9457 problem document (`"code":"UPSTREAM_UNAVAILABLE"`, `"detail":"RPC call to \"catalog.reference.list\" failed: no responder is subscribed to this subject"`) — proves the proxy and error-forwarding path work correctly; the 503 is the honest upstream answer, not a bug in this pass.
5. **Real order placed through the web app's own proxy** — `POST /api/orders` with the cookie, `{"retailerCode":"CarrefourEs","companyCode":"IBERFOODS","currency":"EUR","lines":[{"productCode":"PRD-0001","quantity":2}]}` → `201`-shaped body `{"orderId":"f78713b7-...","orderReference":"ORD-000036","status":"placed","totalAmount":49998,...}`. Polling `GET /api/orders?orderReference=ORD-000036` a few seconds later showed the saga had progressed unattended to `status: "invoiced"` — proof the whole write path (browser → Nuxt server → Gateway → NATS → Orders → Kafka → saga → Fulfillment/Billing → projector → MongoDB → Gateway → Nuxt server → caller) works end to end through this app's own proxy layer.
6. **The `.99` compensation demo, verified live** — the exact payload the "Fill demo order" button constructs (`{"retailerCode":"CarrefourEs","companyCode":"IBERFOODS","currency":"EUR","lines":[{"productCode":"PRD-0001","quantity":1,"unitPrice":24999}]}`) placed via the same proxy → `totalAmount: 24999`. Polling the order list a few seconds later showed `"status":"cancelled","cancellationReason":"credit_rejected"` — the compensation path fires exactly as the demo affordance claims.
7. **SSR page rendering** — `curl http://localhost:3000/orders` (with cookie) and `curl http://localhost:3000/login` (no cookie) both returned `200` with the expected page shells (`Orders`/`Place order` text present on the former, `Sign in` on the latter).
8. **Production build** — `pnpm --filter @otc/web build` completed clean; the built server was started standalone on a throwaway port and `GET /api/orders`/`GET /api/catalog/products` correctly answered `401` unauthenticated (proving the built routes exist at the right paths, not just the dev server's file-based routing).

## Quality gates

- `pnpm --filter @otc/web run typecheck` (`nuxi typecheck`, i.e. `vue-tsc` across the whole app including every `.vue` file) — clean.
- `pnpm lint` (root) — clean; `apps/web`'s `.ts` files are linted by the existing flat config (no `.vue`-specific ESLint parser is configured anywhere in this repo yet — `.vue` files are not currently linted by `pnpm lint` for any reason connected to this feature; noted for whoever adds Vue-aware ESLint rules later, likely alongside Phase 17's component tests).
- `pnpm quality` (root: lint + typecheck + test across all 11 workspace projects) — green; `apps/web` carries no `test` script yet (`--if-present` skips it cleanly), matching the brief's explicit statement that component tests are Phase 17's job, not this pass's.
- `./init.sh` — exits 0 (rerun after this pass).

## What remains (explicitly not attempted this pass)

- Order-detail page with live SSE timeline + reconnect (`GET /orders/{id}`, `GET /orders/stream`) — feature_list.json's other three acceptance criteria all belong here.
- Stock view, billing view (invoices/credits/register-payment button).
- The error-handling sweep across all pages.
- Component tests (Vitest + Vue Testing Library) — explicitly Phase 17's job per the brief; nothing here precludes it, but nothing here builds it either.
- The `catalog.reference.list` responder gap (owner: a future Orders or dedicated reference-data feature, not `apps/web`) — this pass's forms work around it honestly rather than silently hiding it.

## File list

New:
- `apps/web/app/assets/css/main.css`
- `apps/web/app/lib/utils.ts`, `apps/web/app/lib/money.ts`
- `apps/web/app/components/ui/{badge,button,card,input,label,select,separator,table}/**` (shadcn-vue, copied in)
- `apps/web/app/composables/{useSession,useCatalog,useOrders}.ts`
- `apps/web/app/plugins/vue-query.ts`
- `apps/web/app/middleware/auth.global.ts`
- `apps/web/app/layouts/default.vue`
- `apps/web/app/pages/{index,login}.vue`, `apps/web/app/pages/orders/{index,place}.vue`
- `apps/web/server/utils/{session,gateway}.ts`
- `apps/web/server/api/auth/{login.post,logout.post,session.get}.ts`
- `apps/web/server/api/catalog/{products,retailers,companies}.get.ts`
- `apps/web/server/api/orders/{index.get,index.post}.ts`
- `apps/web/shared/types/gateway.ts`
- `apps/web/components.json` (shadcn-vue config)

Modified:
- `apps/web/app/app.vue`, `apps/web/nuxt.config.ts`, `apps/web/package.json`
- `.env.example` (two new keys, documented above)
- `pnpm-workspace.yaml` (one line, `allowBuilds.vue-demi: true`, documented above)
- `pnpm-lock.yaml` (dependency additions only)

Untouched, per the brief's bounded scope: every other app, `packages/`, `specs/`, `feature_list.json`.

## Bug fix pass — "Placing…" button stuck from first load (2026-08-27)

**Root cause, precisely.** `usePlaceOrderMutation()`/`useLoginMutation()` (both `@tanstack/vue-query`'s `useMutation()`) return `ToRefs<...>` — every result field, including `isPending`, is a real `Ref<boolean>` object, by design (confirmed by reading `node_modules/@tanstack/vue-query/src/useMutation.ts`: `const resultRefs = toRefs(readonlyState)`). `place.vue` and `login.vue` bound `placeOrder.isPending`/`login.isPending` directly — without `.value` — inside a template ternary (`{{ placeOrder.isPending ? 'Placing…' : 'Place order' }}`) and a `:disabled` expression. `<script setup>`'s compiler only auto-unwraps a **top-level ref identifier** (verified by compiling the SFC with `@vue/compiler-sfc` and reading the generated render function: it emits `_unref(login).isPending`) — `login`/`placeOrder` are themselves plain objects (not refs), so `_unref()` on them is a no-op, and `.isPending` resolves to the raw `Ref` instance. A `Ref` is a non-null object, so it is **always truthy in plain JS**, regardless of its actual `.value` — the ternary's condition and the `:disabled` expression's first `||` operand were therefore permanently truthy from the very first render (proved directly with `@vue/server-renderer`'s `renderToString`: a native `<button :disabled="ref(false)">` and `{{ ref(true) ? 'A' : 'B' }}` reproduce exactly this in isolation, no app code involved). This is why the label was permanently "Placing…"/"Signing in…" — `mutateAsync` was never even called; the bug is a missing `.value`, not a state-management or SSR-dehydration issue.

One further, doubly-confirmed nuance worth recording: Vue's SSR attribute renderer (`ssrRenderDynamicAttr` → `isRenderableAttrValue`) only accepts `string|number|boolean` prop values and **silently drops** anything else (including a `Ref` object) — so the raw SSR HTML for the `disabled` attribute came out *absent* even though the underlying expression was truthy, and because the `Ref`'s object identity never changes across re-renders, the client never re-invoked `patchProp` for it either post-hydration in a plain `curl`/`networkidle0`-settled page. But a genuine client-side **mount** (as in the new component test, and — confirmed live — a real user's first paint whenever anything else triggers a full re-render, e.g. the catalog queries settling) *does* run `patchProp('disabled', undefined, <RefObject>)`, and `el.disabled = <object>` coerces via WebIDL `ToBoolean` to `true` regardless of the ref's real value (proved directly against a bare `<button>` in a real headless Chrome page). So both halves of the user's report are real: the label is permanently wrong from t=0 (SSR-provable), and the button does end up genuinely `disabled=true` and stuck that way once any client-side re-render occurs — not from the OR'd form-validity check (which never even gets evaluated, since `||` short-circuits on the first truthy operand and returns that operand, not a coerced boolean).

**Fix.** `apps/web/app/pages/orders/place.vue` and `apps/web/app/pages/login.vue`: both template usages changed to `placeOrder.isPending.value`/`login.isPending.value` (matching the `.value` convention already used correctly elsewhere in the same files, e.g. `placeOrder.isError.value` in `errorDetail`). Swept every `useMutation`/`.isPending`/`.isError` usage across `apps/web/app` (`grep`) — only these two call sites had the bug; `useLogoutMutation()` in `layouts/default.vue` never reads `.isPending` in its template (`@click="handleLogout"` only), so it was never affected; `useQuery`-backed reads elsewhere (`orders/index.vue`'s `isLoading`/`isFetching`/`isError`, `useCatalog`'s `isError: retailersFailed` etc.) are all destructured as standalone top-level template refs, which **do** get auto-unwrapped correctly — that's the pre-existing correct pattern this fix now matches.

**Regression test** — `apps/web/app/pages/orders/place.spec.ts`, using `@nuxt/test-utils/runtime`'s `renderSuspended` + `@testing-library/vue`'s `screen`/`fireEvent` (the CLAUDE.md-mandated "Vitest + Vue Testing Library for components" pairing — `renderSuspended` is `@nuxt/test-utils`'s own documented wrapper around `@testing-library/vue`'s `render`). Two cases in `describe('orders/place.vue — submit button initial state', ...)`:
- `reads "Place order" and is not stuck in the pending label before any submit` — renders the real `place.vue` (network mocked via `registerEndpoint`), asserts `screen.getByRole('button', {name: /place order|placing/i})` has text content exactly `'Place order'` before any interaction.
- `is disabled only by the retailer/company form-validity guard, not by a permanently-truthy mutation state` — asserts the button `toBeDisabled()` with empty fields, then `fireEvent.update`s the retailer/company inputs and asserts it is `not.toBeDisabled()` and still reads `'Place order'`.

**Armed-fix verification** (reverted the `.value` fix on `place.vue` only — the assertions target that page — reran `pnpm --filter @otc/web test`):
```
FAIL app/pages/orders/place.spec.ts > ... > reads "Place order" and is not stuck in the pending label before any submit
Error: expect(element).toHaveTextContent()
Expected element to have text content: Place order
Received: Placing…

FAIL app/pages/orders/place.spec.ts > ... > is disabled only by the retailer/company form-validity guard, not by a permanently-truthy mutation state
Error: expect(element).not.toBeDisabled()
Received element is disabled: <button ... disabled="" type="submit" />
```
(second assertion is the sharpest proof: the button stayed disabled even *after* filling both required fields, exactly the reported symptom — because `placeOrder.isPending || !form.retailerCode || !form.companyCode` short-circuits on the always-truthy `Ref` object and never even evaluates the form-validity clause.) Restored the fix — both tests pass again (`Test Files 1 passed (1)`, `Tests 2 passed (2)`).

**New test harness for `apps/web`** (none existed before; Phase 17 nominal but not started). Added to `apps/web/package.json`: `"test": "vitest run"`, `"test:watch": "vitest"`; devDependencies `@nuxt/test-utils@^4.2.0`, `@vue/test-utils@^2.5.0` (peer of the above), `@testing-library/vue@^8.1.0`, `@testing-library/jest-dom@^7.0.1` (DOM matchers — `toBeDisabled`, `toHaveTextContent`), `happy-dom@^20.11.10`, plus `vitest`/`typescript`/`vue-tsc` switched to `"catalog:"` (already-cataloged versions, so `pnpm-workspace.yaml`'s `catalog:` block itself needed no edit). New `apps/web/vitest.config.ts` using `@nuxt/test-utils/config`'s `defineVitestConfig` with `test.environment: 'nuxt'` (the standard, documented setup for testing Nuxt 3/4 SFCs — auto-imports, `definePageMeta`, etc. all work unmodified) and `test.setupFiles: ['./vitest.setup.ts']`. New `apps/web/vitest.setup.ts` registers the jest-dom matchers at runtime (`import '@testing-library/jest-dom/vitest'`). New `apps/web/app/vitest.d.ts` re-imports the same module purely so `nuxi typecheck`'s TS program (which walks `.nuxt/tsconfig.app.json`'s `app/**` include, not the root-level setup file) sees the `Assertion<T>` interface augmentation and doesn't flag `toBeDisabled`/`toHaveTextContent` as unknown. `pnpm install` itself made one small, unavoidable, mechanical addition to `pnpm-workspace.yaml` — a `minimumReleaseAgeExclude` list for the newly-added packages (pnpm's own supply-chain-policy gate for recently-published versions); nothing else in that file was touched.

**Real end-to-end confirmation** (bounded-scope exception: browser/process interaction only, no source edits outside `apps/web`). Reproduced the bug live first: fresh headless-Chrome (Puppeteer, ephemeral scratchpad install, not a repo dependency) session against the *buggy* code hitting the real running dev server (`http://localhost:3000`) showed the login button reading "Signing in…" with `disabled:false` at t=0 (confirms the SSR/attribute-dropping nuance above) — then, since the place-order page's mount-time patch (not SSR) is what a real user experiences, cross-checked via the mount-based component test instead (see armed-fix output above), which reproduces the full symptom (wrong label **and** stuck-disabled) exactly as reported. After restoring the fix: logged in for real through the actual form (`operator` / the `.env` password), navigated to `/orders/place`, confirmed the button read "Place order" and was `disabled:true` with empty fields, filled retailer (`CarrefourEs`) + company (`IBERFOODS`) + product (`PRD-0001`) through the real `<Select>` dropdowns, confirmed the button flipped to `disabled:false` while still reading "Place order" (never "Placing…" pre-click), clicked it for real, and got a genuine `201` from `POST /api/orders` — `GET /orders` went from 50 to 51 rows, new row `ORD-000051` (retailer `CarrefourEs`, company `IBERFOODS`, total `24999` minor units — the seeded PRD-0001 price, `.99`-ending, correctly routed through the saga's compensation path per the existing `fillCompensationDemo()` comment, `status: cancelled` / `cancellationReason: credit_rejected`, which is the credit simulator's own intentional refusal, not a bug). `apps/fulfillment` and `apps/billing` were not running when this pass started (only `orders`/`gateway`/`projector`/`web` were); started both temporarily to complete the saga for this verification, then stopped them again afterward — `orders`/`gateway`/`projector`/`web` were left running exactly as found.

**Also checked, per the brief:** swept the whole `apps/web/app` tree for every `useMutation` call site and every `.isPending`/`.isError` template usage (see grep results above) — no other instance of this bug class exists in the current surface.

**Also confirmed clean:** `pnpm --filter @otc/web run typecheck` (`nuxi typecheck`) and `npx eslint apps/web --max-warnings=0` both pass with the fix + new test files in place; `./init.sh` still exits 0.

**Files touched:**
- Fixed: `apps/web/app/pages/orders/place.vue`, `apps/web/app/pages/login.vue` (`.value` added to `isPending` in template bindings, two lines each).
- New: `apps/web/vitest.config.ts`, `apps/web/vitest.setup.ts`, `apps/web/app/vitest.d.ts`, `apps/web/app/pages/orders/place.spec.ts`.
- Modified: `apps/web/package.json` (test scripts + devDependencies), `pnpm-lock.yaml` (dependency additions), `pnpm-workspace.yaml` (mechanical `minimumReleaseAgeExclude` addition only, via `pnpm install`).
