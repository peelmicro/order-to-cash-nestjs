# Review — `saga_e2e_verification` (id 28, phase 15, `sdd: false`)

**Verdict: APPROVED.**

Reviewed as the first submission (status `pending`). `pnpm quality` was
confirmed green independently by the leader minutes before this review
(1,246 tests, exit 0, both `pnpm quality` and `./init.sh`) — not re-run in
full here, per the leader's own instruction. Effort spent instead on
targeted re-runs of the single spec this feature adds
(`apps/gateway/src/saga-e2e-verification.integration.spec.ts`) and on
independently re-arming the implementer's own mutation probes against the
**real, live, six-container/four-process fleet**, not against any mock.

## CHECKPOINTS.md walked

- **C1 (scope/traceability)** `[x]` — all five `feature_list.json` id 28
  acceptance bullets map to a named `it()` in
  `saga-e2e-verification.integration.spec.ts` (criteria 1–5). `R56`/`R57`
  rows in `specs/shared/test-matrix.md` independently re-verified against
  disk state (below).
- **C2 (tasks genuinely done)** `[x]` — `sdd: false`, no `tasks.md`; the
  three-pass `progress/impl_saga_e2e_verification.md` account matches disk
  state file-by-file (verified via `git diff --stat`/`git status
  --porcelain`, not merely read).
- **C3 (tests are real)** `[x]` — every criterion drives real spawned OS
  processes (`node dist/main.js`, never `tsx`) against real Testcontainers
  MySQL×3/Kafka/NATS/MongoDB. No mock of any inter-service boundary.
  Re-armed independently (below) — every armed mutation reproduced the
  exact failure the implementer's own report claims.
- **C4 (conventions)** `[x]` — Vitest only, no Jest; money not touched by
  this feature; domain purity not touched (this feature adds no
  `domain/`-layer code — pure integration/test-support). `mysql-worker-client.ts`'s
  own inline `require()` is a plain-`node -e` **child process** script, never
  parsed by this repo's own TS/ESLint project (confirmed: it is a template
  string, not an on-disk `.cjs`/`.js` file).
- **C5 (fact-emission guard discipline)** `[x]` — this feature adds no new
  fact-emitting branch in production code; Pass 1's production edits
  (Fulfillment/Billing trace-context wiring) each carry their own
  independently re-verified armed-deletion probe (I re-derived the R57
  decorator count and wrap-coverage directly from source, below, rather
  than trusting the count in the report).
- **C6 (coverage gates)** — not independently re-measured (`pnpm quality`'s
  coverage step already covered by the leader's green run); this feature's
  own new code is 100% integration-test-only (test-support + one spec
  file), outside the domain-coverage gate's scope.
- **C7 (architecture)** `[x]` — Kafka carries facts, NATS carries RPC,
  correctly used throughout the new spec (raw Kafka producer for
  fact-topic publishes/redeliveries, raw NATS `request()` for saga RPCs).
  No cross-service DB access from production code. The one gateway→other-service
  DB access this feature adds (`MySqlWorkerClient`) is test-only,
  provably excluded from `dist/` (below) — this is the specific
  architectural-guard-preservation claim the brief asked to be probed
  adversarially, and it holds, with one residual gap flagged as a finding
  (Medium/Low, not blocking — see Finding 1).

## R\<n\> → test mapping verified

| Req | Test | Verified how |
|---|---|---|
| Acceptance 1 (happy path → `completed`) | `criterion 1` | Read + re-ran (full-suite run, twice) |
| Acceptance 2 (`.99` compensates) | `criterion 2` | Read; asserts Orders' `cancellation_reason`, Billing's own `credit.rejected.v1` outbox `payload.reason`, **and** Fulfillment's real `reservations.status = 'released'` (not inferred from Orders' own status column, per the brief's own instruction) |
| Acceptance 3 (redelivery, no corruption) | `criterion 3` | **Independently re-armed**, three separate fleet spin-ups (below) |
| Acceptance 4 (poison → DLQ, offset still commits) | `criterion 4` | **Independently re-armed**, two fleet spin-ups (below) |
| Acceptance 5 / R56 (composed-stack trace) | `criterion 5` | **Independently re-armed**, one fleet spin-up (below); disclosed Projector/Gateway gaps independently confirmed accurate |
| R57 (both services' `@MessagePattern` responders extract trace context) | `apps/fulfillment/src/trace-context-propagation.integration.spec.ts`, `apps/billing/…` (Pass 1) | Re-grepped every `@MessagePattern` decorator myself; recounted (below) |

## Probe 1 — Criterion 3's four-layer redundancy claim (re-armed independently)

This was the highest-value probe in the brief and is where I spent the
most wall-clock. I picked **layer 2** (Orders' `saga-fact-handler.ts` R25
precondition check — the report's own "actual dominant guard" for this
scenario) and **layer 4** (Fulfillment's `stock-reservation.handler.ts`
FS5 responder idempotency) — one guard on each side of the process
boundary, the two least likely to accidentally share a fate.

- **Arm A — layer 2 only disabled** (commented out the
  `if (order.status !== step.precondition)` block in
  `apps/orders/src/application/saga-fact-handler.ts`). `tsc --noEmit`
  clean. Re-ran `criterion 3` alone against a fresh real fleet:
  **green**, 749ms. Restored; `git diff --stat apps/orders` empty.
- **Arm B — layer 4 only disabled** (commented out the
  `if (existingReservations.length > 0)` short-circuit in
  `apps/fulfillment/src/application/stock-reservation.handler.ts`). `tsc
  --noEmit` clean. Re-ran `criterion 3` alone: **green**, 731ms. Restored;
  `git diff` on the file empty (it was not part of Pass 1's own legitimate
  uncommitted changes).
- **Arm C — all four layers disabled simultaneously**
  (layer 1 `idempotent-consumer.ts`'s duplicate-throw, layer 2 as above,
  layer 3 `saga-command-dispatcher.ts`'s `row.status === 'sent'` no-op,
  layer 4 as above). Both services' `tsc --noEmit` clean. Re-ran
  `criterion 3` alone: **FAILED**, `AssertionError: expected 2 to be 1 //
  Object.is equality` at `reservationsAfter.n` — **byte-identical failure
  message to the one recorded in `progress/impl_saga_e2e_verification.md`.**
  Restored all four files; `git diff --stat apps/orders` empty,
  `stock-reservation.handler.ts`'s own diff matched its pre-probe state
  exactly. Both services re-typechecked clean. Full 5-criterion suite
  re-ran green afterward (5/5, 68s).

**Conclusion: the four-layer redundancy claim is real, not an artefact of
one guard doing all the work.** Disabling either of the two layers I chose
independently left the system correct; only disabling all four together
produced the corruption, and the corruption is specifically a genuine
second Fulfillment `reservations` row (Orders' own `saga_commands` stayed
at 1 throughout, exactly as the report describes — its own unique-index
protection is a fifth, unprobed mechanism that was never claimed as one of
the four).

## Probe 2 — Criterion 5 / R56 (re-armed independently)

Re-armed the exact single-line mutation Pass 3 recorded:
`apps/fulfillment/src/infrastructure/outbox/outbox-recorder.ts`'s `const
traceParent = activeTraceParent();` → `const traceParent = null;`. `tsc
--noEmit` clean. Ran `criterion 5` alone against a fresh fleet:
**FAILED**, `AssertionError: fulfillment (stock.reserved.v1 outbox):
expected a real 32-hex traceId, got null: expected false to be true` —
the exact per-source label the report names, naming the diverging process
precisely. Restored; diff-stat matched Pass 1's own pre-existing 14/1
change shape exactly; typecheck clean; full suite re-ran green.

**Disclosed-limitation check, done independently rather than trusted:**

- **Projector.** Grepped every `console.log`/`console.error`/`logger.*`
  JSON-shaped call site under `apps/projector/src`: four call sites
  (`mongo-read-model-writer.ts`, `projection-apply.service.ts`,
  `projector-facts.controller.ts`, `fact-retry-dispatcher.ts`), all
  guarding an error/DLQ path, none reachable on a healthy consume.
  Confirmed the service's own `trace-context.ts` header states it owns no
  outbox. The claim "genuinely unobservable, not merely unattempted" holds
  — closing it for real needs either an OTel collector (explicitly out of
  scope, deferred to Phase 22 per the feature's own final statement) or
  new production logging (out of this feature's "tests only" scope). Not
  cheaply closable within this feature's bounds — the disclosed gap is
  honest.
- **Gateway.** Confirmed by reading the spec's own `beforeAll`: the fleet
  spawns Fulfillment, Billing, Projector and Orders only; every order in
  every criterion is placed via a raw `nats.request('orders.create', …)`
  call, never through Gateway's HTTP surface. This is a Pass 2 **design
  decision** (stated explicitly in the file's own header), not an
  oversight, and is consistent with every other criterion in this file
  using the same entry point — the "inbound HTTP request" leg of R56's
  wording is out of scope by construction, disclosed as such, not silently
  narrowed.

## Probe 3 — `mysql-worker-client.ts` guard-preservation, adversarial half

Confirmed independently, not merely re-read:

- `apps/gateway/tsconfig.build.json` excludes `src/**/*.spec.ts` **and**
  `src/**/test-support/**` — `mysql-worker-client.ts` (under
  `test-support/`) and its only caller (a `.spec.ts` file) both never enter
  `dist/`, so neither can reach the production `node dist/main.js` path
  regardless of what they do internally.
- `apps/gateway/package.json` declares no `mysql2`/`drizzle-orm` of any
  kind (checked directly).
- `no-write-database-client.spec.ts`'s own guard mechanism re-read in
  full: it spawns a real, `NODE_PATH`-stripped `node -e
  "require.resolve(...)"` child process and checks four specifier forms
  (bare + subpath, both packages) resolve to `MODULE_NOT_FOUND` from
  Gateway's own `src/` — genuinely representative of `node dist/main.js`
  in production, not vitest's own hoisted resolution.

**Finding 1 (Low/Medium, informational — not blocking).** The guard as
written checks *specifier-based module resolution* only. It does not, and
structurally cannot, detect a production file that `require()`s a sibling
service's dependency by an **absolute, hard-coded file path** — exactly
the technique `mysql-worker-client.ts` itself uses, deliberately, to
sidestep the guard for test-only purposes. Today this is safe **only**
because (a) the technique lives in a file `tsconfig.build.json` excludes
from `dist/`, and (b) no production file in this repo currently does this
(confirmed: `grep -rln "require(" apps/gateway/src --include="*.ts" | grep
-v test-support | grep -v .spec.ts` returns nothing). If a future feature
ever needed to reach a sibling's runtime dependency from **production**
code, this exact pattern — a hard-coded `<serviceDir>/node_modules/<pkg>/…`
path — would satisfy the current guard's specifier check while still
constructing a real write-database client. This is not a defect in the
current submission; it is a residual architectural blind spot the pattern
introduces, worth a follow-up hardening (e.g., a second guard that also
static-scans production `src/` for any `require`/`import` containing
`node_modules` path segments, or a lint rule banning dynamic `require()`
in production `src/` entirely) before this pattern is reused by a later
feature. Owner: leader, to route as a small follow-up, not a blocker on
this feature.

## Probe 4 — Poison-to-DLQ, system level (re-armed independently)

Confirmed `criterion 4` is genuine system-level (publishes via a raw
`kafkajs` producer directly onto the real running Orders process's own
consumer group, on a fixed partition, never a repackaged per-service
spec). Re-armed the **specific property that failed live in Phase 12**
(not merely "does a poison message reach the DLQ", which feature 27
already proved per-service, but "does the offset still commit after
dead-lettering"): temporarily made
`apps/orders/src/infrastructure/messaging/fact-retry-dispatcher.ts`
rethrow after its DLQ publish instead of returning normally (the exact
inverse of the class's own documented "deliberately NOT rethrown" design).
`tsc --noEmit` clean. Re-ran `criterion 4` alone: **FAILED** — the DLQ
message was received (first `waitFor` passed silently), but the **second**
`waitFor` (a distinct, well-formed fact published right behind the poison
message on the same partition) timed out at 60s — i.e., with the offset
not committing, the partition genuinely blocked and the subsequent valid
fact was never processed, reproducing the Phase-12 incident shape exactly.
Restored; `git diff --stat apps/orders` empty; typecheck clean; full suite
re-ran green (5/5).

## Probe 5 — Criteria 1/2 (lower priority, read + one full-suite confirmation)

Not independently re-armed beyond the full-suite re-runs already performed
for probes 1/2/4 (which include criteria 1 and 2 passing alongside).
Confirmed by reading: `waitFor` never uses a bare sleep (polls every 300ms
up to a caller-supplied timeout budget); criterion 2 asserts Fulfillment's
real `reservations.status = 'released'` directly by SQL, not inferred from
Orders' own status column, matching the brief's explicit instruction.

## Probe 6 — Scope and composition across three passes (re-verified independently)

- `apps/orders`: `git status --porcelain apps/orders` — **empty**, matches
  HEAD exactly. Confirms Pass 2/3's production-file arm/restore cycles net
  to zero, and confirms no Pass-1-shaped production change was ever needed
  or made in Orders.
- `apps/fulfillment`, `apps/billing`, `apps/gateway`: `git status
  --porcelain` shows only the files Pass 1's own account lists (OTel
  bootstrap, outbox-recorder/relay, main.ts, controllers + their specs,
  package.json/pnpm-lock, plus Gateway's health-check timeout fix and
  `spawn-real-projector.ts`'s refactor) — no unexplained file, no file the
  report doesn't mention.
- `apps/notifications`, `apps/projector`: `git status --porcelain` —
  **empty**, confirming these were genuinely untouched across all three
  passes, as claimed.
- Nothing from Pass 1 was silently undone: `apps/fulfillment/src/infrastructure/outbox/outbox-recorder.ts`'s
  diff-stat, re-checked after my own Probe 2 arm/restore cycle, matches
  the same 14-insertion/1-deletion shape both before and after — Pass 3's
  own arm/restore left no net trace, and Pass 1's own change is still
  present and intact.

## Probe 7 — R57's leader correction (re-verified independently)

Grepped every `@MessagePattern` decorator myself, excluding `.spec.ts`
files and comment mentions (the exact miscounting trap the leader's own
correction names):

- `apps/fulfillment/src/presentation`: 6 real decorators (`stock.check`,
  `stock.reserve`, `stock.release`, `stock.list`, `stock.replenish`,
  `despatch.create`).
- `apps/billing/src/presentation`: 5 real decorators (`credit.hold`,
  `credit.list`, `invoice.issue`, `invoice.list`, `payment.register`).
- **Total: 11**, matching `test-matrix.md`'s corrected R57 row exactly.

Read every one of the 11 handler bodies (not sampled): every single one
extracts via `extractNatsTraceContext(ctx.getHeaders() as MsgHdrs |
undefined)` and wraps its delegate call in `otelContext.with(extracted,
…)`, mirroring `orders-create.controller.ts`'s pattern. R57's "DONE,
11/11 wrapped" claim is accurate.

## Other findings

**Finding 2 (informational, no action needed).** Criterion 2 reports a
factual discrepancy between the feature's own acceptance-list wording
(`.99 order compensates visibly`) and the literal string
`'simulated_cents_rule'` it implies belongs on Orders' own
`cancellationReason` column — the implementer correctly identified this
cannot be true (the domain's closed 3-value set never contains it) and
asserted both the domain-correct value (`'credit_rejected'`) **and** the
precise Billing-internal reason from its own outbox row. This is the
implementer reporting a spec-wording imprecision honestly rather than
silently forcing a false assertion — commendable, not a defect.

**Finding 3 (informational).** `saga-e2e-verification.integration.spec.ts`
carries a `TEMPORARY diagnostic` helper (`dumpOrderDiagnostics`) explicitly
labelled as Pass-2 debugging scaffolding, still present and still used in
`catch` blocks on three of five criteria's `waitFor` calls. It is useful
(a failed run names exactly where the saga stalled) and harmless — not a
defect, but worth the leader stripping the "TEMPORARY" framing from the
comment on a future touch of this file, since it is now a permanent,
useful part of the suite rather than throwaway debug code.

## Summary of independent verification performed

Five real fleet spin-ups beyond the leader's own `pnpm quality` run (Arm A,
Arm B, Arm C for criterion 3; one arm for criterion 5; one arm + one
restore-confirmation for criterion 4), each against real Testcontainers
MySQL×3/Kafka/NATS/MongoDB and four real spawned `node dist/main.js`
processes — no mock anywhere in the probed surface. Every armed mutation
reproduced the exact failure message the implementer's own report records,
and every restoration was confirmed byte-clean by `git diff`/`git status
--porcelain` plus a passing `tsc --noEmit` on both affected services. The
full 5-criterion suite was re-run green twice more after the last
restoration.

## Findings requiring no action before approval

None of the findings above are blocking. Finding 1 (mysql-worker-client
pattern's residual guard blind spot) is recorded for the leader to route
as a follow-up hardening item, not a defect in this submission.
