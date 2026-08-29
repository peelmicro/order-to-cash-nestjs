# Review — `e2e_playwright` (feature 32, phase 19, `sdd: false`)

**Verdict: REJECTED** — one blocking defect (D1: the suite's terminal-state waits can hang on a permanently stale DOM; reproduced twice against a production build of this exact source). Everything else in the pass is good work: the three armed mutations all bit, the scope is exactly as briefed, and the suite found a real app-level defect the whole test pyramid below it cannot see.

Reviewer: `reviewer` subagent, 2026-08-29. Read first: `progress/impl_e2e_playwright.md`, then `apps/web/playwright.config.ts`, `apps/web/e2e/*.ts`, `apps/web/app/pages/orders/[id].vue`, `apps/web/app/pages/billing/index.vue`, `apps/web/app/composables/useOrderDetail.ts`, `apps/web/app/lib/order-stream-client.ts`.

## 1. What I ran myself (not re-run of the implementer's claims — independent)

| # | What | Where | Result |
|---|---|---|---|
| 1 | `pnpm --filter @otc/web run lint` | repo | exit 0 |
| 2 | `pnpm --filter @otc/web run typecheck` | repo | exit 0 |
| 3 | `pnpm exec vitest run` (web unit suite) | `apps/web` | **14 files, 63 passed** — matches the brief's expected 63 |
| 4 | `E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e` | `apps/web` | 3 passed (10.6s) |
| 5 | same, second independent run | `apps/web` | 3 passed (16.6s) |
| 6 | `E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e` via the **root aggregator** | repo root | 3 passed (13.8s) |
| 7 | happy-path spec only, 6 consecutive runs | container 3010 | 6/6 passed (5.2–9.2s) |
| 8 | full suite × 7 against a **local production build** (`pnpm build` + `node .output/server/index.mjs` on :3012) | local | **2 failures** — see D1 |
| 9 | `pnpm --filter @otc/web exec playwright install chromium` (the documented install line) | repo | exit 0 |

`pnpm quality` was **not** re-run in full: this pass touches only `apps/web/**` plus two `package.json` script lines, and rows 1–3 above cover that surface. No backend code changed, so C3/C4's architecture and Testcontainers claims are inherited from feature 31's review, not re-derived here.

## 2. Do the assertions genuinely bite? Yes — three mutations, three precise failures

Each mutation was applied to real app source, rebuilt with `pnpm build`, served as a real production Nitro server, and the whole suite run against it. Each was then restored with `git checkout --` and the tree re-verified.

| Mutation | Change | Result |
|---|---|---|
| **A — the causal link stops rendering** | `apps/web/app/pages/orders/[id].vue:246` — `v-if="causingEvent(...)"` → `v-if="false && causingEvent(...)"` (verified live: the string `caused by` was absent from the built bundle) | `compensation.spec.ts` **failed at line 73**: `Locator: getByTestId('timeline-entry').nth(4).getByTestId('timeline-causation')` — `element(s) not found`. `happy-path` still passed (correct isolation). |
| **C — the A1 ordering defect, re-armed** | `apps/web/app/pages/orders/[id].vue:224` — `v-for="event in data.detail.events"` → `v-for="event in [...data.detail.events].reverse()"` | `compensation.spec.ts` **failed at line 66** with its own message: `stock.released.v1 must appear BEFORE order.cancelled.v1 in the rendered timeline / Expected: < 0 / Received: 1`. The scenario-2 ordering guard is real. |
| **B — the invoice status badge lies** | `apps/web/app/pages/billing/index.vue:339` — `{{ invoice.status }}` → `{{ invoice.status === 'paid' ? 'issued' : invoice.status }}` | `happy-path.spec.ts` **failed at line 91**: `locator('[data-testid="invoice-row"]').filter({ hasText: 'ORD-000037' }).getByText('paid', { exact: true })` — not found. Scenario 3 is asserted, not assumed. |

Restoration verified: `git status --porcelain` shows exactly the implementer's five modified/untracked paths and nothing else; `git diff --stat apps/web/app/pages/` is `place.vue | 5 +++--` (the three `data-testid`s) and nothing more.

**Caveat on mutation C, stated honestly.** C proves the assertion catches a *deterministic full inversion*. The original A1 defect (`bf59af9`) was a *random* `eventId` tie-break — measured at the time as 7 of 8 orders inverted. Against that defect class this e2e assertion is a **probabilistic** guard (roughly 50–90% chance of catching it per run), not a deterministic one. The deterministic guard for that class already exists and stays where it belongs: the black-box API suite's general invariant (`assertCausalOrder`, feature 31 — for every entry whose `causationId` names another entry, cause precedes effect). Worth one sentence in the spec's header comment so a future reader does not over-trust the e2e layer here. Non-blocking.

## 3. Synchronisation — clean in intent, and one real hole (D1, blocking)

Clean: `grep` over `apps/web/e2e/**` and `playwright.config.ts` finds **no** `waitForTimeout`, no `sleep`, no `waitForLoadState('networkidle')`. Every wait is an auto-waiting `expect(...)`. Every wait targets a state that is terminal or monotonic — `invoiced` (the saga's genuine resting point until a human pays), `paid` on the invoice, `completed` / `cancelled` on the order. Feature 16's ruling ("never poll for a state the correct saga leaves within a poll interval") is respected in letter and spirit.

**D1 — BLOCKING. A terminal state is not enough if its *delivery* is not guaranteed.**

Observed twice, in two independent full-suite runs against a production build of this exact source (`pnpm build`, `node .output/server/index.mjs`, gateway on `localhost:3001`) — once during the mutation-C run, once on a clean unmutated build (iteration 3 of 4):

```
Error: expect(locator).toHaveText(expected) failed
Locator:  getByTestId('order-detail-status')
Expected: "completed"
Received: "paid"
Timeout:  30000ms
  63 × locator resolved to <div ... data-testid="order-detail-status" ...>paid</div>
```

The backend was **correct** throughout. `GET /orders/{id}` for that same order (`ORD-000029`) answers `status: completed`, with `order.completed.v1` recorded at `2026-08-29T11:07:24.534Z` — i.e. while the page was still polling. The failure screenshot (`test-failed-1.png`) shows the page badge on `paid`, the stream indicator reading **`Live`**, and the rendered timeline ending at `credit.released.v1` with **no** `order.completed.v1` entry. The page had simply not received one frame of a three-fact burst (`payment.received.v1`, `credit.released.v1`, `order.completed.v1` all share `occurredAt` to the millisecond) and had no way to recover.

Why it cannot recover — and why the test therefore hangs rather than retries:

- `apps/web/app/composables/useOrderDetail.ts:40` — `refetchInterval: (query) => data?.kind === 'pending' ? … : false`. Once a `ready` document lands, **all polling stops**; the SSE stream is the only updater from then on.
- `apps/web/app/pages/orders/[id].vue:63-71` — `connect(...)` is called from a `watch` on `data`, i.e. *after* the initial GET resolves. Anything projected in that window depends entirely on the stream's replay path to be re-delivered.
- The spec then waits on a DOM that can never change: `toHaveText` re-reads the same stale node 63 times and fails at 30s.

Both e2e specs are exposed: `happy-path.spec.ts:100` (`completed`) and, by the same mechanism, `compensation.spec.ts:57` (`cancelled`) and `:60` (`toHaveCount(5)` — a missed append leaves it at 4 forever).

Fairness note, stated plainly because it matters to the fix: the **container on 3010 did not reproduce this** — 0 failures in 9 runs (3 full suites, 6 happy-path-only), plus 10 targeted race probes (5 mid-saga page opens on a compensation order, then 4 completions opened 0/100/300/600 ms after the payment POST) that were all clean. The container's timing profile means the detail page usually loads *after* the completion projects. That is a timing accident, not a guarantee: the identical source, built and served the way the Dockerfile itself does it, is ~2-in-7 flaky. A suite whose greenness depends on which machine is faster is not yet a deliverable — and `retries: 0` (correct, keep it) means this lands as a red suite, not a retry.

**What must change (either is acceptable, implementer's choice at the leader's direction):**

1. **In the suite (small, self-contained):** make the terminal-state waits resilient to a missed frame — e.g. wrap each terminal wait in `expect.poll(async () => { await page.reload(); return (await page.getByTestId('order-detail-status').textContent())?.trim(); })`, keeping the assertion on the same terminal value. This is the standard e2e shape against an eventually-consistent backend and does not weaken any assertion. If the live-stream path is worth asserting separately, assert it separately and explicitly, rather than depending on it implicitly for the whole scenario.
2. **In the app (better product outcome, larger blast radius, leader's call):** give the detail page a slow safety-net refetch (or a resync-on-visibility) so an operator's page cannot sit on a stale status forever while its indicator claims `Live`. Then the suite's current assertion is sound as written.

I am not routing (2) as part of this feature — but I am recording it as a **genuine, user-visible app defect this e2e suite discovered**, which is exactly what an e2e suite is for. See §7.

## 4. `data-testid`s and scope

- `apps/web/app/pages/orders/place.vue` — three additions, nothing else. `company-select-trigger` and `product-select-trigger` on the two `<SelectTrigger>`s that lacked one (`retailer-select-trigger` already existed), and `quantity-input` on the quantity `<Input>`. Naming is consistent with the file's existing convention. No logic, no class, no binding changed: the whole diff is `+3 / -2`.
- `git status --porcelain` shows **only** `.gitignore`, `apps/web/app/pages/orders/place.vue`, `apps/web/package.json`, `package.json`, `pnpm-lock.yaml`, `apps/web/e2e/`, `apps/web/playwright.config.ts`, `progress/impl_e2e_playwright.md`. Nothing in `feature_list.json`, `specs/`, or any backend app. Confirmed.
- `apps/web/e2e/.auth/` is genuinely ignored (`git check-ignore -v` → `.gitignore:28`), so the sealed session cookie cannot be committed. `git status --untracked-files=all apps/web/e2e/` lists only the three `.ts` files.
- `test:e2e` is correctly **outside** `pnpm test` and `pnpm quality`, mirroring the `test:integration` precedent.

## 5. Runnability by someone else

Verified by running the documented commands verbatim, not by reading them:

- `pnpm --filter @otc/web exec playwright install chromium` — exit 0.
- `cd apps/web && E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e` — works; `dotenv -e ../../.env` supplies the operator credentials as claimed.
- Root aggregator `E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e` — works.

Two documentation gaps, both **non-blocking**, both for the wrap-up rather than the implementer:

- The install line, the `E2E_BASE_URL` requirement and the `--with-deps`-needs-sudo caveat live **only** in `progress/impl_e2e_playwright.md`. A new operator looks in `README.md`, which mentions Playwright once in a tech table and still shows phase 19 as ⬜. A short "End-to-end tests" section in `README.md` (install, the two run commands, the `--with-deps` caveat, and the "each run places two real orders" warning from §7) closes it.
- The suite cannot be run against `pnpm dev:web`: against a Nuxt dev server on :3011 the login setup fails (the click lands pre-hydration on a cold dev bundle; with a 4 s pre-fill wait the `POST /api/auth/login` returns 200 but the page does not navigate). Out of this feature's scope — the documented target is the containerised stack — but worth one line in the same README section so nobody burns an hour on it.

For completeness: one setup failure I saw (`expect(submit).toBeEnabled()` timing out) was **my own** environment artefact — a stale server process serving an old HTML that referenced already-replaced `_nuxt` assets (`HTTP 500 /_nuxt/B-INWXBY.js`). Not a suite defect; recorded so nobody mistakes it for one.

## 6. `CHECKPOINTS.md` walk

C1 — the harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer.
- [x] Every agent definition declares its model.
- [x] `./init.sh` exits 0.

C2 — state is coherent
- [x] At most one feature `in_progress` (was 0 before this review; set to 1 — feature 32 — by this rejection).
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it.
- [ ] `progress/current.md` describes the active session — **still stale**: it describes `web_app` (feature 29) and says "30/41 features done". Carried over from `review_api_tests.md`'s open findings; not caused by this feature, but the box stays empty.
- [x] Every `blocked` feature records why (none blocked).

C3 — architecture is respected (nothing in this pass touches it; inherited, spot-checked)
- [x] No forbidden imports in any `domain/` folder (unchanged this pass; ESLint rule in force).
- [x] No cross-service DB access — the suite talks only to the web UI, which talks only to the Gateway.
- [x] No shared runtime code beyond `shared-kernel` / `contracts`.
- [x] `shared-kernel` still dependency-free.
- [x] Every interaction Kafka-fact or NATS-RPC — unchanged.
- [x] No stray debug logging, no context-free TODOs in the new files.

C4 — verification is real
- [x] Lint, typecheck and the 63-test web unit suite pass (run by me). Full `pnpm quality` not re-run — surface unchanged outside `apps/web`.
- [x] Domain tests still pure (untouched).
- [x] Integration tests still Testcontainers-based (untouched).
- [x] Coverage thresholds unaffected (no source added to the coverage surface; `e2e/**` is not a Vitest target).
- [x] No Jest anywhere — `@playwright/test` is a separate runner for a separate layer, invoked outside `pnpm test`, which is the correct arrangement.
- [ ] **The delivered e2e suite is deterministic.** It is not — D1.

C5 — the session closed cleanly
- [x] No suspicious untracked files; build output (`.output/`, `.nuxt/`, `test-results/`, `playwright-report/`) is gitignored, and I removed the `test-results/`/`playwright-report/` my runs produced.
- [ ] `progress/history.md` entry with effort record — **not applicable yet**: the feature is rejected, so no history entry is written. This box is the gate for a future approval.
- [x] `feature_list.json` reflects true state (set to `in_progress` by this review).
- [ ] The human has been told what was done and how to test manually — for the leader, after rework.
- [x] Claude did not commit. No `git commit`, no `git push` in this review.

C6 — SDD: **not applicable**, feature 32 is `"sdd": false`. No `specs/<name>/` is expected and none was created; `specs/` is untouched, which is correct.

C7 — trilogy reusability
- [x] `specs/shared/` untouched by this pass, so it stays stack-agnostic (Playwright is an `apps/web` concern only).
- [x] `n8n/workflows/*.json` untouched.
- [ ] `progress/history.md` effort records complete — pending this feature's own entry.

## 7. Findings

**D1 (blocking)** — `apps/web/e2e/happy-path.spec.ts:100`, `apps/web/e2e/compensation.spec.ts:57,60`. Terminal-state waits depend on an SSE frame that can be missed; the page then cannot recover (`useOrderDetail.ts:40` stops polling once `ready`), so the assertion polls a permanently stale DOM to timeout. Reproduced twice in seven full-suite runs against a production build of this source; 0/9 against the container. See §3 for the required change.

**D2 (non-blocking, app defect, route separately)** — `apps/web/app/composables/useOrderDetail.ts:40` + `apps/web/app/pages/orders/[id].vue:63-71`. An operator's order-detail page can display a stale status indefinitely while the stream indicator reads `Live`, if a frame lands in the window between the initial `GET` and the `connect(...)` that follows it. Evidence: the failure screenshot in §3 — badge `paid`, indicator `Live`, timeline missing `order.completed.v1`, backend `completed`. This is a user-visible correctness defect found by the new e2e layer and by nothing below it. It deserves its own brief, not a fold-in here.

**D3 (non-blocking)** — `compensation.spec.ts:60`, `toHaveCount(5)`. An exact-count assertion on the compensation timeline will break the day a legitimate new fact joins that path (a notification fact, say). That strictness is defensible; just make it a deliberate choice by naming the five expected `eventType`s instead of counting them, so the failure message says *what* changed rather than *how many*.

**D4 (non-blocking)** — the scenario-2 ordering assertion is a probabilistic guard against the actual A1 defect class (random tie-break), not a deterministic one. One sentence in the spec header pointing at feature 31's `assertCausalOrder` as the deterministic guard prevents over-trust. See §2.

**D5 (non-blocking, process)** — `feature_list.json` had feature 32 at `pending` throughout implementation; it was never moved to `in_progress`. This review sets it to `in_progress`.

**D6 (non-blocking, docs)** — README has no e2e section; the install caveat lives only in the implementer log. See §5.

## 8. Judgement call — the suite places real orders against the demo stack

**The facts, measured, not estimated.** The stack was seeded with 6 orders. It now holds **60**. Roughly 12 came from the implementer's own passes, roughly 30 from this review (9 container suite runs, 7 local suite runs, 15 probe orders); each full suite run adds exactly 2 (one happy-path, one compensation) plus one invoice, one payment, one credit hold/release pair, one despatch, and the notification e-mails those facts trigger. `ALBIONFOODS`/`PRD-0006` stock is now **438 of a seeded 500**, `lowStockThreshold: 20` — the suite consumes 2 units per run and never replenishes.

**Assessment.** Two things follow from those numbers, and only one of them is about aesthetics.

The cosmetic one: Phase 24's demo would be recorded against an order list dominated by ~30 identical `CarrefourEs · ALBIONFOODS · €12.90` orders and ~15 identical `.99` cancellations, with the curated seed data (`ORD-000001`–`ORD-000006`) buried under them and references starting at `ORD-000060`. That is survivable — arguably it even makes the list look *used* — but it dilutes a demo whose whole job is to be legible.

The one that actually bites: **the suite is self-limiting and fails silently-in-kind when it runs out.** At 2 units per run it has ~219 runs of life against the current seed, after which it stops failing on the behaviour under test and starts failing on `409 / STOCK_UNAVAILABLE` at the place-order step — a failure mode the implementer already hit once during this feature (with `IBERFOODS`, which had no stock row at all) and correctly diagnosed only after live-querying `GET /stock`. A future maintainer will not have that context and will read it as a broken saga.

**Recommendation, in priority order — and no, do not build cleanup-after-itself.**

1. **Reset the stack before recording the demo, not after each test run.** `docker compose down -v` + re-seed is the existing, zero-code answer, and it gives Phase 24 the curated seed it was designed around. Record first, then run the e2e suite; or reset, then record. Put that sentence in the Phase 24 checklist. This alone resolves the entire concern.
2. **Make the suite's data self-identifying rather than self-cleaning.** Seed a dedicated retailer/company pair for e2e (`E2ETEST`-style) with its own generous stock row for the one product the suite uses. Cost: a few lines in `apps/seed`. Benefit: accumulated rows are filterable in the UI, the demo companies stay clean, and stock depletion is isolated to a row nobody demos. This is the right fix if the suite is ever wired into CI against a long-lived stack.
3. **Explicitly reject cleanup-after-itself.** Deleting these rows would mean a delete path across four service databases (Orders, Fulfillment, Billing, the Mongo read model) that exists *solely* for tests — a test-only backdoor into an event-sourced, outbox-driven system, and a standing invitation to use it in production. The facts are immutable by design; that is a feature. The suite is already safely re-runnable because it places a *new* order each time rather than mutating a fixture, which is the correct property to have optimised for.
4. **Document the cost at the point of use.** One line in the README's e2e section: "each run places two real orders and consumes two units of `PRD-0006` stock for `ALBIONFOODS`; reset the stack (`docker compose down -v` + seed) before recording a demo." Cheap, and it converts a future silent `STOCK_UNAVAILABLE` into a five-second diagnosis.

## 9. What must change before re-review

1. **D1 only.** Make both scenarios' terminal-state waits immune to a missed stream frame (reload-poll in the spec, per §3 option 1) — or fix the app's stale-page defect and keep the assertions as-is (§3 option 2). `retries: 0` stays; no timeout bumps.
2. Re-arm and re-report: after the change, run the full suite **at least five times** against the container *and* at least five times against a locally built server (`pnpm build && node apps/web/.output/server/index.mjs`, `NUXT_GATEWAY_BASE_URL=http://localhost:3001`, `NUXT_SESSION_PASSWORD=<the compose default>`), and record both. The second environment is where D1 shows; a green container run alone is not evidence.
3. Optional in the same pass, all one-liners: D3 (name the five event types instead of counting), D4 (one sentence pointing at feature 31's deterministic guard).
4. D2 and D6 are **not** blockers for this feature and should be routed separately by the leader.

## 10. State changes made by this review

- `feature_list.json`: feature 32 `pending` → `in_progress` (rejection).
- No entry appended to `progress/history.md` — a rejected feature gets no effort record and no closure.
- No commit, no push. Stack left running and healthy on `WEB_PORT=3010` (all 17 containers healthy, `GET /login` → 200); the temporary servers on :3011/:3012 used for mutation testing are stopped and their ports are free.

---

# Re-review (post-D1-D6) — 2026-08-29

**Verdict: APPROVED.** D1 and D2 are both genuinely closed, and closed at the layer where the defect actually lived (the app, not the spec). I did not take the implementer's "8/8 local" on trust: I rebuilt the fixed source myself, ran the suite 16 times against a local production build in the exact configuration where I originally measured 2 failures in 7, and — more importantly — ran two mutation probes that answer the question a green suite cannot: *does the page converge when the stream delivers nothing at all?* It does, and it does so **because of** the backstop (probe B removes the backstop and the original failure returns deterministically). Both new convergence tests bite, each against its own mutation. D3, D4 and D6 are closed as well, and D6's documented commands work verbatim, including the local-build one, with no undocumented environment variables.

## 1. What I ran myself, this pass

| # | What | Where | Result |
|---|---|---|---|
| 1 | `pnpm --filter @otc/web run lint` | repo | exit 0 |
| 2 | `pnpm --filter @otc/web run typecheck` | repo | exit 0 |
| 3 | `pnpm exec vitest run` (web unit/component suite) | `apps/web` | **14 files, 65 passed** — the brief's expected 65 |
| 4 | Full e2e suite × 8 against a **local production build** of the fixed source (`pnpm --filter @otc/web run build`, `node .output/server/index.mjs` on `:3012`, gateway `localhost:3001`) | local | **8/8 passed** (5.9–10.7 s) |
| 5 | Full e2e suite × 6 against a **second, independent rebuild** of the same source, after all mutation probes were restored | local `:3012` | **6/6 passed** (5.5–19.1 s) |
| 6 | Full e2e suite × 2 against the README's own verbatim local-build command (`node apps/web/.output/server/index.mjs` from the repo root, **no env vars at all**) | local `:3000` | **2/2 passed** (5.2 s, 9.3 s) |
| 7 | Full e2e suite × 4 against the rebuilt container | `WEB_PORT=3010` | **4/4 passed** (7.6–8.9 s) |
| 8 | Full e2e suite via the **root aggregator** (`E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e` at the repo root) | repo | passed (`apps/web test:e2e: 3 passed (8.7s)`) |
| 9 | `pnpm --filter @otc/web exec playwright install chromium` (the README's install line) | repo | exit 0 |
| 10 | Four armed mutations (two unit, two e2e) — §3 and §4 | local | all four bit, all restored |

**Headline number, against my own baseline.** Local production build, fixed source: **16 full-suite runs, 16 green, 0 failures** (rows 4+5+6). My pre-fix measurement on the identical configuration was **2 failures in 7**. Container: **5 green, 0 failures** (rows 7+8), consistent with the pre-fix container behaviour, which never reproduced it.

`pnpm quality` was again **not** re-run in full: this pass touches `apps/web/**` and `README.md` only, and rows 1–3 cover that surface completely. No backend source changed (`git diff --numstat` confirms: `.gitignore`, `README.md`, `apps/web/app/composables/useOrderDetail.ts`, `apps/web/app/pages/orders/[id].spec.ts`, `apps/web/app/pages/orders/place.vue`, `apps/web/package.json`, `feature_list.json`, root `package.json`, `pnpm-lock.yaml`, plus the untracked `apps/web/e2e/` and `apps/web/playwright.config.ts`).

## 2. Is D2 genuinely fixed — and is the fix the thing doing the work?

Sixteen green runs are evidence that the symptom is gone, but they are **not** evidence that the backstop is what removed it: the frame loss is probabilistic, and a run can be green simply because no frame was lost. So I tested the property directly, by making the loss **total and certain**.

**Probe A — every SSE frame silently dropped, backstop intact.** `apps/web/app/pages/orders/[id].vue:44-45`: `onOrderUpdated`/`onTimelineAppended` replaced with no-ops, so the stream connects, reports `stream.ready`, keeps the indicator on **`Live`**, and delivers exactly nothing to the page — a perfect, permanent, undetectable frame loss, which is precisely the D2 failure mode taken to its limit. Rebuilt, served as a real production Nitro server, full suite run three times:

```
probeA run 1: exit=0   3 passed (16.4s)
probeA run 2: exit=0   3 passed (16.0s)
probeA run 3: exit=0   3 passed (16.3s)
```

Green, three for three — and visibly slower and *tighter* in distribution (16.0–16.4 s against 5.5–10.7 s for the unmutated build), which is exactly the signature of a page converging on 5-second backstop polls instead of on instant frames. **The page reaches the true terminal status with the stream contributing literally nothing.** That is the actual property claimed, and it holds.

**Probe B — every SSE frame dropped *and* the backstop removed** (the ready-and-non-terminal branch of `refetchInterval` deleted, i.e. the exact pre-fix behaviour). Same rebuild-and-serve procedure:

```
probeB run 1: exit=1   1 failed   2 passed (39.6s)
probeB run 2: exit=1   1 failed   2 passed (34.2s)
    Error: expect(locator).toHaveText(expected) failed
    Expected: "completed"
    Received: "paid"
```

The original D1 failure signature returns, **verbatim and deterministically**, in both runs. Probe A minus probe B isolates the cause: the backstop is the load-bearing mechanism, not a bystander on a build that happened to get lucky.

Both probes were applied to real app source, rebuilt, served, run, and then restored; `git diff --numstat` afterwards matches the implementer's tree exactly, byte for byte (`useOrderDetail.ts` 46/5, `[id].spec.ts` 70/1, `place.vue` 3/2, and nothing else).

## 3. Do the convergence unit tests bite? Yes — two mutations, two distinct failures

**Mutation 1 — the fix reverted** (`useOrderDetail.ts:82` deleted, so a `ready` document returns `false` exactly as before the fix). `pnpm exec vitest run "app/pages/orders/[id].spec.ts"` → **2 failed | 10 passed**:

- *"D2 — a stream frame missed entirely still converges…"* → `Error: Test timed out in 5000ms` at `[id].spec.ts:185`. The page never converges, which is the property under test, failing for the right reason.
- *"D2 — once a terminal status is reached, the backstop stops refetching…"* → `A function to advance timers was called but the timers APIs are not mocked` at `:245` — **collateral**, exactly as the implementer reported: test 1's timeout aborts before its `finally` restores real timers, and the leak lands on the next test. Honest reporting, and it matches what I saw.

Because that second failure is collateral, it does **not** demonstrate that test 2 bites, so I armed test 2's own mutation separately.

**Mutation 2 — the terminal guard removed** (`if (data?.kind === 'ready') return STALE_STATUS_BACKSTOP_MS;`, i.e. poll forever, even after `completed`). → **1 failed | 11 passed**, and the failure is test 2's own assertion:

```
AssertionError: expected 3 to be 1
```

Three GETs where one was expected — unbounded polling caught by the test written for it. Both tests bite, each against the mutation it exists to catch.

Do they test the *real* property rather than a timer firing? Yes. Test 1's fake `EventSource` emits `stream.ready { resumed: true }` — a **genuine resume**, not a resync signal, so the `onResync` refetch path is deliberately not triggered — and then emits **nothing else, ever**. The endpoint returns `paid` on GET #1 and `completed` on every later GET. The only route from `paid` to `completed` on screen is a GET the page decided to make on its own. `expect(callCount).toBeGreaterThanOrEqual(2)` pins that it really was a second fetch, and the assertion is on rendered DOM text, not on the query cache. Restored, the file is 12/12 green and the whole suite 65/65.

## 4. D1 — closed by construction, with no test-side resilience smuggled in

Confirmed by reading the delivered specs rather than the implementer's summary: **no `page.reload()`, no `expect.poll` wrapping a reload, no `waitForTimeout`, no `retries`, no timeout increase.** `playwright.config.ts` still has `retries: 0`, `timeout: 60_000`, `expect.timeout: 30_000` — all three unchanged from the rejected pass. `grep` over `apps/web/e2e/**` finds no `waitForTimeout`, no `sleep`, no `networkidle`. The one `expect.poll` in the tree (`compensation.spec.ts`) polls a **DOM read**, not a navigation, and is D3's assertion, not a resilience wrapper. The suite is unchanged in its waiting discipline; the app now honours it.

This is the better of the two remedies I offered, and the right one: the failure was a real user-visible defect, and fixing the test would have hidden it.

## 5. D3 — is the new assertion weaker than `toHaveCount(5)`?

Not on anything load-bearing, and stronger on one point.

- **Lost:** the exact-count check. Deliberate, and exactly what I asked for — an exact count breaks on any legitimate new fact joining the compensation path, and its failure message says *how many* rather than *what*.
- **Kept:** the ordering guard (`stock.released.v1` before `order.cancelled.v1`, by index, with a message naming the invariant) and the causal-link assertions (`timeline-causation` visible, contains `caused by`, `timeline-causation-link` reads `stock.released.v1`).
- **Gained:** the causation assertions now target `timelineEntries.nth(orderCancelledIndex)` — the entry *found* to be the cancellation — where the rejected pass hardcoded `nth(4)`. That is strictly more robust and strictly more meaningful: a positional index silently asserts against whatever entry happens to sit at position 4.
- **Real bug fixed on the way, and it is genuine:** `getByTestId('timeline-entry').filter({ hasText: 'stock.released.v1' })` resolves to **two** elements, because the cancellation entry's own causal-link text contains the literal string `stock.released.v1` ("caused by stock.released.v1"). That is a real Playwright strict-mode violation on this exact page, not a hypothetical, and the fix — reading each entry's own second `<p>` — removes the ambiguity at the source instead of `.first()`-ing past it.
- The helper is not vacuous: `expect.poll(readEventTypes).toEqual(expect.arrayContaining([...]))` passing on 21 live runs proves `readEventTypes` returns real event types; a mis-indexed `<p>` read would return empty strings and the poll would time out.

One thing I did **not** re-arm this pass, stated so nobody assumes it: the DOM-inversion mutation (`v-for="event in [...data.detail.events].reverse()"`) that I used in review 1 to prove the ordering assertion bites. My attempt was blocked by the environment's edit-permission classifier, and I chose not to work around it. The ordering assertion's *logic* is unchanged (`indexOf` comparison with the same message); only the array it reads changed, and the poll above proves that array is real. Residual risk: low, and bounded to "the ordering assertion reads the right values" — which the passing poll already evidences.

## 6. D4 — the probabilistic-guard caveat

It is in `compensation.spec.ts`'s **file header doc comment**, above the single `test(...)` — the first thing anyone opening the file reads, which is where a caveat about how much to trust this test belongs (better than the mid-file comment I suggested). It says the assertion catches a full deterministic inversion but is not guaranteed to catch every instance of a random `eventId` tie-break, and names feature 31's black-box `assertCausalOrder` — *"every entry whose `causationId` names another entry, cause precedes effect, checked for ALL entries"* — as the deterministic guard. Correct pointer, correct framing ("a real-browser confirmation on top of that guard, not a replacement for it").

## 7. D6 — the README section, checked by running it, not reading it

The new "End-to-end tests" section sits between "Running the full stack in Docker" and "How this is being built", i.e. where an operator would look. All four required elements are present, and every command works verbatim:

- `pnpm --filter @otc/web exec playwright install chromium` — exit 0 (run).
- The `--with-deps`/sudo caveat — present, and accurate about why plain `install chromium` is the documented default.
- `cd apps/web && E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e` — run 4×, green.
- Root aggregator, same env var — run, green.
- **`pnpm build && node apps/web/.output/server/index.mjs`** — run **exactly as written, from the repo root, with no environment variables whatsoever**: server up on `:3000`, suite green 2/2 against it. This works because `nuxt.config.ts:30-31` defaults `gatewayBaseUrl` to `http://localhost:3001` and `sessionPassword` to the compose default — so the README is not quietly relying on the operator having exported anything.
- The two-orders-and-two-stock-units cost line — present, with the "reset before recording a demo" instruction and a pointer to §8 for why cleanup-after-itself is rejected.
- The `pnpm dev:web` incompatibility — present, with the reason (click lands pre-hydration on the cold dev bundle).

## 8. No regression to Pass 3's SSE guarantees

`apps/web/app/lib/order-stream-client.ts` and `apps/web/app/composables/useOrderStream.ts` are **untouched** (not in `git status`). The change is additive, in one function.

- **R51 dedup, transport level:** the per-type `seenOrderUpdateIds`/`seenTimelineEntryIds` sets and the seeding from the initial GET are unchanged; the test *"R51 — a live timeline.appended frame is rendered, and a redelivered frame (same eventId) never produces a second entry"* passes.
- **R51 dedup, reducer level:** `applyTimelineAppended`'s `events.some(existing => existing.eventId === entry.eventId)` guard is unchanged and is precisely what protects the new interaction — a backstop refetch replaces the cached document, and a stream frame arriving afterwards for an event the refetch already brought in is dropped by the reducer even though the transport's seen-set was never told about it. No duplicate entries are possible; the 21 live runs corroborate (a duplicated timeline entry would have shifted `indexOf` and is exactly what the ordering assertion reads).
- **`resumed: false` resync:** `onResync → refetch()` in `[id].vue:51-53` is unchanged; the test *"resumed:false re-fetches the order detail instead of silently keeping stale data on screen"* passes. The backstop is explicitly documented as additive to it, not a replacement.

## 9. Judgement — is the backstop the right engineering call, or is it papering over?

**It is the right call, and it is not papering over.** Four questions, answered on evidence rather than taste.

**Does it genuinely converge when a frame is lost silently — the actual property?** Yes, and this is now measured rather than argued: probe A drops 100% of frames and the page still reaches the true terminal status, three runs out of three; probe B shows the failure returns the moment the backstop is removed. The convergence does not depend on the stream telling the client anything, which is the whole point — the alternatives the implementer rejected both do.

**Was the rejection of the alternatives correct?** Yes, and for a stronger reason than the implementer gives. I checked the contract itself: `specs/shared/openapi.yaml`'s `/orders/stream` documents exactly two client inputs — an `orderId` query parameter and the `Last-Event-ID` **header**, which the spec itself notes is "sent automatically by browser EventSource implementations on reconnect". A browser `EventSource` gives JavaScript no way to set that header on a *first* connect, and the endpoint exposes no `cursor` query parameter, so "connect first with the GET's cursor" is **not expressible** in this contract with the native transport — it is not merely unhelpful, it is unavailable. And the frame `id` is documented as *opaque*; it looks like `1755511234567-17`, but a client that treated it as a gapless sequence and inferred "I missed one" would be resting on an undocumented invariant of a buffer shared across orders. So gap detection is genuinely outside the contract, and a client that cannot detect a gap can only guarantee convergence by consulting the source of truth on its own schedule. That is a backstop, by definition.

**Is 5 s a defensible interval?** Yes, and there is a concrete internal benchmark rather than a feeling: this same app **already** polls `useOrders.ts:25`, `useStock.ts:33` and `useBilling.ts:33,67` at `refetchInterval: 4_000` — unconditionally, on every list view, with no stream at all. The order-detail backstop is *slower* than every existing poll in the codebase, and unlike them it is *conditional*: it stops dead at `completed`/`cancelled`. So the marginal load is one `GET /orders/{id}` every 5 s per open detail page on a still-live order — 12 requests/minute against a Mongo read-model document read, versus the 15/minute the order list already spends. It is not a retreat from the live-stream design either: the stream remains the primary path and still delivers sub-second updates on every run where nothing is lost (5–10 s suite runtimes with the stream working; 16 s when I killed it). Calling this "a 5 s poll on a page whose premise is SSE" understates what changed — the premise is unchanged, a floor was added under it.

**Does stopping at terminal leave a hole?** For the *status*, no: `completed` and `cancelled` are the only two terminal values in `OrderStatus` (`openapi.yaml:1126-1135`), and once reached there is nothing left to converge on. For the *timeline*, there is a narrow residual hole, recorded below as **D7** — it is the one real gap in the fix, it is much smaller than what it replaced, and it has a one-line remedy inside the existing contract.

**The honest limitation is the contract, not this pass.** An SSE stream whose cursor is opaque and whose only resume mechanism is a header the browser controls cannot tell a client that it missed something. Any client of it must either poll or accept permanent staleness. If this system ever wants the stream to carry that guarantee itself, the change belongs in `specs/shared/openapi.yaml` — a per-subscription, gapless, client-comparable sequence number on content frames (plus a client-settable cursor parameter so the first connect can resume too), which would let the page detect a gap and refetch **on demand** instead of on a timer, and would let the backstop be dropped entirely. That is a design amendment for a future feature, not a defect in feature 32, and I am not routing it here.

## 10. Findings from this pass (all non-blocking)

**D7 (non-blocking, narrow residual of the D2 fix) — `apps/web/app/composables/useOrderDetail.ts:82`.** The backstop guards the *status*, and stops when the status goes terminal — but a timeline entry has no such guarantee. If the `order.updated` frame carrying `completed` arrives while the `timeline.appended` frame for a sibling fact of the same burst (e.g. `credit.released.v1`, which shares `occurredAt` with `order.completed.v1`) is lost, polling stops with the timeline permanently one entry short, and the page looks entirely healthy. Cheap remedy inside the current contract, at a cost of exactly one extra GET per order: when an `order.updated` frame moves the cached status into a terminal value, fire one final `refetch()` before polling stops. Probability is low (it needs selective loss within one burst rather than the whole-burst loss that produced D1), impact is an incomplete audit trail rather than a wrong status, and 21 live runs did not hit it — hence non-blocking. Worth a line in the composable's own doc comment even if it is never fixed.

**D8 (non-blocking, comment accuracy) — `useOrderDetail.ts:14-18`.** The comment justifies the terminal set as "the only two statuses the saga does not leave on its own". That is not quite true: `invoiced` is also a status the saga does not leave on its own — it waits for a human (or n8n) to register a payment, which is precisely why `happy-path.spec.ts` treats it as a resting point. Continuing to poll `invoiced` is *correct* (the payment can arrive from another actor and the page must converge on it), so the behaviour is right and only the stated reason is wrong. The accurate formulation is "poll until the document can no longer change" — which is what the code does.

**D9 (non-blocking, test hygiene) — `apps/web/app/pages/orders/[id].spec.ts:186,227`.** `vi.useFakeTimers()` is restored in a per-test `finally`, so a test that times out *before* reaching its `finally` leaks fake timers into the next test — which is exactly what happened under mutation 1 and turned a clean single failure into two, one of them misleading. A `afterEach(() => vi.useRealTimers())` makes failures non-contagious and costs one line.

**D10 (non-blocking, transient) — `applyOrderStreamUpdate`, `useOrderDetail.ts:95`.** A backstop GET issued before a fact projects can now land *after* a stream frame carrying that fact, momentarily rewinding the displayed status (e.g. `completed` → `paid`). It self-corrects within one backstop interval because the rewound status is non-terminal by construction, so this is a flicker rather than a defect, and the same last-writer-wins shape predates this change (a `resumed:false` refetch could always race a frame). Recorded so a future reader who sees it does not diagnose it as a new bug.

**Carried, unchanged:** D5 (process — feature 32 sat at `pending` through implementation; closed by this review), and `progress/current.md` still describing feature 29 (four features stale, carried from `review_api_tests.md`).

**§8's data-cost numbers, re-measured after this pass:** `otc_orders.orders` now holds **140** rows (60 at review 1), and `ALBIONFOODS`/`PRD-0006` stock is **358 of a seeded 500** (438 at review 1) — my own 21 full-suite runs plus the implementer's 13 account for the difference. At 2 units per run there are ~169 runs of headroom before the suite starts failing on `409 / STOCK_UNAVAILABLE` instead of on the behaviour under test. §8's recommendations stand unchanged; the README now carries recommendation 4.

## 11. `CHECKPOINTS.md` walk (re-review)

C1 — the harness is complete
- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer.
- [x] Every agent definition declares its model.
- [x] `./init.sh` exits 0 (unchanged this pass).

C2 — state is coherent
- [x] At most one feature `in_progress` (feature 32 was the only one; set to `done` by this review).
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it.
- [ ] `progress/current.md` describes the active session — **still stale** (describes `web_app`, feature 29). Carried, not caused here.
- [x] Every `blocked` feature records why (none blocked).

C3 — architecture is respected
- [x] No forbidden imports in any `domain/` folder (no backend source touched; ESLint rule in force).
- [x] No cross-service DB access — the suite drives the web UI, which talks only to the Gateway through its own server proxy.
- [x] No shared runtime code beyond `shared-kernel` / `contracts`.
- [x] `shared-kernel` still dependency-free.
- [x] Every interaction Kafka-fact or NATS-RPC — unchanged; the backstop is an HTTP GET through the existing `/api/orders/{id}` proxy, not a new transport.
- [x] No stray debug logging, no context-free TODOs in the changed files.

C4 — verification is real
- [x] Lint, typecheck and the 65-test web suite pass (run by me).
- [x] The two new tests are armed-and-verified by me, independently, with two different mutations.
- [x] Domain tests still pure; integration tests still Testcontainers-based (both untouched).
- [x] Coverage thresholds unaffected (`e2e/**` is not a Vitest target; the composable's new branch is covered by the two new tests).
- [x] No Jest anywhere.
- [x] **The delivered e2e suite is deterministic** — 16/16 on the configuration that previously failed 2 in 7, 5/5 on the container, and green under total frame loss (probe A). This box was the rejection; it is now met.

C5 — the session closed cleanly
- [x] No suspicious untracked files; `.output/`, `test-results/`, `playwright-report/` removed after my runs; `apps/web/e2e/.auth/` gitignored and absent from `git status --untracked-files=all`.
- [x] `progress/history.md` entry with effort record — appended by this review.
- [x] `feature_list.json` reflects true state (`in_progress` → `done`).
- [x] The human will be told what was done and how to test manually — by the leader, from this file.
- [x] Claude did not commit. No `git commit`, no `git push` in this review.

C6 — SDD: **not applicable** (`"sdd": false`). `specs/` untouched by this pass, correctly.

C7 — trilogy reusability
- [x] `specs/shared/` untouched — Playwright stays an `apps/web` concern, and the *finding* about the SSE contract in §9 is written as a design observation rather than smuggled into the shared spec.
- [x] `n8n/workflows/*.json` untouched.
- [x] `progress/history.md` effort records complete — feature 32's is appended by this review.

## 12. State changes made by this re-review

- `feature_list.json`: feature 32 `in_progress` → **`done`**.
- `progress/history.md`: entry appended, with the effort record.
- Everything I armed was restored; `git diff --numstat` matches the implementer's tree exactly, and `sed -n '224p' apps/web/app/pages/orders/[id].vue` reads the unmutated `v-for="event in data.detail.events"`.
- Temporary servers on `:3012` and `:3000` stopped, both ports confirmed free; `apps/web/.output/` and all `test-results/`/`playwright-report/` artefacts removed.
- Stack left healthy on `WEB_PORT=3010`: 17/17 containers `healthy`, `GET http://localhost:3010/login` → 200.
- No commit, no push.
