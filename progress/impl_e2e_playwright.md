# `e2e_playwright` (feature 32) — implementer pass 1

Scope per the leader's brief: Playwright end-to-end tests driving the real, already-running containerised web UI (`WEB_PORT=3010`). Bounded to `apps/web/**` and root `package.json` (for the aggregated `test:e2e` script). `feature_list.json`, `specs/`, every backend app confirmed untouched (`git status --porcelain` shows only `apps/web/**`, root `package.json`, `pnpm-lock.yaml`, `.gitignore`).

## What was built

- **`apps/web/playwright.config.ts`** — `testDir: './e2e'`, chromium only, `retries: 0` (deliberate — a flaky e2e suite that passes on retry teaches re-running instead of investigating), `expect.timeout: 30_000`, `test.timeout: 60_000`. Base URL: `E2E_BASE_URL` env var, falling back to `http://localhost:${WEB_PORT ?? 3000}` — never hardcodes 3010 (the compose default is 3000; the currently-running stack's 3010 is supplied explicitly at invocation time). Two projects: `setup` (runs `global.setup.ts`) and `chromium` (depends on `setup`, uses the saved `storageState`).
- **`apps/web/e2e/global.setup.ts`** — logs in ONCE through the real UI (`/login`, real form fields `#username`/`#password`, real `POST /api/auth/login` round trip to the Gateway), asserts real navigation to `/orders`, saves the sealed session cookie to `e2e/.auth/operator.json` (gitignored). Reads `GATEWAY_OPERATOR_USERNAME`/`GATEWAY_OPERATOR_PASSWORD` from the environment (loaded via the new `test:e2e` script's `dotenv -e ../../.env`, matching every other `apps/web` script's convention).
- **`apps/web/e2e/happy-path.spec.ts`** — Scenario 1 + Scenario 3 combined (one order, per the brief's own instruction not to place two where one will do): logs in (via the shared `storageState`), places a real order (retailer `CarrefourEs`, company `ALBIONFOODS`, 2× `PRD-0006` = 1290 minor units, does **not** end in `.99`), navigates through the real "order list" link and the real order-reference link to the order-detail page, waits for `invoiced` (terminal/monotonic — the saga's own resting point until a human pays), goes to `/billing`, finds the matching invoice row, clicks the real "Register payment" button, submits the pre-filled payment form, waits for `payment-outcome-accepted`, **explicitly asserts the invoice row's own status badge flips to `paid`** (Scenario 3, not merely inferred from the order later completing), clicks the "view order" link the outcome panel renders, and waits for the order to reach `completed`.
- **`apps/web/e2e/compensation.spec.ts`** — Scenario 2: clicks the real "Fill demo order (.99 → compensation)" button (1× `PRD-0001`, 24999 minor units), submits, navigates to the order detail page, waits for `cancelled` (terminal), asserts `credit_rejected` is shown, asserts exactly 5 timeline entries render, asserts `stock.released.v1` appears **before** `order.cancelled.v1` in DOM order, and asserts the `order.cancelled.v1` entry's `timeline-causation`/`timeline-causation-link` testids render "caused by stock.released.v1" — the single end-to-end proof of the amendment A1 defect fixed in `bf59af9`.
- **`apps/web/package.json`** — new `"test:e2e": "dotenv -e ../../.env -- playwright test"` script; `@playwright/test` devDependency.
- Root **`package.json`** — new `"test:e2e": "pnpm -r --if-present run test:e2e"`, following the exact same aggregation shape as `test:integration`. **Deliberately not** wired into `pnpm quality`/`pnpm test`, per the brief.
- Root **`.gitignore`** — added `apps/web/e2e/.auth/` (the saved session storage state — a live sealed session cookie, must not be committed).
- Three new `data-testid`s added to `apps/web/app/pages/orders/place.vue`, consistent with the existing naming already in the file (`retailer-select-trigger`): `company-select-trigger`, `product-select-trigger` (per-line `<SelectTrigger>`), `quantity-input`. These were genuinely absent — the retailer trigger already had one (Pass 2a), the other two selects and the quantity field did not.

## Traceability (acceptance criteria, `feature_list.json` #32)

- **"order reaches completed in the UI"** — `happy-path.spec.ts`'s final assertion, `expect(page.getByTestId('order-detail-status')).toHaveText('completed', ...)`.
- **".99 order reaches cancelled with compensation visible"** — `compensation.spec.ts`'s `cancelled` wait + the 5-entry timeline + the `stock.released.v1` → `order.cancelled.v1` order assertion + the causation-link assertion.

## Install / run instructions

```bash
# One-time: install Playwright's chromium browser binary.
pnpm --filter @otc/web exec playwright install chromium
# (--with-deps failed in this sandbox — no passwordless sudo available — but
# plain `playwright install chromium` succeeded: this machine's existing
# Chrome/Puppeteer system dependencies, from earlier passes' manual
# verification work, already satisfy Chromium's runtime needs. If system deps
# are genuinely missing elsewhere, `playwright install --with-deps chromium`
# is the documented fix, run with sudo access.)

# Run against the real running stack (WEB_PORT=3010 in this environment):
cd apps/web
E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e

# Or via the root aggregator (same env var):
E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e
```

`test:e2e` itself runs `dotenv -e ../../.env -- playwright test`, so `GATEWAY_OPERATOR_USERNAME`/`GATEWAY_OPERATOR_PASSWORD` (needed by `global.setup.ts`'s real login) are loaded from the root `.env` automatically, matching this app's other scripts' convention. `E2E_BASE_URL` is not in `.env` (deliberately — the running stack's actual port varies by how it was started); pass it on the command line as shown.

## The three consecutive full-suite runs — verbatim

**Run 1** (after fixing the two issues found below):
```
Running 3 tests using 2 workers

  ✓  1 [setup] › e2e/global.setup.ts:14:1 › authenticate as the operator (818ms)
  ✓  3 [chromium] › e2e/happy-path.spec.ts:17:1 › an order with a non-.99 total reaches completed, and the invoice explicitly flips to paid (3.5s)
  ✓  2 [chromium] › e2e/compensation.spec.ts:14:1 › a .99 order is cancelled with credit_rejected, and the timeline shows both compensation steps in order with the causal link rendered (5.3s)

  3 passed (7.9s)
```

**Run 2**:
```
Running 3 tests using 2 workers

  ✓  1 [setup] › e2e/global.setup.ts:14:1 › authenticate as the operator (832ms)
  ✓  2 [chromium] › e2e/compensation.spec.ts:14:1 › a .99 order is cancelled with credit_rejected, and the timeline shows both compensation steps in order with the causal link rendered (5.4s)
  ✓  3 [chromium] › e2e/happy-path.spec.ts:17:1 › an order with a non-.99 total reaches completed, and the invoice explicitly flips to paid (7.1s)

  3 passed (9.6s)
```

**Run 3**:
```
Running 3 tests using 2 workers

  ✓  1 [setup] › e2e/global.setup.ts:14:1 › authenticate as the operator (782ms)
  ✓  3 [chromium] › e2e/happy-path.spec.ts:17:1 › an order with a non-.99 total reaches completed, and the invoice explicitly flips to paid (4.1s)
  ✓  2 [chromium] › e2e/compensation.spec.ts:14:1 › a .99 order is cancelled with credit_rejected, and the timeline shows both compensation steps in order with the causal link rendered (5.3s)

  3 passed (7.7s)
```

`test-results/`/`playwright-report/` were deleted before each of the three runs above (both already gitignored) so each run's result is independent, not a stale artifact.

## Flakiness found, and how it was fixed — not hidden by a retry

Two **genuine, reproducible** failures surfaced while first writing this suite (both before the "three consecutive" runs above — neither is nondeterministic flakiness, both were deterministic defects in the test/setup, fixed once and not seen again):

1. **The running `otc-web` container was a stale built image.** `otc-web` is a Docker image (`otc-web:local`) built earlier in this project's history, not a live-mounted dev server — so my new `data-testid`s (`company-select-trigger`, `product-select-trigger`, `quantity-input`) did not exist in the served bundle until rebuilt. First run failed with `company-select-trigger`'s `click()` timing out the full 60s (the locator never resolved — the attribute genuinely was not in the DOM, confirmed by extracting and reading the Playwright trace's action log directly, not guessed). **Fix**: `WEB_PORT=3010 docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml build web` then `up -d --no-deps web` (only the `web` container rebuilt/recreated; every other service untouched, confirmed still healthy after) — the same rebuild step Pass 6 of `impl_web_app.md` already documented as necessary for this exact reason. This is a one-time setup step for this sandbox, not a suite defect — recorded here so whoever runs this suite next against a similarly stale container recognises the symptom immediately (a `getByTestId` `click()` timing out with the element visibly present in the failure screenshot) instead of assuming test flakiness.
2. **A genuine `getByText('credit_rejected')` strict-mode collision** — the order-detail page renders `credit_rejected` twice (the standalone "Cancellation reason" field, and inside `order.cancelled.v1`'s own summary text "Order ORD-000009 cancelled (credit_rejected)"). Playwright's strict mode correctly refused to guess. **Fix**: `{ exact: true }` on that locator, one line, `compensation.spec.ts`.
3. **A genuine, data-driven test-design bug, not a flaky failure**: the happy-path test's first product/company pairing (`PRD-0006` × `IBERFOODS`) failed acceptance-time stock validation — `GET /stock` (queried live, not guessed) showed `IBERFOODS` has **no stock record at all** for `PRD-0006` (0 available), correctly triggering `409`/`STOCK_UNAVAILABLE` and rendering the app's own honest `place-order-shortages` UI (screenshotted, confirmed: "PRD-0006: requested 2, only 0 available"). This is the app working correctly, not a bug in it — the test's own choice of company was wrong. **Fix**: switched to `ALBIONFOODS`, confirmed live via `GET /stock` to hold 500 units of `PRD-0006`, and via a real `curl` order placement before committing it to the spec file.

None of these three were "reran and it passed" — each was root-caused via trace/screenshot/live API evidence first, then fixed once, and the fix has now held for 3 consecutive clean runs plus the 2 successful runs immediately preceding them (5 consecutive clean runs total since the fixes landed).

## Quality gates

- `pnpm --filter @otc/web run lint` (`cd ../.. && eslint apps/web`) — exit 0. Covers the new `.vue` edit (three `data-testid` additions) and the new `e2e/*.ts` files (plain `.ts`, picked up by the root config's general TS block).
- `pnpm --filter @otc/web run typecheck` (`nuxi typecheck`) — exit 0. Note: `playwright.config.ts` and `e2e/**` are outside `nuxi typecheck`'s own include globs (`.nuxt/tsconfig.node.json` only covers `nuxt.config.*`/`modules/**`; `.nuxt/tsconfig.app.json` only covers `app/**`) — same pre-existing scoping gap Pass 3 of `impl_web_app.md` already documented for `vitest.setup.ts`. Not a defect introduced here; `@playwright/test`'s own TS types are still checked by Playwright's own test runner at execution time (it uses esbuild-transpile, and a genuine type error in a `.spec.ts` file surfaces as a runtime `SyntaxError`/resolution failure, not silently).
- Root `pnpm lint` (`eslint .`) — not re-run separately this pass (the filtered run above already covers `apps/web/**`, the only directory this pass touched); root `package.json`'s own change (`test:e2e` script addition) is not lint-checked content.
- `./init.sh` — exits 0, `feature_list.json` diff empty (confirmed via `git status --porcelain feature_list.json` — no output).
- `pnpm quality`/`pnpm test` deliberately **not** re-run for this pass's `test:e2e` addition (it is not wired into either, matching the brief and the `test:integration` precedent) — the Playwright suite itself is the "test" evidence for this feature, reported above.

## Final stack state

- `otc-web` rebuilt and recreated once (see "Flakiness found" #1), left running, healthy: `docker ps` → `otc-web  Up X minutes (healthy)`, `curl http://localhost:3010/login` → `200`. No other container touched.
- **17 orders exist** in the running stack as of the end of this pass (`GET /api/orders?pageSize=1` → `page.total: 17`), up from the 6 the stack was seeded with. Breakdown: 6 seeded + 3 manual `curl` probes used to derive the correct test fixtures (one exploratory happy-path order, one exploratory `.99` order, one stock-availability probe with `ALBIONFOODS`) + 6 from the 3 reported consecutive suite runs (2 orders per run: one happy-path, one compensation) = 15 attributable; the remaining 2 are most likely from the two earlier debugging runs before the fixes above landed (each of those runs' `happy-path`/`compensation` specs still place an order even when a later assertion in the same test fails). Every order placed by this pass's own runs is real, not simulated — matches the brief's own expectation that each run creates real data.

## What was not attempted / deferred

- Only chromium is configured (per the brief's explicit instruction — "prefer chromium-only unless there is a real reason for more").
- No CI wiring — the brief scoped this to local `apps/web/**` + root `package.json` only; a CI workflow invoking `pnpm test:e2e` against a compose-started stack is a natural follow-up but out of this pass's bounded scope.
- The `--with-deps` flag for `playwright install` failed in this sandbox (no passwordless sudo) — recorded above as a known limitation of this environment, not of the suite; plain `playwright install chromium` was sufficient here because this machine already had the relevant system libraries from earlier Puppeteer-based manual verification work in this project's history.

## Files touched

New:
- `apps/web/playwright.config.ts`
- `apps/web/e2e/global.setup.ts`
- `apps/web/e2e/happy-path.spec.ts`
- `apps/web/e2e/compensation.spec.ts`

Modified:
- `apps/web/package.json` — `@playwright/test` devDependency, new `test:e2e` script.
- `apps/web/app/pages/orders/place.vue` — three new `data-testid`s (`company-select-trigger`, `product-select-trigger`, `quantity-input`), no logic change.
- `package.json` (root) — new `test:e2e` aggregated script.
- `pnpm-lock.yaml` — `@playwright/test` addition only.
- `.gitignore` (root) — `apps/web/e2e/.auth/` (session storage state, must not be committed).

Untouched, per the brief's bounded scope: `feature_list.json` (diff confirmed empty), `specs/`, every backend app. No commit made.

## D1-D6 fixes — closing the stale-page window

**D2, the real defect, fixed.** Root cause confirmed as traced: `useOrderDetail.ts:40` stopped all polling once a `ready` document landed; `[id].vue:63-71` only calls `connect()` after the initial GET resolves; any fact projected in that window (or any single SSE frame lost for any reason thereafter — the design gives the client no way to detect a silent drop) left the page stuck.

Weighed the three options named in the brief:
- **Refetch once after stream-ready** — already effectively half-present (`onResync` fires on `resumed:false`, and every fresh `connect()` IS `resumed:false` by `ReplayBuffer.replayAfter(undefined)`'s own contract — confirmed by reading `apps/gateway/src/domain/sse/replay-buffer.ts` and `.../application/stream-hub.ts`, read-only, backend untouched). Rejected as the *sole* fix: it only closes the gap up to the moment the stream subscribes; a frame lost after that (e.g. the projector's write racing the subject's `subscribe()` inside the SSE controller, or literally any dropped push) still leaves no further signal.
- **Cursor-aware connect-before-GET** — rejected: nothing in this stream design gives the client an ordinal/sequence gap it could detect after the fact ("did I miss #17?"); without that, reordering the connect doesn't add a guarantee, only shrinks a window that reordering can shrink but never close.
- **Slow backstop refetch while non-terminal — chosen.** It is the only one of the three that is unconditional: it does not depend on the stream telling the client anything. `useOrderDetailQuery`'s `refetchInterval` now returns `STALE_STATUS_BACKSTOP_MS` (5000ms) whenever the cached document is `ready` and its status is not yet `completed`/`cancelled` (`isTerminalOrderStatus`, new, exported), and `false` once terminal — so polling still stops for good once there's nothing left to converge on, exactly the ruling CLAUDE.md's synchronisation rule states in the other direction ("never poll a state the correct saga leaves within a poll interval" — the mirror is: DO keep polling every state it hasn't left yet). All in `apps/web/app/composables/useOrderDetail.ts`; `[id].vue` and `order-stream-client.ts` unchanged — the existing `onResync` fast path stays as-is, this is additive.

**Convergence test, and its armed evidence.** `apps/web/app/pages/orders/[id].spec.ts`, two new tests, both using `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`:
- *"D2 — a stream frame missed entirely still converges..."*: GET #1 returns `paid`; the fake `EventSource` reports `stream.ready { resumed: true }` and then **never emits any completion frame at all** — total, permanent frame loss, not merely a delay or a `resumed:false` (that path is the pre-existing, separate "resumed:false re-fetches" test). Asserts the badge reaches `completed` purely from the backstop's own GET, after advancing fake time past `STALE_STATUS_BACKSTOP_MS`.
- *"D2 — once a terminal status is reached, the backstop stops..."*: seeds a `completed` order from the first GET, advances fake time by 3× the backstop interval, asserts `callCount` stays at 1 — no unbounded polling after the order is done.
- **Armed**: replaced the `refetchInterval`'s ready-and-non-terminal branch with `return false;` (mirroring the pre-fix behaviour exactly) and reran just this spec file. Both D2 tests failed distinctly: test 1 → `Error: Test timed out in 5000ms` inside the `waitFor` on `'completed'` (never converges, as expected); test 2 → `A function to advance timers was called but the timers APIs are not mocked` (collateral of test 1's timeout aborting before its `finally` ran — itself evidence the mutation broke something, not a test bug). Restored the real fix; full spec file back to 12/12 green. Full unit/component suite: 65/65 green (63 pre-existing + these 2).

**D1.** Confirmed closed by construction, no test-side resilience added. With the backstop in place, `happy-path.spec.ts:100`'s `completed` wait and `compensation.spec.ts:57(now 59),60(now ~68)`'s `cancelled`/timeline waits self-heal within one 5s backstop interval regardless of what the stream does — well inside the existing 30s `expect` timeouts. `retries: 0` untouched, no timeout bumped. Verified empirically: 8/8 clean runs against a local production build (`pnpm build` + `node .output/server/index.mjs`, `NUXT_GATEWAY_BASE_URL=http://localhost:3001`), the exact configuration where the reviewer previously measured 2 failures in 7 — see below.

**D3.** `compensation.spec.ts`'s `toHaveCount(5)` replaced with an `expect.poll` on the rendered event-type list containing both `stock.released.v1` and `order.cancelled.v1`, asserting the relationship (presence of both, then release-before-cancellation ordering, unchanged below) rather than an exact count. One real bug surfaced and fixed while doing this against the live container: an initial `getByTestId('timeline-entry').filter({ hasText: 'stock.released.v1' })` locator was ambiguous — the `order.cancelled.v1` entry's own causal-link text ("caused by stock.released.v1") also contains that literal string, so the filtered locator resolved to 2 elements (a real Playwright strict-mode violation, not theoretical — hit on the first live run). Fixed by reading each entry's own second `<p>` (the eventType line only) instead of `hasText` filtering on the whole entry's text.

**D4.** One paragraph added to `compensation.spec.ts`'s header doc comment, pointing at feature 31's `assertCausalOrder` as the deterministic guard and naming this e2e assertion as a probabilistic one against the random-tie-break defect class — recorded as a caveat, no attempt made to make the e2e assertion itself deterministic (correctly out of scope per the brief).

**D6.** New "End-to-end tests" section in root `README.md` (between "Running the full stack in Docker" and "How this is being built"): the install line, the `--with-deps`-needs-sudo / plain-install-suffices caveat, both run commands (direct and root-aggregator), the "two real orders / two units of `PRD-0006` stock" cost line, and the `pnpm dev:web` incompatibility note. `feature_list.json` phase-19 row left untouched (still ⬜, out of this pass's constraints — the leader owns that).

**D5, D4's process note, cleanup-after-itself.** Not touched, per the brief: `feature_list.json` left exactly as the reviewer set it; no delete/cleanup path added for e2e-generated orders.

## Verification run, this pass

- `pnpm --filter @otc/web run lint` — exit 0.
- `pnpm --filter @otc/web run typecheck` — exit 0.
- `pnpm exec vitest run` (`apps/web`) — **14 files, 65 passed** (63 prior + 2 new D2 tests).
- **e2e against the container** (`otc-web` rebuilt with these changes, `WEB_PORT=3010`): **5/5 clean full-suite runs** (5.1s–9.7s each).
- **e2e against a local production build** (`pnpm build`, `node .output/server/index.mjs` on `:3012`, `NUXT_GATEWAY_BASE_URL=http://localhost:3001`, default `NUXT_SESSION_PASSWORD`): **8/8 clean full-suite runs** (5.5s–9.2s each) — this is the exact configuration where the reviewer measured 2 failures in 7 runs before this fix; 0 failures in 8 after it.
- Stack left healthy: all 17 containers `Up ... (healthy)`, `otc-web` rebuilt and recreated on `:3010`, `GET /login` → 200. The local :3012 server and its `.output/` build artefact were stopped/removed after verification; port 3012 confirmed free. No commit made.

## D7-D9 fixes — timeline tail convergence

**D7 — the actual fix.** Checked the leader's premise first: a *single* `refetch()` fired the instant the terminal transition is observed is NOT genuinely sufficient — it would race the very same in-flight projection that produced the terminal status (the burst's sibling facts, e.g. `credit.released.v1` alongside `order.completed.v1`, are not guaranteed to have finished projecting into the read model at the exact millisecond the status write lands). Firing the refetch immediately can reproduce the same hole one beat later, just with worse odds of catching it.

Implemented instead, in `apps/web/app/composables/useOrderDetail.ts`'s `useOrderDetailQuery`: once this client OBSERVES a transition from non-terminal to terminal (an `order.updated` frame landing, or the backstop's own GET), keep the backstop alive for exactly one further `STALE_STATUS_BACKSTOP_MS` interval — giving the projector real wall-clock time to settle the sibling fact — then stop for good. Two closure-local flags, `observedNonTerminal`/`extraPollDone`, both reset per `orderId` via a `watch` (so navigating between two order-detail pages without a full remount can't leak one order's polling history into another's). Deliberately does NOT fire the extra poll for a document that reads terminal on its very first GET — nothing was live-transitioning then, so there's no burst to suspect, and firing one anyway would have broken the pre-existing "no unbounded polling after completion" test (`callCount` stays at 1).

**New test, armed.** `apps/web/app/pages/orders/[id].spec.ts`, *"D7 — a terminal order.updated frame whose sibling timeline.appended frame is lost still renders that entry, via one further backstop poll after the terminal transition"*: GET #1 returns `paid` with one event; the fake stream delivers `order.updated → completed` live but **never** emits `timeline.appended` for `credit.released.v1`, at any point in the test — total, permanent loss of that one frame, the sibling never arrives by any route except a fresh GET. Asserts the timeline is one entry short immediately after the status transition (proving the hole exists at that instant), then asserts it closes after advancing fake time by `STALE_STATUS_BACKSTOP_MS + 50`, then asserts no further polling happens after that (`callCount` pinned at 2 through 3 more backstop intervals).

Armed: reverted just the D7 branch (`if (observedNonTerminal && !extraPollDone) {...}` → `return false;`, i.e. exact pre-fix stop-dead-on-terminal behaviour) and reran `[id].spec.ts` alone:

```
FAIL  app/pages/orders/[id].spec.ts > ... > D7 — a terminal order.updated frame whose sibling timeline.appended frame is lost still renders that entry, via one further backstop poll after the terminal transition
Error: Test timed out in 5000ms.
 ❯ app/pages/orders/[id].spec.ts:254:3

 Test Files  1 failed (1)
      Tests  1 failed | 12 passed (13)
```

Fails cleanly, for the right reason (never converges), and — confirming D9 below actually works — stays isolated: 1 failed, not 2, with no collateral timer leak into the next test (the exact failure mode D9 exists to prevent). Restored (`diff` against a pre-edit backup showed byte-identical); full spec file back to 13/13, full suite to 66/66.

**D8.** Fixed the two places the inaccurate "the only two statuses the saga does not leave on its own" claim appeared (`useOrderDetail.ts`'s `TERMINAL_ORDER_STATUSES` doc comment and the mirrored line inside `useOrderDetailQuery`'s own doc comment) to state what's actually true: `completed`/`cancelled` are the only two statuses from which the document can no longer change at all — `invoiced` is also a status the saga rests at on its own, but the document CAN still change from there (a human/n8n registers a payment), which is exactly why polling `invoiced` is correct. Logic untouched, comments only.

**D9.** Moved `vi.useRealTimers()` out of each test's per-test `try/finally` into a single `afterEach` at the `describe` level (alongside the existing `FakeEventSource.instances = []` reset), and removed the now-redundant `try/finally` wrappers from both existing D2 tests. `vi.useRealTimers()` is a documented no-op when real timers are already active, so this is safe for every test in the file, not only the fake-timer ones. Verified as load-bearing by the D7 arming run above: with the old per-test `finally`, a timeout before reaching it used to leak fake timers into the next test (this is literally what the review's own pass-2 arming log shows — 2 failed, one collateral); with `afterEach`, the same D7 timeout produced exactly 1 failure.

**D10 — left as-is, decision recorded.** Per the brief: a slow backstop GET can momentarily rewind a stream-delivered terminal status to a stale non-terminal one if the GET was in flight before the stream frame landed; it self-corrects within one backstop interval because the rewound status is non-terminal by construction and the query converges again on the next poll or the next stream frame. Any fix (e.g. comparing timestamps/versions before applying a GET response) would add real complexity to guard a transient flicker with no user-facing consequence beyond a redraw. Not fixed.

## Verification, this pass

- `pnpm --filter @otc/web run lint` — exit 0.
- `pnpm --filter @otc/web run typecheck` (`nuxi typecheck`) — exit 0.
- `pnpm exec vitest run` (`apps/web`) — **14 files, 66 passed** (65 prior + 1 new D7 test).
- **e2e against the rebuilt container** (`docker compose ... build web` then `up -d web`, `WEB_PORT=3010` — the first `up -d web` accidentally recreated on the `.env` default port 3000 because `WEB_PORT` wasn't exported; caught immediately via `docker compose ps`, corrected with `WEB_PORT=3010 docker compose ... up -d web`): **5/5 clean full-suite runs** (5.5s–9.3s each). `otc-gateway` was also rebuilt/recreated in the same pass (shared build context) and confirmed healthy throughout.
- **e2e against a local production build** (`pnpm build`, `PORT=3012 NUXT_GATEWAY_BASE_URL=http://localhost:3001 node .output/server/index.mjs`) — the configuration where the original D1 defect reproduced and where the D2 fix was measured at 8/8: **8/8 clean full-suite runs** (5.4s–9.3s each).
- Stack left healthy: all 17 containers `Up ... (healthy)`, `otc-web` on `:3010` (`GET /login` → 200), `otc-gateway` on `:3001` healthy. The local `:3012` server was killed and its `.output/`/`test-results/`/`playwright-report/` artefacts removed; port 3012 confirmed free. No commit made.
