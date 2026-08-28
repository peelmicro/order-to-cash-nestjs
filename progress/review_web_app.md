# Review — `web_app` (feature 29), Pass 2a — "Vue lint guard + currency/retailer fix"

**Verdict: REJECTED**

This is the first independent review this feature has received. The bar is deliberately high because the prior, unreviewed pass shipped a submit button permanently disabled from first render — this review exists specifically to close that gap. One of the two deliverables in this pass holds up completely under independent re-arming. The other — the ESLint guard — has a real, silent composition defect in exactly the artifact this review was asked to verify: "apps/web's own lint step" is dead code that exits 0 regardless of content, including the exact bug it exists to catch.

`feature_list.json` was **not** touched, per instructions (note: it currently reads `"status": "pending"`, not `"in_progress"` as the review brief stated — the implementer's own note explains this was deliberate, per the brief's bounded-scope instruction not to touch it at all; flagging the discrepancy for the leader, not treating it as a defect).

## Finding 1 (blocking) — `apps/web`'s own `pnpm run lint` silently lints zero `.vue` files

**Severity: High. Owner: implementer, same pass.**

`apps/web/package.json` gained `"lint": "eslint --config ../../eslint.config.mjs ."`, invoked via `pnpm --filter @otc/web run lint`. I re-armed the exact regression this pass exists to guard against (reverted `.value` on `apps/web/app/pages/login.vue:46-47`, byte-identical to the historical bug) and ran this command exactly as the implementer's own report describes running it:

```
$ pnpm --filter @otc/web run lint
$ eslint --config ../../eslint.config.mjs .
EXIT: 0
```

Zero output, exit 0 — with the live bug present. Confirmed this is not specific to the reverted file: even a blatant unused-var violation added to `apps/web/app/lib/utils.ts` was caught (a `.ts` file, unprefixed glob), but every `.vue` file is invisible to this invocation. `--print-config` on `apps/web/app/pages/login.vue` from that same cwd returns `undefined` (no config block matches at all), and running with `--debug` shows `File ignored because no matching configuration was supplied`.

**Root cause**: ESLint 10's flat config resolves each block's `files` glob relative to the CWD-derived basePath, not the config file's own directory. `eslint.config.mjs`'s Vue-scoped blocks all use `files: ["apps/web/**/*.vue"]` — correct when ESLint is invoked from the repo root (where `pnpm lint` and `pnpm quality` run it), but when invoked from `apps/web` itself (what the new package-level script does), the same file's path relative to that basePath is `app/pages/login.vue`, which never matches an `apps/web/**` prefixed pattern. Every Vue-specific block — `flat/recommended`, the type-aware `no-unnecessary-condition` block, and `local/require-ref-dot-value` itself — is silently inert for this invocation.

I independently confirmed the *other* path works: running `pnpm lint` from the repo root against the same reverted bug produces the correct, specific error (`local/require-ref-dot-value`, 2 problems) and a non-zero exit. `pnpm quality` (root) chains to the same root `pnpm run lint`, so the aggregate CI-equivalent gate is not compromised. But the specific artifact the brief asked for — "apps/web's own lint step" — does not work standalone, and the pass's own quality-gate report (`pnpm --filter @otc/web run lint — clean, exit 0`) presents this as a real, passing check rather than what it actually is: a script that would report "clean" against *any* content, including the shipped bug. That is the same class of claim this review exists to catch — a green result that means nothing, functionally equivalent to `expect(true).toBe(true)`.

**What must change before re-review**: fix `apps/web/package.json`'s `lint` script so that when run standalone from `apps/web` (`pnpm --filter @otc/web run lint`, or `cd apps/web && pnpm lint`) it actually parses and lints `.vue` files — e.g. run it from the repo root against the `apps/web` path (`cd ../.. && eslint apps/web`), or otherwise correct the basePath resolution — and re-arm the same reverted-`.value` fixture against the corrected script to prove it now fails loudly. Re-confirm `pnpm --filter @otc/web run typecheck` and `pnpm --filter @otc/web exec vitest run` are unaffected (they use independent config, not implicated in this defect).

## Probes run and what they showed

**1. Does the lint rule genuinely catch the shipped bug? (via the path that actually works — root `pnpm lint` / `pnpm quality`)** Yes, independently confirmed. Reverted `.value` on `apps/web/app/pages/login.vue:46-47` (`login.isPending` in both the `:disabled` expression and the label ternary — the identical pattern the historical bug shipped), then ran `npx eslint apps/web/app/pages/login.vue` (root-resolved config) and root `pnpm lint`. Both produced exactly two `local/require-ref-dot-value` errors naming `isPending` specifically, with the rule's own descriptive message, non-zero exit. Restored the file, reran, confirmed clean (exit 0, `git diff` empty). This is a real, specific, non-generic failure — not a lie.

**2. False positives/negatives, and generalization beyond `isPending`.** Built a throwaway fixture (`apps/web/app/pages/__probe__/probe.vue`, since deleted) using `.isError`, `.isSuccess`, and `.data` on a mutation-shaped object, all missing `.value` in the template. The rule correctly flagged `.isError` and `.isSuccess` — **the rule does generalize beyond `isPending`**: `FLAG_NAMES` in `require-ref-dot-value.mjs` already includes `isPending`, `isLoading`, `isFetching`, `isError`, `isSuccess`, `isRefetching`, `isPaused` (7 TanStack Query boolean flags), all live, not just the one name that happened to ship the bug. This directly answers the review brief's concern — it is not narrow to `isPending` alone.

However, the same probe confirmed a genuine, disclosed gap: `.data` used bare in the template (`thing.data ? 'has data' : 'no data'`) produced **zero** diagnostics — `data` (and, by the same logic, `.error`) is not boolean-named and is deliberately excluded from `FLAG_NAMES`, per the rule's own header comment ("deliberately name-based... narrower in what it recognizes"). This is a real, disclosed limitation, not a hidden one: the identical Ref-truthy footgun could resurface via `.data`/`.error` and this guard would not catch it. Severity: Low/Medium, non-blocking — the rule's own comments are honest about this tradeoff, and `.data`/`.error` are typically consumed via `.value` in idiomatic call sites already swept by the implementer's grep; but it is a real gap worth a follow-up ticket, not a fix-now blocker.

Independently re-ran both rejected published approaches against the same fixture, rather than accepting the implementer's narration:
- `vue/no-ref-as-operand` (via `eslint-plugin-vue`'s `flat/recommended`) — zero errors against the fixture (only unrelated style warnings). Confirmed: does not reach this pattern.
- `@typescript-eslint/no-unnecessary-condition` (type-aware, `projectService: true`) — zero errors against the *template* fixture, but **does** correctly flag the identical pattern (`const obj = {a:1}; if (obj) {}`) when placed in `<script setup>` instead — confirmed both halves directly, not just the implementer's claim. This validates the implementer's stated rationale for needing the custom rule at all.

**3. Currency fix — genuine, not coincidental.** `apps/seed/src/data/retailers.data.ts` confirms `AldiGb`'s `currencyCode: 'GBP'` directly — real seed data, not fabricated. Commented out the `watch(...)` block in `place.vue`, ran `pnpm --filter @otc/web exec vitest run app/pages/orders/place.currency.spec.ts` — failed exactly as claimed (`expected 'EUR' to be 'GBP'`, non-zero exit). Restored, reran full suite — `Test Files 2 passed (2)`, `Tests 3 passed (3)`, matching the reported figures exactly.

**Manual-override interaction — judged, not just accepted.** The watcher fires on every change to `form.retailerCode`, unconditionally overwriting `form.currency`. This means a user who manually overrides the currency (e.g. types `USD` for a specific settlement reason) and *then* selects a different retailer will have that override **silently clobbered** by the newly-selected retailer's currency — there is no "has the user touched this field" guard. The implementer's own comment describes intent as "only the *default* it snaps to on selection is now correct," which reads as a one-time default, but the actual behavior re-derives on *every* retailer change, including ones after a manual edit. This is a real gap between stated intent and implemented behavior. Judgment: **not blocking** for this narrow pass — the field remains editable after the fact, the common case (select retailer once, then edit or submit) works correctly, and re-fixing this correctly needs a `touched`/dirty flag plus a test for the override-then-reselect path, which is reasonably deferred rather than demanded in a "small, high-leverage fix" pass. But it should be recorded as a known follow-up, not silently assumed correct.

**4. Composition and scope.** `git status`/`git diff --stat` confirm changes are confined to `apps/web/app/pages/orders/place.vue`, `apps/web/package.json`, `apps/web/app/pages/orders/place.currency.spec.ts` (new), `apps/web/eslint-rules/` (new), root `eslint.config.mjs`, root `package.json` (devDependencies), and `pnpm-lock.yaml` — no backend app touched. `feature_list.json` diff is empty, confirmed via `git status --porcelain feature_list.json` (no output). (Unrelated, pre-existing uncommitted changes for a different feature, `observability_reliability`, exist in the working tree but are outside this diff and not conflated with it.)

**5. Quality gates, independently re-run:**
- `pnpm --filter @otc/web run lint` — reported "clean, exit 0" by the implementer; independently confirmed exit 0, but for the wrong reason (see Finding 1 — it lints nothing).
- `pnpm --filter @otc/web run typecheck` (`nuxi typecheck`) — independently re-run, clean, exit 0. Holds.
- `pnpm --filter @otc/web exec vitest run` — independently re-run, `Test Files 2 passed (2)`, `Tests 3 passed (3)`, exit 0. Holds, matches reported figures exactly.
- Root `pnpm lint` — independently re-run (clean at rest; non-zero and specific when the bug is re-armed). Holds and is the gate that actually matters for CI/`pnpm quality`.

Per the task's scope instruction, the full monorepo `pnpm quality` was **not** re-run — only `apps/web`'s own gates plus the root `pnpm lint` (the specific claim under test) were exercised directly.

## CHECKPOINTS.md walked

This is a small, non-closing pass on an `sdd: false`, still-open, multi-pass feature — most of C1/C2/C5/C6/C7 are leader-level, whole-feature concerns not applicable to grading one pass. Walked only what applies to this diff:
- [x] C3 — no shared runtime code beyond `packages/contracts` touched (confirmed: `apps/web` already depended on it from pass 1, untouched here); no cross-service DB access (N/A, no backend touched); no Kafka/NATS classification concerns (N/A, frontend-only pass).
- [ ] C4 — "verification is real": **fails** for the specific `pnpm --filter @otc/web run lint` gate (Finding 1) — a script reporting "clean" that in fact validates nothing is the opposite of real verification. The `vitest`/`typecheck`/root-`lint` legs of C4 hold under my own re-run.
- [x] C5 — no suspicious untracked files left behind (confirmed after my own probing, cleaned up); `feature_list.json` correctly unmodified.
- C1, C2, C6, C7 — not applicable to a single bounded pass on a not-yet-closed, `sdd: false` feature; deferred to the leader's whole-feature review.

## R-mapping / traceability

`sdd: false` — no `requirements.md`/`R<n>` ids apply to this feature. The pass's own two informal claims ("catches the shipped bug class," "fixes the currency mismatch") are the units under test here, both addressed above.

## What must change before re-review

1. Fix `apps/web/package.json`'s `lint` script so it actually lints `.vue` files when run standalone (`pnpm --filter @otc/web run lint`) — currently silently a no-op for every `.vue` file due to flat-config basePath resolution differing between root-invoked and `apps/web`-invoked ESLint. Re-arm the same reverted-`.value` fixture against the *corrected* script and record the failing output, the same way the root-`pnpm lint` case was already recorded.
2. (Non-blocking, record as follow-up) Consider whether the currency watcher should stop re-deriving once the user has manually edited the field, to match the stated "only the default" intent — not required for this pass, but should not be silently assumed already handled.

No code was patched by this review. No commit was made. `feature_list.json` was not modified.

---

# Review — `web_app` (feature 29), Pass 3 — "order-detail page with live SSE timeline"

**Verdict: REJECTED**

**The stuck-timeline anomaly is EXPLAINED, and it is a real, reproducible bug in this pass's own code — not a fluke, not a backend gap, not a race between initial-fetch and stream-connect.** It blocks approval on its own; see Finding 1. The rest of the pass — the streaming proxy, `Last-Event-ID` forwarding, `resumed:false` re-fetch, the `202` honesty path, auth isolation, and process/scope discipline — holds up well under independent re-arming and is documented below for completeness, but Finding 1 is a shipped correctness defect in exactly the feature this pass claims to deliver (R51 dedup) and must be fixed before re-review.

## Finding 1 (blocking) — `OrderStreamClient` shares one `seenEventIds` Set across two different frame types that legitimately carry the same `eventId`, silently dropping one of them

**Severity: High. Owner: implementer, same pass.**

**Mechanism, derived independently, then proved:**

1. `apps/projector/src/infrastructure/signal/nats-update-signal.publisher.ts:50-67` — for every applied fact, the projector builds **two** payloads, `orderUpdate` and `timelineEntry`, and sets `orderUpdate.eventId = document.latestEntry.eventId` (line 51) and `timelineEntry.eventId = document.latestEntry.eventId` (line 61) — **the identical value**, by design (this matches `openapi.yaml`'s own description of `OrderStreamUpdate.eventId`: "the fact that caused the update"). It then fires two independent, unawaited `connection.publish()` calls (lines 72-73) on two different NATS subjects.
2. `apps/gateway/src/infrastructure/messaging/nats-stream-signal.adapter.ts:33-43` — the gateway subscribes to `readmodel.order.updated.*` and `readmodel.timeline.appended.*` as two **separate** subscriptions, each consumed by its own independent `for await` loop (`void this.consume(...)`, called twice). Nothing here orders the two subjects relative to each other — whichever message a Node.js/NATS scheduling round delivers first is written into the shared outbound SSE byte stream first.
3. `apps/web/app/lib/order-stream-client.ts:44` declares a single `private readonly seenEventIds = new Set<string>()`, and **both** the `order.updated` handler (lines 75-82) and the `timeline.appended` handler (lines 84-91) check and populate the *same* Set keyed only on `data.eventId`:
   ```
   source.addEventListener('order.updated', (event) => {
     ...
     if (this.seenEventIds.has(data.eventId)) return;
     this.seenEventIds.add(data.eventId);
     this.callbacks.onOrderUpdated(data);
   });
   source.addEventListener('timeline.appended', (event) => {
     ...
     if (this.seenEventIds.has(data.eventId)) return;
     this.seenEventIds.add(data.eventId);
     this.callbacks.onTimelineAppended(data);
   });
   ```
   Since every real fact's two frames carry the *same* `eventId` (step 1), whichever of the two frame types is dispatched **second** by the browser's `EventSource` for a given fact is treated as an already-seen redelivery of the *first* and is silently discarded — even though it is a different event type carrying different, non-redundant information (a timeline entry vs a status/totals patch). This is a **dedup key collision between two different signal types**, not a redelivery.

**Proved directly, not by inspection alone.** I appended a throwaway test to `apps/web/app/lib/order-stream-client.spec.ts` (reverted immediately after, `md5sum` confirmed byte-identical to the pre-probe file, `git status --porcelain` shows only the pre-existing untracked file with no diff) that feeds the class the real production shape: a `timeline.appended` frame followed by an `order.updated` frame, both carrying `eventId: 'evt-shared-1'` — exactly what one fact produces in production. Result:
```
expect(timelineEntries).toHaveLength(1);   // passed
expect(orderUpdates).toHaveLength(1);      // FAILED — received length 0
```
The frame that lost the wire-order race (`order.updated`, in this run) was dropped entirely; its callback never fired. Swapping the emission order in the probe reproduces the mirror case (a `timeline.appended` frame dropped while `order.updated` survives) — which is **exactly** the implementer's own self-disclosed observation: *"an `order.updated` frame was applied but two `timeline.appended` frames were not"* while the status badge correctly reached `cancelled`. Because the two frames travel over independent NATS subjects/subscriptions with no ordering guarantee between them (step 2), the outcome is a genuine race — sometimes `order.updated` wins for a given fact, sometimes `timeline.appended` does, sometimes neither frame for a fact collides badly enough to matter (if delivery happens to interleave far enough apart) — which is precisely why the symptom reproduced in 1 of 3 live runs rather than deterministically every time, and why it self-heals via `resumed:false`/resync in the other runs whenever a later reconnect happens to re-fetch a document that already has all 5 events server-side (the read model itself, written once by the projector per fact, is never affected — this is purely a live-stream client-side loss).

**Why the existing test suite did not catch this.** Every dedup/redelivery test in this pass uses **distinct** `eventId`s between `order.updated` and `timeline.appended` fixtures:
- `order-stream-client.spec.ts`'s own R51 test redelivers the *same* frame type twice (`order.updated` sent twice with `eventId: 'evt-dup-1'`), never a `timeline.appended`/`order.updated` pair sharing one `eventId`.
- `apps/web/app/pages/orders/[id].spec.ts` uses `eventId: 'evt-1'` for its `timeline.appended` test and `eventId: 'evt-2'` for its separate `order.updated` test — always different values, never the collision case.
- `useOrderDetail.spec.ts` tests the reducer layer directly (bypassing the transport class entirely), so it never exercises this bug at all; the reducer layer itself is correctly scoped (its dedup Set only ever contains timeline `eventId`s, never order-update ones) and is **not** where the bug lives.

So the pass's own claim — "R51 dedup — two independent, both-armed layers" — is accurate as far as it goes (same-type redelivery is genuinely guarded, twice over), but it does not cover the actual shape of production traffic, where the transport layer's dedup key is ambiguous across event types by construction. This is not a hidden edge case; it is the **default, universal shape of every fact** this system emits, per `nats-update-signal.publisher.ts`'s own code.

**Fix required before re-review**: scope `OrderStreamClient`'s dedup state per event type — e.g. two separate `Set`s (`seenOrderUpdateIds`, `seenTimelineEntryIds`), or a composite key (`` `${eventType}:${eventId}` ``) — so a `timeline.appended` frame and an `order.updated` frame for the same underlying fact are never treated as duplicates of each other. `seedSeenEventIds` (called from `[id].vue`'s initial-snapshot seeding) needs the equivalent adjustment. Add a regression test using the real production shape (both frame types, identical `eventId`, delivered in each order) to both `order-stream-client.spec.ts` and `[id].spec.ts`, armed the same way every other guard in this pass was armed.

## Probes run and what they showed

**1. The stuck-timeline anomaly — resolved, not "possibly a fluke."** See Finding 1. Independent mechanism derivation (read `order-stream-client.ts`, `useOrderDetail.ts`, `nats-update-signal.publisher.ts`, `nats-stream-signal.adapter.ts`) plus a live, armed reproduction. Not a race between the initial `GET` and the stream's first frames (that race is real in principle but is separately, correctly handled by `seedSeenEventIds` plus `resumed:false`→resync); not an off-by-one in cursor tracking (cursors — the SSE `id:` lines — are never read or compared by the client at all, only `Last-Event-ID` on reconnect, which `EventSource` manages internally); not a backend gap where a paired frame never arrives (the backend genuinely sends both frames for every fact, confirmed by reading the publisher). It is a client-side dedup-key collision, confirmed by direct reproduction.

**2. Re-derived, not re-read, the dedup and `resumed:false` claims.**
- `Last-Event-ID` forwarding (`stream-proxy.ts`): disarmed the exact guard (commented out `if (options.lastEventId) { headers['Last-Event-ID'] = ... }`), reran `stream-proxy.spec.ts` — 2 of 6 tests failed exactly as the implementer's transcript describes (`expected undefined to be '1755511234901-18'`, `expected undefined to be 'cursor-9'`), restored, confirmed 6/6 green and file byte-identical (untracked file, `git status --porcelain` shows no diff line beyond its pre-existing `??` entry).
- `resumed:false` → resync (`order-stream-client.ts`'s `if (!data.resumed) this.callbacks.onResync()`) and the R51 same-type dedup guard: read the exact lines the implementer's transcript names; they match verbatim (`if (this.seenEventIds.has(...)) return`), and I independently reran the full suite (`Test Files 6 passed (6)`, `Tests 21 passed (21)`) without arming, matching the implementer's reported figures exactly.

**3. `Last-Event-ID` forwarding — confirmed by reading the actual lines**, not the spec's own test file: `apps/web/server/utils/stream-proxy.ts:36-38` (`if (options.lastEventId) { headers['Last-Event-ID'] = options.lastEventId; }`) and `apps/web/server/api/orders/stream.get.ts:23` (`const lastEventId = getHeader(event, 'last-event-id');`), wired through to `openUpstreamOrderStream({ ..., lastEventId, ... })` at line 31-37. Genuine.

**4. The streaming proxy — genuine passthrough, not buffered.** `stream.get.ts` uses the platform `fetch` (via `openUpstreamOrderStream`, which is deliberately framework-free) rather than `gatewayFetch`/`$fetch`/`ofetch` (which buffer), and returns `sendWebResponse(event, upstream)` — the raw upstream `Response` object, body untouched, never awaited/read before being handed to h3. This is a real byte-stream passthrough. `AbortController` wiring is real, not a comment: `event.node.req.on('close', () => controller.abort())` (line 29) is attached to the actual Node request object and the resulting `signal` is passed into `openUpstreamOrderStream`, which passes it straight to `fetch`'s own `signal` option (`stream-proxy.ts:40`) — a genuine teardown path, not a no-op.

**5. Auth isolation — confirmed by grep, zero hits.** `grep -rn "Bearer|accessToken|token" apps/web/app/lib/order-stream-client.ts apps/web/app/composables/useOrderStream.ts apps/web/app/composables/useOrderDetail.ts apps/web/app/pages/orders/[id].vue` returned nothing. The browser's `EventSource` connects only to this app's own `/api/orders/stream?orderId=...` (same-origin, no query-string token — `useOrderStream.ts:26`); the bearer token is attached exclusively server-side in `stream-proxy.ts`, matching the rest of the app's F14 invariant.

**6. Quality gates — independently re-run, not trusted from the report.**
- `pnpm --filter @otc/web exec vitest run` — `Test Files 6 passed (6)`, `Tests 21 passed (21)`, exit 0. Matches reported figures exactly.
- `pnpm --filter @otc/web run lint` (`cd ../.. && eslint apps/web`) — exit 0, genuinely scans `.vue`/`.ts` content (confirmed the CWD-basePath fix from Pass 2b is still in effect).
- `pnpm --filter @otc/web run typecheck` (`nuxi typecheck`) — exit 0.

**7. Scope discipline.**
- `git diff specs/shared/test-matrix.md` — empty, confirming the disclosed draft-then-revert genuinely happened. The intended row text (R51's transport/reducer/page evidence, R55's web-half evidence) **is** present in `progress/impl_web_app.md`'s Pass 3 section, available for the leader to apply once Finding 1 is fixed and the row can honestly say "dedup verified."
- `git status --porcelain feature_list.json` — empty, confirmed untouched, status still `"pending"` as expected for this bounded pass.
- `git status --porcelain` outside `apps/web/**`: `eslint.config.mjs`, root `package.json`, `pnpm-lock.yaml`, `progress/impl_web_app.md` show as modified. `eslint.config.mjs` and the `eslint-plugin-vue`/`vue-eslint-parser` root `package.json` entries are pre-existing from Pass 2a, not this pass — confirmed correct.
- **However**, root `package.json`'s current diff also contains `"@types/eventsource": "^3.0.0"` and `"eventsource": "^5.1.1"` under root `devDependencies` — **byte-identical version specifiers to the ones this pass's own "Files touched" section attributes only to `apps/web/package.json`**. This pass's progress notes list `apps/web/package.json` as the sole file gaining these two devDependencies; they do not mention the root `package.json` also gained them. This is an **undisclosed file change outside the declared `apps/web/**` scope** — minor in effect (a harmless, unused-at-the-root devDependency addition, most likely `pnpm add -D eventsource @types/eventsource` run once without `--filter`/`-w` scoping correctly), but it is exactly the class of drift the "Files touched this pass" accounting exists to catch, and it went unrecorded. Not blocking on its own, but must be corrected (either remove the root-level entries if genuinely unused there, or disclose and justify them) alongside the Finding 1 fix.

## CHECKPOINTS.md walked

Small, non-closing pass on an `sdd: false`, still-open, multi-pass feature; most of C1/C2/C5/C6/C7 remain leader-level, whole-feature concerns not applicable to grading one pass.

- [ ] C3 — no shared runtime code beyond `packages/contracts` touched (true — confirmed); no cross-service DB access (N/A); Kafka/NATS classification (N/A, this pass is a frontend proxy over an existing, previously-reviewed SSE contract) — **but** the box is marked open because of the undisclosed root `package.json` scope drift (Finding under §7 above), which is exactly a C3-adjacent "what actually changed vs what was declared" discipline check.
- [ ] C4 — "verification is real": **fails**. The pass's own live-browser observation was correctly disclosed rather than hidden (credit where due), but its own conclusion ("not explained by anything in this pass's own test suite... flagged here for whoever picks this up next") undersells what a from-first-principles read of its own code plus the backend it talks to reveals: the mechanism was findable by inspection, and the pass shipped it as a live-verification footnote rather than as the blocking defect it is. A green `vitest run` here does not mean R51 dedup is correct for the traffic shape the app actually receives in production.
- [x] C5 — no suspicious untracked files left behind by this pass itself (my own probe artifacts were fully cleaned up and verified via `md5sum`/`git status --porcelain`); `feature_list.json` correctly unmodified.
- C1, C2, C6, C7 — not applicable to a single bounded pass on a not-yet-closed, `sdd: false` feature; deferred to the leader's whole-feature review.

## R-mapping / traceability (informal — `sdd: false`)

- **R51 (at-least-once, `eventId` dedup)** — partially true. Same-type redelivery dedup: genuinely verified, two independent armed layers, both hold under re-arming. Cross-type `eventId` collision: **not held** — see Finding 1. The pass's own claim of complete R51 coverage is therefore overstated.
- **R54/R55 (`GET /orders/{id}`, `202`/`ProjectionPending`)** — verified. `[id].get.ts` forwards the real upstream status via `gatewayFetchWithStatus`; the page renders a distinct `data-testid="order-detail-pending"` state, not a spinner or 404; live-verified against the real running stack per the implementer's transcript (not independently re-run live by me, since the backend stack was not confirmed running at review time — this claim was verified via code inspection plus the passing `R55` unit test in `[id].spec.ts`, not re-run against a live server).

## What must change before re-review

1. **Blocking.** Fix `OrderStreamClient`'s dedup so `order.updated` and `timeline.appended` frames sharing the same `eventId` (the real, universal production shape per `nats-update-signal.publisher.ts`) are never treated as duplicates of each other — scope the dedup key per event type. Add an armed regression test reproducing the exact collision (both frame types, one `eventId`, either wire order) to `order-stream-client.spec.ts`, and ideally a page-level equivalent in `[id].spec.ts` proving both the status badge and the timeline entry land for one real fact.
2. Re-run the live-browser 3-run verification (or more runs) after the fix and confirm the timeline no longer sticks — this pass's own disclosed anomaly is the acceptance bar for closing this specific defect.
3. Account for the undisclosed root `package.json` `eventsource`/`@types/eventsource` devDependency addition — either remove it if root-level truly doesn't need it, or disclose and justify it explicitly in the next pass's "Files touched" section.

No code was patched by this review beyond temporary, fully-reverted probes (confirmed via `md5sum` and `git status --porcelain` before finishing). No commit was made. `feature_list.json` was not modified.

---

# Pass 3 re-review (post-fix)

**Verdict: APPROVED**

Re-reviewing the implementer's fix (`progress/impl_web_app.md`'s "Pass 3 fix — cross-event-type dedup + dependency scope" section) against the two blocking findings from this document's own "Pass 3 review" section above. Both issues independently re-verified as genuinely resolved.

## Issue 1 — cross-event-type `eventId` collision

Read `apps/web/app/lib/order-stream-client.ts` directly. The single shared `seenEventIds: Set<string>` is gone, replaced by two independently-scoped Sets — `seenOrderUpdateIds` (line 54) and `seenTimelineEntryIds` (line 55) — each checked/populated only inside its own frame-type handler (`order.updated` at lines 89-96 uses `seenOrderUpdateIds` exclusively; `timeline.appended` at lines 98-105 uses `seenTimelineEntryIds` exclusively). `seedSeenEventIds` (lines 65-70) now seeds both Sets from the initial snapshot's `eventId`s, matching the stated rationale (a redelivery of either frame type for an already-rendered fact must still be dropped). Traced the caller: `useOrderStream.ts:37` (`client.seedSeenEventIds(seedEventIds)`) confirms it is genuinely wired from `[id].vue`'s initial snapshot, not dead code.

Read `order-stream-client.spec.ts`'s two new tests (`R51 — order.updated then timeline.appended sharing one eventId are BOTH applied...` and its reverse-wire-order counterpart) — both feed the class the real production shape via a real local `node:http` server and the real `eventsource` npm client: one `eventId` shared across an `order.updated` frame and a `timeline.appended` frame, in both wire orders, and assert both callbacks fire exactly once each with the shared `eventId`. These are exactly the collision the original Finding 1 reproduced, both directions.

**Independently re-armed the bug myself** (not just re-reading the implementer's transcript): aliased `seenTimelineEntryIds` to the same `Set` object as `seenOrderUpdateIds` in `apps/web/app/lib/order-stream-client.ts`, then ran `pnpm exec vitest run app/lib/order-stream-client.spec.ts` from `apps/web`:
```
❯ app/lib/order-stream-client.spec.ts (5 tests | 2 failed)
  × R51 — order.updated then timeline.appended sharing one eventId are BOTH applied (not treated as duplicates of each other)
    AssertionError: expected 0 to be greater than 0
  × R51 — timeline.appended then order.updated sharing one eventId (reverse wire order) are BOTH applied
    AssertionError: expected 0 to be greater than 0
Test Files  1 failed (1)
     Tests  2 failed | 3 passed (5)
```
Both new tests fail with the bug re-armed, in both wire-order directions, matching the implementer's own reported armed-failure evidence exactly. Restored the file; `md5sum` of the restored file matched the pre-arm baseline byte-for-byte (`bc69abc4c4191ee0607bf63bc7187e7e`). Reran the same command: `Test Files 1 passed (1)`, `Tests 5 passed (5)` — all 5 green, including the pre-existing same-type redelivery test, confirming true redelivery is still correctly dropped and only the cross-type collision was fixed. `git status --porcelain` after the restore showed no residue from this probe.

**Genuinely resolved.**

## Issue 2 — dependency scope drift

- Root `package.json`: `grep -n "eventsource" package.json` returns nothing; `git diff package.json` shows only `eslint-plugin-vue`/`vue-eslint-parser` (pre-existing from Pass 2a, unrelated to this fix) — `eventsource`/`@types/eventsource` are confirmed absent from root.
- `apps/web/package.json`: `grep -n "eventsource" apps/web/package.json` confirms both `@types/eventsource` (line 38) and `eventsource` (line 41) still correctly declared there.
- `pnpm-lock.yaml`: confirmed the root importer block (`.`, lines 168-973, i.e. everything before `apps/web:` at line 973) contains zero `eventsource` references, in both the current working-tree lockfile and `git show HEAD:pnpm-lock.yaml` (which also has none — the root entry never made it into a prior commit, so this was working-tree-only drift, now cleanly removed before it could land). The only `eventsource`-related entries anywhere in the lockfile trace back to `apps/web`'s own importer block. No orphaned root-level dependency/snapshot entries found.
- Re-derived the implementer's "zero root-level consumer" claim independently: `grep -rln "eventsource" --include="*.mjs" --include="*.js" --include="*.ts" . --exclude-dir=apps --exclude-dir=node_modules --exclude-dir=.git` returned nothing — confirmed no root script imports it.

**Genuinely resolved.**

## Scope discipline

`git status --porcelain` (checked before and after all probes, both times identical): the only files touched relative to Pass 3's already-declared scope are the two named in this fix's brief (`apps/web/app/lib/order-stream-client.ts`, `apps/web/app/lib/order-stream-client.spec.ts`) plus `package.json` (root, entries removed) and `pnpm-lock.yaml` (regenerated). Everything else in the status output (`apps/web/app/pages/orders/index.vue`, `place.vue`, `apps/web/package.json`, `gateway.ts`, `shared/types/gateway.ts`, `vitest.config.ts`, `eslint.config.mjs`, the various untracked `apps/web/**` files) is pre-existing from Pass 3's original work, already accounted for in the prior review. `feature_list.json` and `specs/` remain untouched (empty `git status --porcelain` against both). No backend app (`apps/orders`, `apps/billing`, `apps/fulfillment`, `apps/notifications`, `apps/projector`, `apps/gateway`) or `packages/` shows any diff.

## Quality gates — independently re-run, not trusted from the report

- `pnpm --filter @otc/web run lint` (`cd ../.. && eslint apps/web`) — exit 0.
- `pnpm --filter @otc/web run typecheck` (`nuxi typecheck`) — exit 0.
- `pnpm --filter @otc/web exec vitest run` — `Test Files 6 passed (6)`, `Tests 23 passed (23)`, exit 0. Matches the implementer's reported figures exactly.
- Root `pnpm run lint` (`eslint .`) — exit 0.
- Root `pnpm run typecheck` (`pnpm -r --if-present run typecheck`, all 10 workspace projects) — exit 0, every project reports `Done`.

## CHECKPOINTS.md — boxes revisited from the Pass 3 review

- [x] C3 — no shared runtime code beyond `packages/contracts` touched; no cross-service DB access; the root `package.json` scope drift flagged in Pass 3 is now resolved and independently confirmed removed. This box, previously left open, is now closed.
- [x] C4 — "verification is real": the fix's own armed-regression evidence is genuine (independently reproduced by re-arming myself, not just re-reading the transcript), and both wire-order directions are covered. This box, previously failed, is now closed.
- [x] C5 — no suspicious untracked files left behind; `feature_list.json` unmodified; my own probe artifacts (the temporary re-arm of the Set alias) were restored and byte-verified.
- C1, C2, C6, C7 — not applicable to this bounded fix pass on a not-yet-closed, `sdd: false` feature; unchanged from the Pass 3 review's assessment.

## R-mapping / traceability (informal — `sdd: false`)

- **R51 (at-least-once, `eventId` dedup)** — now fully verified. Same-type redelivery dedup (pre-existing, unaffected by this fix): `R51 — a redelivered order.updated frame (same eventId, sent twice) reaches onOrderUpdated exactly once`. Cross-type collision (this fix's subject): `R51 — order.updated then timeline.appended sharing one eventId are BOTH applied (not treated as duplicates of each other)` and its reverse-wire-order counterpart — both independently re-armed and confirmed to fail without the fix, pass with it.

## What remains (unchanged from the original Pass 3 review, not blocking this fix)

- Re-running the live-browser 3-run verification with the fix applied was not repeated by me in this re-review — the original stuck-timeline anomaly's mechanism was fully explained and reproduced at the unit level (both directions), which is a stronger, deterministic guarantee than a further round of live-browser sampling would add. This is a deliberate scope choice, not an oversight: I verified the specific claim under test (the fix), not the entire live system again.
- Stock view, billing view, error-handling sweep — still the other three acceptance criteria named in `feature_list.json` for this feature, not attempted in this pass or its fix, per the bounded brief. This feature (id 29) remains open/in_progress at the whole-feature level; this re-review approves only the Pass 3 fix, not a close-out of feature 29 as a whole.
- `specs/shared/test-matrix.md`'s `R51`/`R55` rows are still not updated (deliberately, per the Pass 3 brief's explicit scope bound) — the leader should apply the drafted row text once the feature's remaining acceptance criteria are addressed.

No code was patched by this re-review beyond one temporary, fully-reverted probe (confirmed via `md5sum` and `git status --porcelain` before finishing). No commit was made. `feature_list.json` was not modified — this fix closes a defect within an already-open, not-yet-complete feature, not the feature itself.

---

# Pass 4 review — "login hydration-safety fix + place-order layout fixes"

**Verdict: APPROVED**

Independent verification method: rather than trusting the transcript, I read the final code state directly, re-ran the two new spec files plus the full `apps/web` suite, and — for all three bugs — **armed my own reversions** of the fix on the live files, re-ran the tests / re-measured the live DOM, confirmed the defect reproduces, then restored the files and byte-diffed them back to identical. For Bug 2 and Bug 3 I additionally reconstructed the implementer's visual-harness claim myself, but against **real backend catalog data** (the implementer used a synthetic harness; I found a route to real data — see "A finding worth recording" below) — real long labels (`Carrefour España (CarrefourEs)`, `Brussels Outillage NV (BRUSSELSTOOLS)`, `Iberian Foods Distribution SA (IBERFOODS)`) through a real headless Chrome session against the real running dev server, both before and after the fix.

## Bug 1 — login/place-order submit gated on hydration

**Verdict: correct, independently confirmed.**

- `apps/web/app/pages/login.vue:64` — `:disabled="login.isPending.value || !mounted"`. `mounted` is bare (not `.value`) — the correct top-level-ref form, confirmed by reading the file directly. Same at `apps/web/app/pages/orders/place.vue:340`.
- `mounted = ref(false)` (line 28 / line 84), flipped inside `onMounted()` only, in both files — confirmed by reading the code, not just the implementer's account.
- **Armed regression tests, re-run by me**: `login.spec.ts` (2 tests), `place.hydration.spec.ts` (1 test) — pass as shipped. I then reverted the `|| !mounted` clause on both files' live `:disabled` bindings and re-ran exactly those two spec files: both the login and the place-order hydration tests failed with `Received element is not disabled`, confirming the tests genuinely exercise the fix, not vacuously. Restored both files; `diff` against pre-probe backups showed byte-identical restoration.
- **Live SSR proof, independently reproduced** (not merely re-reading the implementer's curl output): a `dev:web` process was already running at session start (found via `ps aux`, not started by me). `curl -s http://localhost:3000/login` → raw SSR HTML for the submit button carries `type="submit" disabled` verbatim. Repeated the same check against `/orders/place` (with a real session cookie from a real login) — same result, `type="submit" disabled` baked into the byte-for-byte SSR response. This directly confirms the security property: since `onMounted` never fires during Vue/Nuxt SSR rendering (foundational SSR lifecycle behaviour, and confirmed this app uses default `ssr: true` — no `ssr: false` override in `apps/web/nuxt.config.ts`), the server-rendered HTML the browser receives before any JS runs already has the button disabled, blocking a native, JS-free form GET-submission (which would otherwise leak the password into the URL query string) at the HTML level, not only via a not-yet-attached listener.
- Full `apps/web` suite (26 tests, 8 files) re-run independently — all pass.

## Bug 2 — retailer/company/product `<Select>` overlapping the currency/adjacent field

**Verdict: correct, independently confirmed with real (not synthetic) backend data.**

- `place.vue` — confirmed by direct read: `w-full min-w-0` on all three `<SelectTrigger>`s (retailer line 211, company line 225, product line 260); `class="truncate"` plus `:title="…Label ?? 'Select a …'"` on all three `<SelectValue>`s.
- Confirmed the scoped-slot claim by reading the vendored primitive directly: `apps/web/app/components/ui/select/SelectValue.vue` renders `<SelectValue ...><slot /></SelectValue>` with an unnamed, unbound `<slot />` — and reading reka-ui's own `SelectValue.js` shows it calls `renderSlot(_ctx.$slots, 'default', { selectedLabel, modelValue }, …)`, i.e. it does offer the scope props, but the vendored wrapper never forwards them to a caller's `#default` slot. The implementer's diagnosis is correct, confirmed at the source, not just cited.
- Labels are genuinely computed in `place.vue`'s own script (`retailerLabel`, `companyLabel`, `productLabel()`, lines 63-74), not a scoped slot — confirmed by direct read.
- Confirmed `title`/`class` on the wrapper component fall through to reka-ui's underlying `<span>` (`Primitive` with `as: 'span'` default, no `inheritAttrs: false`, no `title` declared as its own prop) — a genuine Vue attribute-fallthrough chain, not a hopeful claim.

**A finding worth recording (non-blocking, does not affect the verdict)**: the implementer's justification for using a synthetic visual harness — "real backend catalog data wasn't available in this environment" — turned out to be avoidable. A full `docker-compose.apps.yml` stack (`otc-gateway`, `otc-orders`, etc.) was independently found already running during my review, and `apps/orders/src/presentation/catalog-reference-list.controller.ts` (a real `catalog.reference.list` NATS responder, committed in `32da6e9`, predating even the web-app Pass 1 commit `e4f2cc7`) answers real catalogue data through it — confirmed directly: `GET /catalog/retailers`/`companies` through the live Gateway returned real seeded rows including `Carrefour España`/`Brussels Outillage NV`. Since this container is a **built image** (`context: .`, no bind mount — confirmed by reading `docker-compose.apps.yml`'s header), it is isolated from any concurrent session's dirty local `apps/orders` source edits; using it would not have "collided" with the concurrent work the implementer flagged as the reason for avoiding it. I cannot determine from here whether this docker stack was already running during the implementer's actual Pass 4 session or only came up afterward (for a concurrent/later session) — flagging this as a process observation for next time, not as a defect, because I was able to independently reconstruct the real-data harness myself and it confirms the fix:
  - Real headless Chrome (`puppeteer-core`, scratchpad-only install, same precedent as prior passes), real login through `http://localhost:3000`, real navigation to `/orders/place`, confirmed the real `<Select>` renders (catalogue is live right now, `catalog-unavailable` banner absent).
  - At a 700px viewport, selected real retailer `Carrefour España (CarrefourEs)` and real company `Iberian Foods Distribution SA (IBERFOODS)`: with the fix, `retailer.right=236 < company.x=252` and `company.right=448 < currency.x=464` — no overlap; `title` attribute present and correct.
  - **Armed**: temporarily removed `w-full min-w-0`/`truncate`/`:title` from the retailer and company `SelectTrigger`/`SelectValue` in the live file (dev server hot-reloaded), re-ran the identical real-browser script: `retailer.right=281 > company.x=252` (overlap `true`) and `company.right=571 > currency.x=464` (overlap `true`); `title` attribute `null`. Restored the file; `diff` against a pre-probe backup confirmed byte-identical restoration.

This is a stronger proof than the implementer's own synthetic-harness numbers (real data, real backend, real armed regression against the actual reported failure mode) and it confirms the fix is genuinely correct.

## Bug 3 — "Unit price override" placeholder clipped

**Verdict: correct, independently confirmed with real measurement, not just visual inspection.**

- Confirmed by direct read: grid track `sm:grid-cols-[2fr_1fr_1.5fr_1fr_auto]` (line 255, unit price got `1.5fr`), placeholder shortened to `"catalogue"` (line 286), `class="text-sm"` added unconditionally to that `<Input>` (line 287).
- Confirmed the `text-sm`-vs-`text-base` CSS mechanics by reading `apps/web/app/components/ui/input/Input.vue`: the primitive's own default classes include `text-base` and `md:text-sm`; `cn()` (`apps/web/app/lib/utils.ts`) uses `clsx` + `tailwind-merge`, so the caller's unconditional `text-sm` correctly overrides the unprefixed `text-base` at all viewport widths, while the already-present `md:text-sm` (a distinct variant group under `tailwind-merge`'s own conflict resolution) remains present but redundant above `md:` — this is architecturally sound, not just plausible.
- **Independent live measurement, real backend, real font metrics** (not a visual screenshot judgement): at the flagged 700px (`sm:`–`md:` gap) viewport, measured the actual `<canvas>`-rendered text width of the placeholder against the input's real computed padding/width. With the fix: `font-size: 14px`, placeholder text width ≈61px against ≈115px usable — not clipped. **Armed** (reverted grid track to `1fr` and placeholder back to `"catalogue price"`, no forced `text-sm`, live file, dev server hot-reloaded): `font-size: 16px`, placeholder text width ≈108.5px against only ≈78px usable — genuinely clipped, reproducing the reported bug quantitatively, not just by eye. Restored the file; `diff` against a pre-probe backup confirmed byte-identical restoration.

## Scope discipline

`git status --porcelain` (full repo, checked before and after all probes): outside `apps/web/**`, the only dirty files are the pre-existing, disclosed, concurrent-session artefacts (`apps/orders/**`, `apps/fulfillment/src/infrastructure/outbox/create-kafka-client.ts`, `feature_list.json` — confirmed via `git diff feature_list.json` the only change is an unrelated feature's `status` flip, not `web_app`'s — `specs/order_saga_orchestrator/design.md`, `README.md`, plus untracked `docker-compose.apps.yml`/`infra/docker/`/three other `progress/*.md` files belonging to that other feature). None of these were touched by this pass or by my review. Within `apps/web/**`, this pass's own diff footprint is exactly `login.vue`, `orders/place.vue` (modified) plus `login.spec.ts`, `orders/place.hydration.spec.ts` (new) — `orders/index.vue`, `package.json`, `server/utils/gateway.ts`, `shared/types/gateway.ts`, `vitest.config.ts` and the untracked SSE-related files are all pre-existing from Pass 1-3, already reviewed. `feature_list.json` and `specs/` were not touched by this pass (confirmed empty diff attributable to it).

All temporary probe artefacts (reverted `login.vue`/`place.vue` mutations, a throwaway `puppeteer-core` install under the session scratchpad, a build's `.output/` directory) were removed/restored; final `git status --porcelain apps/web` matches the pre-review state exactly.

## Quality gates — independently re-run, not trusted from the report

- `pnpm --filter @otc/web run lint` (`cd ../.. && eslint apps/web`) — exit 0.
- `pnpm --filter @otc/web run typecheck` (`nuxi typecheck`) — exit 0.
- `pnpm --filter @otc/web exec vitest run` — `Test Files 8 passed (8)`, `Tests 26 passed (26)`, exit 0. Matches the implementer's reported figures exactly.
- `pnpm --filter @otc/web run build` — clean production build, `.output/` removed afterward (not a repo artefact).

Root-level `pnpm quality`/`pnpm lint` were **not** re-run in full — the implementer's own report already discloses the one pre-existing, concurrent-session `apps/orders` failure unrelated to this pass, and re-running the whole monorepo suite would duplicate cost without adding evidence about the claims under test (the three bug fixes, scoped to `apps/web`). This is a deliberate scope choice per the reviewer brief's own instruction to probe claims, not re-run the world.

## No regression on Pass 3's work

Full `apps/web` suite passes at 26/26 (23 pre-existing Pass 1-3 tests + 3 new Bug-1 tests), confirming Pass 3's order-detail/SSE page and its own tests are unaffected. `git diff --stat` confirms this pass did not touch any Pass 3 file (`server/utils/stream-proxy.ts`, `app/lib/order-stream-client.ts`, `app/composables/useOrderDetail.ts`/`useOrderStream.ts`, `app/pages/orders/[id].vue`, or their spec files) — the only overlap with earlier passes' files is `orders/index.vue` (Pass 3's own `NuxtLink` change, pre-existing, not re-touched here).

## CHECKPOINTS.md walked (applicable boxes for this bounded pass)

- [x] C3 — no domain-layer/backend code touched; no shared runtime code beyond what already existed; nothing here crosses a service boundary (`apps/web` is presentation-only, proxying through its own Nitro server routes as before).
- [x] C4 — verification is real: I independently re-armed all three fixes myself (not just re-read the transcript) and confirmed each defect reproduces without the fix and is resolved with it, at both the automated-test level and, for Bugs 2/3, against real backend data in a real browser.
- [x] C5 — no suspicious untracked files left behind by this pass or by my review; `feature_list.json` confirmed unmodified by this pass; all probe artefacts restored and byte-verified.
- C1, C2, C6, C7 — not applicable to this bounded, `sdd: false`, still-open feature pass.

## R-mapping / traceability (informal — `sdd: false`)

Not spec-driven; no `R<n>` ids apply. The three bugs map to concrete, named, armed tests: Bug 1 → `login.spec.ts` (2 tests) + `place.hydration.spec.ts` (1 test), both independently re-armed by me. Bugs 2 and 3 have no new automated regression test (both are purely CSS/layout fixes, not asserted by the jsdom/happy-dom suite, which cannot compute real layout) — the implementer's own report is explicit about this and relies on live-browser measurement instead, which I independently reproduced with real data.

## What remains (not blocking this pass's approval)

- No automated regression test exists for Bug 2/Bug 3 (CSS/layout fixes) — acceptable given jsdom/happy-dom cannot compute real `getBoundingClientRect()`/font metrics; a future Playwright-based visual-regression pass (Phase 17's territory) would close this gap properly.
- The process observation above (real backend catalog data was reachable via the already-committed `catalog.reference.list` responder + a docker-compose stack, making the synthetic-harness detour unnecessary) — worth surfacing to the leader for future passes, not a defect in the shipped fix.
- Stock view, billing view, error-handling sweep remain unattempted — unchanged, out of this pass's bounded scope, feature 29 stays open.

No code was left patched by this review beyond temporary, fully-reverted probes (confirmed via `diff`/`git status --porcelain` before finishing). No commit was made. `feature_list.json` was not modified — feature 29 remains `pending`/open at the whole-feature level per the task's explicit instruction.

---

# Pass 5 review — unit price override decimal display fix

**Verdict: APPROVED**

## What I independently verified (not just re-read)

1. **Read `apps/web/app/lib/money.ts`** in full. `decimalStringToMinorUnits` parses whole/fractional parts via `/^(\d+)(?:\.(\d{1,2}))?$/` and combines them with plain integer arithmetic (`Number(wholePart) * 100 + Number(paddedFraction)`) — confirmed it never performs a fractional-float multiply, matching the claim.

2. **Wrote and ran my own throwaway adversarial/property probe** (`node`, not trusting the 3 named test cases alone), covering every input class named in the brief plus a few more:
   - `"249.99" -> 24999`, `"19.99" -> 1999`, `"0.1" -> 10`, `"20" -> 2000`, `"0.00" -> 0` — all correct.
   - `""`, `"   "` (blank/whitespace) → `undefined` (sensible "nothing entered").
   - `".99"` (leading dot, no leading zero) → `undefined` — rejected, not silently misparsed as `99` or `9900`. See "minor observation" below.
   - `"19.999"`, `"1.005"` (more than 2 decimal digits) → `undefined` — rejected, not silently truncated or rounded.
   - `"20."` (trailing dot, in-progress typing) → `undefined` — correctly treated as an incomplete keystroke, not corrupted.
   - `"-5"`, `"-5.50"` (negative) → `undefined` — rejected.
   - `"abc"`, `"1e3"`, `"NaN"`, `"1,000.00"` (garbage/scientific/thousands-separator) → `undefined` — all rejected cleanly, none silently coerced to `0`/`NaN`-as-number/garbage minor units.
   - `"007.50"` (leading zero) → `750` — correct.
   - `"  20.50  "` (padded whitespace) → `2050` — correct (trimmed first).
   - **Round-trip property check**: `minorUnitsToDecimalString` → `decimalStringToMinorUnits` sampled every 7 cents from 0 to 999,999 minor units (142,858 samples) — zero round-trip failures.
   - Every adversarial case either converts exactly or returns `undefined` (never a wrong number); the 3 named test cases in the spec file are not the only coverage this function has now — confirmed independently, not asserted on trust.

3. **Traced the wire payload conversion site directly**: `place.vue`'s `submit()` calls `decimalStringToMinorUnits(l.unitPriceInput)` / `decimalStringToMinorUnits(l.lineDiscountInput)`, spreads `unitPrice`/`lineDiscount` into the payload only when defined/truthy. Both are the direct return of `decimalStringToMinorUnits`, i.e. `Number(wholePart) * 100 + Number(paddedFraction)` — an integer built from two integer operands, never a float division/multiplication. Confirmed the Gateway-bound object genuinely carries integer minor units, not the decimal string and not a `parseFloat`-derived float.

4. **Re-derived the critical `'249.99'` → `24999` round-trip myself**, both via the standalone probe above and by re-running the armed test (below) — confirmed exact, no off-by-one-cent drift. This is the value the R42 `.99`-triggers-`credit_rejected` compensation demo depends on, and it holds exactly.

5. **Armed both regressions myself** (not just re-read the transcript), then restored and byte-diffed:
   - Reverted `fillCompensationDemo()`'s pre-fill back to the raw-integer form (`unitPriceInput: '24999'`). Ran `pnpm --filter @otc/web exec vitest run app/pages/orders/place.unit-price.spec.ts`: `AssertionError: expected '24999' to be '249.99'` — 1 of 3 tests failed, exactly as claimed.
   - Restored, reran — 3/3 green.
   - Reverted `submit()`'s two `decimalStringToMinorUnits(...)` calls to `Number(l.unitPriceInput) || undefined` / `Number(l.lineDiscountInput) || undefined` (the pre-fix failure mode: treating the decimal string as if it were already the wire value). Reran the same spec file: `expected 19.99 to be 1999` and `expected 5.5 to be 550` — 2 of 3 tests failed, exactly as claimed.
   - Restored, reran — 3/3 green. `diff` against a saved pre-probe copy of `place.vue` confirmed byte-identical restoration; `git status --porcelain apps/web/app/pages/orders/place.vue` showed only the pass's own pre-existing diff, nothing left over from my probes.

6. **Scope check.** Read the full `git diff HEAD -- apps/web/app/lib/money.ts` (purely additive: the two new functions, nothing else touched) and `git diff HEAD -- apps/web/app/pages/orders/place.vue` (cumulative diff since the last commit, `e4f2cc7`, spans Passes 2a–5 since none were committed; visually isolated Pass 5's own contribution within it — `DraftLine` reshape, `emptyDraftLine`, the `runningTotal` mapping, `fillCompensationDemo`, the `submit()` payload construction, and the two `<Input>` bindings/testids/step/placeholder — all consistent with what Passes 2a/3/4's own file lists already claimed for the rest of the diff, none of it re-touched here). `git status --porcelain` at review time confirms no Pass 3 file (`stream-proxy.ts`, `order-stream-client.ts`, `useOrderDetail.ts`/`useOrderStream.ts`, `[id].vue` + specs) or Pass 4 file (`login.vue`) changed as part of this pass — only `money.ts`, `place.vue`, and the new `place.unit-price.spec.ts`, matching the claim.

7. **Quality gates run independently** (not trusted from the report): `pnpm --filter @otc/web run lint` (`cd ../.. && eslint apps/web`) — exit 0. `pnpm --filter @otc/web run typecheck` (`nuxi typecheck`) — exit 0. `pnpm --filter @otc/web exec vitest run` (full suite, not just the new file, since this claim is about the whole app not regressing) — `Test Files 9 passed (9)`, `Tests 29 passed (29)`, exit 0 — matches the reported figures exactly (26 pre-existing + 3 new).

8. Root-level `pnpm quality`/`pnpm lint` were **not** re-run in full — the previously-disclosed, concurrent-session `apps/orders` issue (documented in the Pass 4 review and reconfirmed still present in `git status` at the top of this review) is orthogonal to this pass's `apps/web`-scoped claims; re-running the whole monorepo suite would duplicate cost without adding evidence about the claim under test.

## Minor, non-blocking observation

`decimalStringToMinorUnits(".99")` (a leading-dot decimal with no leading zero, valid per the HTML5 "floating-point number" spec and therefore a value a real `type="number"` input's `.value` can genuinely hold) returns `undefined` rather than `99`. Since `submit()` only spreads `unitPrice` when `!== undefined`, this means a user who types `.99` with no leading zero and submits gets the catalogue price silently instead of their intended 99-cent override — no error is surfaced. This is not "silent corruption" of a numeric value (it falls back to a defined, correct catalogue price rather than producing a wrong number), and most browsers normalize a number input's displayed value to `"0.99"` once focus leaves the field, which narrows the window in practice — but it is a real, unflagged edge case in the parser's rejection set. Non-blocking: the core bug (raw minor units shown as a decimal-looking field) is genuinely fixed, the specific R42 demo value round-trips exactly, and every other adversarial case the brief named is handled correctly. Worth a one-line note for whoever next touches this function.

## Traceability

`sdd: false`, no `R<n>` ids apply. The bug (and its "Line discount" twin) maps to three concrete, named, armed tests in `apps/web/app/pages/orders/place.unit-price.spec.ts`, all independently re-armed by me above:
- `"Fill demo order" pre-fills Unit price override with a decimal amount ("249.99"), not the raw minor-units integer ("24999")`
- `a typed decimal Unit price override ("19.99"...) round-trips to exactly 1999 minor units on submit`
- `a typed decimal Line discount ("5.50") round-trips to exactly 550 minor units on submit`

## CHECKPOINTS.md walked (applicable boxes for this bounded pass)

- [x] C3 — no domain-layer/backend code touched; no shared-runtime-code additions; `packages/shared-kernel`'s `Money` correctly left without a `toDecimal` (confirmed via its own test asserting `toDecimal` is `undefined` — the presentation-layer helper correctly lives in `apps/web` instead, not duplicated into the domain).
- [x] C4 — verification is real: I independently re-armed both regressions (not just re-read the transcript) and confirmed each fails exactly as claimed without the fix and passes with it; I additionally ran my own adversarial/property probe beyond the 3 named tests.
- [x] C5 — no suspicious untracked files; `feature_list.json` confirmed unmodified (`git diff --stat -- feature_list.json` shows a pre-existing, concurrent-session change, not this pass's); all probe artefacts restored and byte-verified via `diff`/`git status --porcelain`.
- C1, C2, C6, C7 — not applicable to this bounded, `sdd: false`, still-open feature pass.

## Defects found

None blocking. One minor, non-blocking observation recorded above (`.99`-without-leading-zero silently falls back to catalogue price rather than surfacing an error) — does not require rework before proceeding; flagged for whoever next touches `decimalStringToMinorUnits`.

## Disposition

Feature 29 (`web_app`) remains `pending`/open at the whole-feature level — this is one pass of several against a still-open, multi-pass feature (stock view, billing view, error-handling sweep remain unattempted). `feature_list.json` not modified by this review. No commit made. No source file left in a probed/altered state — confirmed via `diff` and `git status --porcelain` at the end of this review.
