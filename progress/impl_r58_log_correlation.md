# R58 closeout — correlation/trace ids on every log line in `apps/projector` and `apps/notifications`

Scope per the brief: close the gap `progress/review_traceability_audit.md` §3 found for `R58`
("THE SYSTEM SHALL emit structured log records that carry the `correlationId` and the trace
identifier on **every** line produced while handling a request, a command or a fact") in the
two services the matrix's own `R58` row now names as the gap: `apps/projector` and
`apps/notifications`. Did not touch `apps/orders`/`apps/gateway` (already `DONE`), did not edit
`specs/shared/**` or `feature_list.json`.

## 1. The true count of untraced production log call sites

The audit named **four**. Sweeping both services' production code (`console.error`/`.warn`/`.log`
call sites plus every `logger.error(...)` invocation feeding one) for a JSON-shaped structured
log missing `correlationId` and/or `traceId` found **nine**, not four:

| # | File | Site | Named by audit? |
|---|---|---|---|
| 1 | `apps/projector/src/infrastructure/messaging/fact-retry-dispatcher.ts` | dead-letter log | yes |
| 2 | `apps/projector/src/infrastructure/persistence/mongo-read-model-writer.ts` | lost-insert-race retry log | yes |
| 3 | `apps/projector/src/application/projection-apply.service.ts` | PR19 signal-publish-failure log | **no — found in sweep** |
| 4 | `apps/projector/src/presentation/projector-facts.controller.ts` | PR3 malformed-envelope log | **no — found in sweep** (traceId only; correlationId genuinely unavailable) |
| 5 | `apps/projector/src/presentation/projector-facts.controller.ts` | PR4 unknown-eventType log | **no — found in sweep** |
| 6 | `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher.ts` | dead-letter log | yes |
| 7 | `apps/notifications/src/presentation/notification-facts.controller.ts` | malformed-envelope log | yes |
| 8 | `apps/notifications/src/application/notification-dispatch.service.ts` | N13 compensating-delete-failure log | **no — found in sweep** |
| 9 | `apps/notifications/src/infrastructure/notification/degrading-notification-sender.ts` | permanent-send-failure log | **no — found in sweep** |

All nine are threaded (below). Every one is a fact-handling line (fires while consuming/processing
a Kafka fact), so none qualifies for the "outside any request/fact context" carve-out — closing
them was the correct call, not a deferral.

## 2. What was threaded, and how

Reused the existing pattern verbatim — `apps/orders`'s `activeTraceId()` (`trace.getActiveSpan()
?.spanContext().traceId`, omitted rather than logged as the string `"undefined"`) plus
`console.<level>(JSON.stringify({...}))` with `correlationId` on the line. No new logging
abstraction was invented.

- **`apps/projector/src/infrastructure/observability/trace-context.ts`** and
  **`apps/notifications/src/infrastructure/observability/trace-context.ts`** — neither service
  owned `activeTraceId()` (the audit's own finding); added the identical ~12-line function both
  Orders and the Gateway already carry.
- **`apps/projector/src/infrastructure/messaging/fact-retry-dispatcher.ts`** and
  **`apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher.ts`** — both are the
  OI12-guarded canonical-pair copy (`apps/orders/src/infrastructure/messaging
  /idempotent-consumer.parity.spec.ts`'s `RETRY_DISPATCHER_TRACE_DIVERGENT_MARKER` case, which its
  own comment already anticipates: "a future pass that gives projector/notifications their own
  `activeTraceId()` should backport these lines"). Backported ONLY the traceId/correlationId lines
  (not A7's `otc_fact_processing_latency_ms` metrics recording — out of `R58`'s scope). Verified
  the two copies stay byte-identical to EACH OTHER after stripping the banner (Python diff, and
  `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` itself, still
  green — 13/13 — without editing that guard file, which lives outside this feature's scope).
- **`apps/projector/src/infrastructure/persistence/mongo-read-model-writer.ts`** — `orderId`
  doubles as the fact's own `correlationId` by construction (`domain/fact-projection.ts`:
  `orderId: envelope.correlationId`; `specs/shared/saga.md`: "the order id is the correlationId of
  every fact"), so the retry log now carries `correlationId: orderId` alongside the existing
  `orderId`, at zero cost and with no port widening. `traceId` via `activeTraceId()` (the caller —
  `ProjectionApplyService.apply`, itself called from inside the fact-consume span
  `projector-facts.controller.ts`'s `route` starts — leaves a real span active through the whole
  async chain).
- **`apps/projector/src/application/projection-apply.service.ts`** — `correlationId:
  envelope.correlationId` (the envelope is a direct parameter of `apply`) plus `traceId` via
  `activeTraceId()`.
- **`apps/projector/src/presentation/projector-facts.controller.ts`** — widened exactly the way
  `apps/orders/src/presentation/saga-facts.controller.ts`'s own R58 closeout already did: trace
  context is now extracted from the inbound Kafka headers **before** `parseFactEnvelope` runs (not
  only after), so the PR3 malformed-envelope log carries a real `traceId` even though it has no
  trustworthy `correlationId` (a malformed envelope has none — same, pre-existing, documented
  omission `saga-facts.controller.ts` already carries). The PR4 unknown-eventType log gained
  `correlationId: env.correlationId` (the envelope IS parsed by that point) plus `traceId` via the
  CONSOLE_LOGGER's own `activeTraceId()` call (the span from `route` is still active).
- **`apps/notifications/src/presentation/notification-facts.controller.ts`** — identical widening
  (extract-before-parse) for the same reason; no unknown-eventType branch exists in this
  controller (notifications silently skips a non-notified fact, no log site there).
- **`apps/notifications/src/application/notification-dispatch.service.ts`** — `correlationId:
  envelope.correlationId` (direct parameter of `dispatch`) plus `traceId` via `activeTraceId()`.
  This is an **application-layer** file; see §4 below for the layering call this required.
- **`apps/notifications/src/infrastructure/notification/degrading-notification-sender.ts`** —
  `send(message: NotificationMessage)` carries no envelope at all, so `NotificationMessage` gained
  a new optional `correlationId?: string` field (`apps/notifications/src/application/ports
  /notification-sender.port.ts`), populated by `NotificationDispatchService.dispatch` the exact
  same way the pre-existing `messageId` field already is ("defence in depth", same precedent, same
  call site). `traceId` via `activeTraceId()` (the send happens inside the same fact-consume span
  chain).

## 3. Sites deliberately left uncovered, and why

- **PR3/malformed-envelope logs (both services)** — `correlationId` is deliberately omitted, not a
  gap. A malformed envelope has no trustworthy `correlationId` (the same field that failed to
  parse is the one that would carry it) — this is the exact, pre-existing, documented omission
  `apps/orders/src/presentation/saga-facts.controller.ts`'s own malformed-envelope branch already
  carries; widening only added `traceId` (available independently, from the Kafka message's raw
  headers, regardless of whether the payload parses).
- **`apps/projector/src/main.ts`'s three `console.log` boot lines** (backfill count, timeline-order
  migration count, "listening on port" banner) — genuinely boot-time, outside any request/fact/
  command context, the exact carve-out the brief names. Left untouched.
- **`apps/notifications/src/main.ts`'s startup banner** and
  **`apps/notifications/src/infrastructure/persistence/migrate-cli.ts`'s two lines** (migration
  applied / migration failed) — same boot/CLI-tool carve-out; `migrate-cli.ts` is a standalone
  script run by `pnpm db:migrate:notifications`, never part of request/fact handling.
- **`apps/notifications/src/infrastructure/notification/console-notification-sender.ts`'s
  `console.log`** — this is not a diagnostic/error log line at all; it IS the dev/fallback
  "sender" — the notification's own content, rendered to console in place of a real SMTP send. Not
  a structured-log call site `R58` is about, and not JSON-shaped.

No fact-handling line was left uncovered. Every genuine gap the audit and the sweep found is now
closed.

## 4. A layering note worth flagging to the reviewer

Two of the nine sites (`projection-apply.service.ts` in `apps/projector`,
`notification-dispatch.service.ts` in `apps/notifications`) are **application-layer** files, not
infrastructure/presentation. Every existing `activeTraceId()` call site in this repo (Orders,
Gateway) lives in infrastructure/presentation only — Orders' own application/CQRS layer never
imports `@opentelemetry/api` or `trace-context.ts`. To close `R58`'s "every fact-handling line" for
these two services' specific failure shapes (a signal-publish failure and a compensating-delete
failure, both application-layer concerns with no infrastructure equivalent), this pass imports
`../infrastructure/observability/trace-context.ts` directly from these two application-layer
files — a direct cross-layer import that nominally reads inward-only ("presentation → application
→ domain") backwards for this one cross-cutting concern.

Reasoning for the call: `@opentelemetry/api` carries zero framework/driver coupling (not
`@nestjs/*`, not `drizzle-orm`, not `kafkajs`/`nats`/`mongodb` — the actual CLAUDE.md non-negotiable
list), and building a dedicated `TraceContextPort` + DI binding for two single call sites would be
new-abstraction scope creep the brief explicitly warns against ("reuse the existing pattern; do
not invent a new logging abstraction"). But it IS a new precedent (no prior file in this repo
does this), and the reviewer may reasonably prefer a port. Flagging explicitly rather than
presenting it as an established pattern.

## 5. Armed-deletion record — one block per site, verbatim

Every block below: removed the addition, ran the named spec, captured the verbatim failure,
restored, re-ran green. `apps/orders/src/infrastructure/messaging
/idempotent-consumer.parity.spec.ts` (13/13) was re-run after restoring the two
`fact-retry-dispatcher.ts` copies to confirm the OI12 guard — which lives outside this feature's
edit scope and was not touched — stays green.

### 1. `apps/projector/src/infrastructure/messaging/fact-retry-dispatcher.ts`
Test: `fact-retry-dispatcher-log-trace-id.spec.ts` (new).
Deletion: removed `correlationId`/`traceId` from the dead-letter log meta.
```
AssertionError: expected undefined to be '79df175d4ee11717168fec43fdd3d34b' // Object.is equality
 ❯ ...expect(logged.traceId).toBe(originTraceId);
AssertionError: expected "error" to be called 1 times, but got 2 times
```

### 2. `apps/projector/src/infrastructure/persistence/mongo-read-model-writer.ts`
Test: `mongo-read-model-writer-log-trace-id.spec.ts` (new).
Deletion: removed `correlationId: orderId` from the retry log meta.
```
AssertionError: expected undefined to be '9c9ffcf5-f91f-49d6-a286-8c18b17c887c' // Object.is equality
 ❯ ...expect(logged.correlationId).toBe(orderId);
```

### 3. `apps/projector/src/application/projection-apply.service.ts`
Tests: `projection-apply-service-log-trace-id.spec.ts` (new) + `projection-apply.service.spec.ts`
(existing PR19 case, widened).
Deletion: removed `correlationId: envelope.correlationId` from the PR19 log meta.
```
AssertionError: expected undefined to be 'order-1' // Object.is equality
 ❯ ...expect(logged.correlationId).toBe(envelope.correlationId);
AssertionError: expected { eventId: 'event-2', …(3) } to match object { orderId: 'order-1', …(2) }
- "correlationId": "order-1",
```

### 4/5. `apps/projector/src/presentation/projector-facts.controller.ts`
Test: `projector-facts-controller-log-trace-id.spec.ts` (new, 3 cases) +
`projector-facts.controller.spec.ts` (existing PR4 case, widened).

Probe A — moved the header extraction back to AFTER the malformed-envelope catch (undoing the
"extract before parse" widening):
```
AssertionError: expected undefined to be '3ee2a03175c7ede76555da5cb1d51f42' // Object.is equality
 ❯ ...expect(logged.traceId).toBe(originTraceId);
```
Probe B (restored, then a second, independent probe) — removed `correlationId: env.correlationId`
from the PR4 unknown-eventType log:
```
AssertionError: expected undefined to be 'order-1' // Object.is equality
 ❯ ...expect(logged.correlationId).toBe(envelope.correlationId);
AssertionError: expected { …(3) } to match object { correlationId: 'order-1' }
```

### 6. `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher.ts`
Test: `fact-retry-dispatcher-log-trace-id.spec.ts` (new).
Deletion: same as projector's copy #1.
```
AssertionError: expected undefined to be 'c2d2f9cf557a7695aabd9a7a6292e73a' // Object.is equality
 ❯ ...expect(logged.traceId).toBe(originTraceId);
AssertionError: expected "error" to be called 1 times, but got 2 times
```

### 7. `apps/notifications/src/presentation/notification-facts.controller.ts`
Test: `notification-facts-controller-log-trace-id.spec.ts` (new, 2 cases).
Deletion: moved header extraction back to AFTER the malformed-envelope catch.
```
AssertionError: expected undefined to be '42ee98d1168dfa5677fa70470ea6b2df' // Object.is equality
 ❯ ...expect(logged.traceId).toBe(originTraceId);
AssertionError: expected "error" to be called 1 times, but got 2 times
```

### 8. `apps/notifications/src/application/notification-dispatch.service.ts`
Tests: `notification-dispatch-service-log-trace-id.spec.ts` (new) +
`notification-dispatch.service.spec.ts` (existing N13 case, widened).
Deletion: removed `correlationId: envelope.correlationId` from the N13 log meta.
```
AssertionError: expected undefined to be 'order-1' // Object.is equality
 ❯ ...expect(logged.correlationId).toBe(ENVELOPE.correlationId);
(second, independent probe, same removal, existing spec) AssertionError: expected undefined to be
'order-1' // Object.is equality ❯ ...expect(meta.correlationId).toBe('order-1');
```

### 9. `apps/notifications/src/infrastructure/notification/degrading-notification-sender.ts`
Tests: `degrading-notification-sender-log-trace-id.spec.ts` (new) +
`degrading-notification-sender.spec.ts` (existing case, widened).

Probe A — removed `correlationId: message.correlationId` from the degraded-send log meta:
```
AssertionError: expected undefined to be 'order-1' // Object.is equality
 ❯ ...expect(logged.correlationId).toBe('order-1');
(second, independent probe, existing spec) AssertionError: expected undefined to be 'order-1'
 ❯ ...expect(calls[0]!.meta.correlationId).toBe('order-1');
```
Probe B (restored, then a second, independent probe) — removed the `activeTraceId()` embed from
`CONSOLE_LOGGER`:
```
AssertionError: expected undefined to be '1e66250c1802d570c6c1f181003c5dbd' // Object.is equality
 ❯ ...expect(logged.traceId).toBe(originTraceId);
AssertionError: expected "error" to be called 1 times, but got 2 times
```

Every probe was restored immediately after capturing the failure, and the affected suite was
re-run green before moving to the next site.

## 6. Files touched

Production (`apps/projector/src/**`, `apps/notifications/src/**`):
- `apps/projector/src/infrastructure/observability/trace-context.ts` — added `activeTraceId()`.
- `apps/projector/src/infrastructure/messaging/fact-retry-dispatcher.ts` — traceId/correlationId
  on the dead-letter log (backported R58 exception, byte-identical to its notifications peer).
- `apps/projector/src/infrastructure/persistence/mongo-read-model-writer.ts` — traceId +
  `correlationId: orderId` on the lost-insert-race retry log.
- `apps/projector/src/application/projection-apply.service.ts` — traceId + correlationId on the
  PR19 signal-publish-failure log.
- `apps/projector/src/presentation/projector-facts.controller.ts` — extract-before-parse widening
  (traceId on the malformed-envelope log) + correlationId/traceId on the unknown-eventType log.
- `apps/notifications/src/infrastructure/observability/trace-context.ts` — added `activeTraceId()`.
- `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher.ts` — same as projector's
  copy, byte-identical after banner strip.
- `apps/notifications/src/presentation/notification-facts.controller.ts` — extract-before-parse
  widening on the malformed-envelope log.
- `apps/notifications/src/application/notification-dispatch.service.ts` — traceId + correlationId
  on the N13 log; sends `correlationId` on every outgoing `NotificationMessage`.
- `apps/notifications/src/application/ports/notification-sender.port.ts` — new optional
  `correlationId?: string` field on `NotificationMessage`.
- `apps/notifications/src/infrastructure/notification/degrading-notification-sender.ts` — traceId
  + `correlationId: message.correlationId` on the permanent-send-failure log.

Tests (new):
- `apps/projector/src/infrastructure/messaging/fact-retry-dispatcher-log-trace-id.spec.ts`
- `apps/projector/src/infrastructure/persistence/mongo-read-model-writer-log-trace-id.spec.ts`
- `apps/projector/src/application/projection-apply-service-log-trace-id.spec.ts`
- `apps/projector/src/presentation/projector-facts-controller-log-trace-id.spec.ts`
- `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher-log-trace-id.spec.ts`
- `apps/notifications/src/presentation/notification-facts-controller-log-trace-id.spec.ts`
- `apps/notifications/src/application/notification-dispatch-service-log-trace-id.spec.ts`
- `apps/notifications/src/infrastructure/notification/degrading-notification-sender-log-trace-id.spec.ts`

Tests (widened, existing):
- `apps/projector/src/application/projection-apply.service.spec.ts` (PR19 case)
- `apps/projector/src/presentation/projector-facts.controller.spec.ts` (PR4 case)
- `apps/notifications/src/application/notification-dispatch.service.spec.ts` (N13 case)
- `apps/notifications/src/infrastructure/notification/degrading-notification-sender.spec.ts`
  (permanent-failure case widened + one new case)

## 7. Traceability

This closes the code-side gap `R58`'s row (`specs/shared/test-matrix.md`) names. Per the brief,
`specs/shared/**` is owned by a concurrent spec pass and was not edited here — the row itself
should now be re-verified and, if the spec pass agrees the nine sites above cover the genuine
gap (with the malformed-envelope `correlationId` omission and the three boot-line exclusions
accepted as legitimate), flipped from "scoped" back to a clean `DONE`.

## 8. Verification run

- `apps/projector` unit suite (excluding `*.integration.spec.ts`): **172/172 passed** (19 files).
- `apps/notifications` unit suite (excluding `*.integration.spec.ts`): **114/114 passed** (27
  files).
- `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` (OI12 guard,
  unmodified): **13/13 passed**, confirming the two `fact-retry-dispatcher.ts` peer copies still
  satisfy the guard's peer-parity requirement without editing the guard itself.
- `pnpm quality` (lint + typecheck + full monorepo test:coverage): ran with the container stack
  (`docker compose`) already up, per the brief's own environmental note. **Exit code 0.** Every
  workspace package's test:coverage run reported all files passed, 0 failed (20/20 test-file
  groups), including `apps/web` (15 files, 74/74 tests) — the environmental caveat about
  `apps/web` timing out under load did not manifest on this run. `apps/orders` 518/518,
  `apps/projector` 172/172 (19 files), `apps/notifications` 114/114 (27 files).
- `./init.sh` was not re-run (this change touches no infra/compose/env surface); no reason to
  expect it to regress.
