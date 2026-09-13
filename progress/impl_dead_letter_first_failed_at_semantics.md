# impl: dead_letter_first_failed_at_semantics (dotnet backlog id 75)

## What

`specs/shared/asyncapi.yaml:2227-2229` (amendment SA-3) says:

> `x-first-failed-at` is the instant the FIRST processing attempt failed —
> never the instant processing began; it equals `x-failed-at` only when a
> single attempt was made.

This repository's three copies of `FactRetryDispatcher` all rendered the
dispatch-ENTRY instant instead:

- `apps/orders/src/infrastructure/messaging/fact-retry-dispatcher.ts:135-136`
  — `const enteredAt = this.clock.now(); const firstFailedAt = enteredAt;`
- `apps/projector/src/infrastructure/messaging/fact-retry-dispatcher.ts:126`
  — `const firstFailedAt = this.clock.now();` before the retry loop
- `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher.ts:123`
  — same shape

Fixed all three identically: `firstFailedAt` is now `Date | undefined`,
assigned once inside the `catch` block via `firstFailedAt ??= this.clock.now()`
— the first time an attempt fails, never re-stamped by a later attempt's
failure. At the DLQ-publish call site, `firstFailedAt ?? failedAt` supplies
the (structurally unreachable, since the loop always runs ≥1 time)
defensive fallback, matching the dotnet reference
(`src/Orders/Infrastructure/Messaging/FactRetryDispatcher.cs:96-97,131`,
`firstFailedAt ??= clock.UtcNow` / `firstFailedAt ?? failedAt`) byte-for-byte
in intent.

`enteredAt` in `apps/orders` was left untouched — it still feeds the
`otc_fact_processing_latency_ms` histogram at lines 142/171 and has nothing
to do with this header.

## Tests

- `apps/orders/src/infrastructure/messaging/fact-retry-dispatcher.spec.ts`
  — corrected the existing `'retries up to the configured maximum...'`
  case (previously asserted the wrong, entry-instant value against a clock
  that never advanced between entry and failure) and added
  `'x-first-failed-at equals x-failed-at when a single attempt was made
  (asyncapi.yaml:2227-2229, SA-3)'` for the contract's second clause.
- `apps/projector/src/infrastructure/messaging/fact-retry-dispatcher-first-failed-at.spec.ts`
  (new) — two cases, same shape as orders.
- `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher-first-failed-at.spec.ts`
  (new) — two cases, same shape as orders.

### A false-green trap found and corrected during arming

The first draft of all three specs used the existing `fixedClock` helper
(an array of instants consumed one-per-call, in call order). That helper
proved the orders case only by ACCIDENT: orders' old code shares one
`clock.now()` call between `enteredAt` and `firstFailedAt`
(`firstFailedAt = enteredAt`, no second call), while the fixed code adds a
genuine second call inside the catch — so old vs. new code call
`clock.now()` a DIFFERENT number of times, and the array-index shift is
what the test actually caught, not the semantic difference per se.

Projector and notifications have no separate `enteredAt` read, so their old
(wrong, before-the-loop) and new (right, inside-the-first-catch) code call
`clock.now()` the exact same number of times, in the same relative order —
a call-ordinal fake clock cannot tell "read before the loop" apart from
"read inside the first catch" when nothing in between also reads the
clock. First run of the armed (reverted) projector spec with this design
came back **174/174 green — a false negative**, caught only because arming
is mandatory here, not optional.

Replaced `fixedClock` with a SETTABLE `mutableClock(initial)` (`now()`
returns whatever was last `set(...)`, mirroring the dotnet reference's
`FakeClock`), and had the fake `process` callback advance the clock to a
distinct instant immediately before each throw — so "read before the loop"
and "read inside the first catch" genuinely observe different wall-clock
values, exactly as a real clock would. All three specs (including the
corrected orders one) now use this shape.

## Arming (per bullet 4)

All three restores used `cp` from backups taken before editing, verified
with `cmp`; no `git checkout`/`stash`/`reset`/`restore`/`clean` was used
anywhere (the repo has no uncommitted changes now beyond this feature's
own edits).

### apps/orders — reverted to `firstFailedAt = enteredAt`

Ran `pnpm --filter @otc/orders run test`. **2 failed / 519** (both the new
and the corrected test, `fact-retry-dispatcher.spec.ts`):

```
FAIL  src/infrastructure/messaging/fact-retry-dispatcher.spec.ts > FactRetryDispatcher — OR1 (retry-then-DLQ) > retries up to the configured maximum with exponential backoff, then publishes to the dlq topic and swallows
AssertionError: expected { failedConsumer: 'orders.saga', …(4) } to match object { failedConsumer: 'orders.saga', …(3) }
- Expected
+ Received
  {
    "attempts": 3,
    "failedAt": 2026-08-26T09:00:03.000Z,
    "failedConsumer": "orders.saga",
-   "firstFailedAt": 2026-08-26T09:00:01.000Z,
+   "firstFailedAt": 2026-08-26T09:00:00.000Z,
  }

FAIL  src/infrastructure/messaging/fact-retry-dispatcher.spec.ts > FactRetryDispatcher — OR1 (retry-then-DLQ) > x-first-failed-at equals x-failed-at when a single attempt was made (asyncapi.yaml:2227-2229, SA-3)
AssertionError: expected 2026-08-26T09:00:00.000Z to deeply equal 2026-08-26T09:00:05.000Z
```

Restored via `cp` from backup, `cmp`-verified byte-identical to the fixed
version I had written, then re-applied the fix (the backup was the
PRE-fix original, so I re-typed the fix rather than restoring a second
"fixed" backup — verified afterwards with `grep -n "firstFailedAt ??="`).

### apps/projector — reverted to `firstFailedAt = this.clock.now()` before the loop

Ran `pnpm --filter @otc/projector run test`. **2 failed / 174**
(`fact-retry-dispatcher-first-failed-at.spec.ts`):

```
FAIL  src/infrastructure/messaging/fact-retry-dispatcher-first-failed-at.spec.ts > FactRetryDispatcher (projector) — x-first-failed-at semantics (asyncapi.yaml:2227-2229, SA-3) > firstFailedAt is the FIRST attempt's own failure instant, never the dispatch-entry instant nor the last attempt's
AssertionError: expected { failedConsumer: 'projector', …(4) } to match object { failedConsumer: 'projector', …(3) }
-   "firstFailedAt": 2026-08-26T09:00:01.000Z,
+   "firstFailedAt": 2026-08-26T09:00:00.000Z,

FAIL  src/infrastructure/messaging/fact-retry-dispatcher-first-failed-at.spec.ts > FactRetryDispatcher (projector) — x-first-failed-at semantics (asyncapi.yaml:2227-2229, SA-3) > firstFailedAt equals failedAt when a single attempt was made
AssertionError: expected 2026-08-26T09:00:00.000Z to deeply equal 2026-08-26T09:00:05.000Z
```

Restored via `cp` from backup, `cmp`-verified, then re-applied the fix.

### apps/notifications — reverted the same way

Ran `pnpm --filter @otc/notifications run test`. **2 failed / 119**
(`fact-retry-dispatcher-first-failed-at.spec.ts`), same messages/shape as
projector (consumer `'notifications'`, topic `otc.notifications.facts.v1`).
Restored via `cp` from backup, `cmp`-verified, then re-applied the fix.

## Confirming green (post-restore, all three together)

```
pnpm --filter @otc/orders --filter @otc/projector --filter @otc/notifications run test
```

```
apps/notifications test:  Test Files  29 passed (29)
apps/notifications test:       Tests  119 passed (119)
apps/projector test:  Test Files  20 passed (20)
apps/projector test:       Tests  174 passed (174)
apps/orders test:  Test Files  53 passed (53)
apps/orders test:       Tests  519 passed (519)
EXIT:0
```

`pnpm lint` → `eslint .`, exit 0.

## Files touched

- `apps/orders/src/infrastructure/messaging/fact-retry-dispatcher.ts`
- `apps/orders/src/infrastructure/messaging/fact-retry-dispatcher.spec.ts`
- `apps/projector/src/infrastructure/messaging/fact-retry-dispatcher.ts`
- `apps/projector/src/infrastructure/messaging/fact-retry-dispatcher-first-failed-at.spec.ts` (new)
- `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher.ts`
- `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher-first-failed-at.spec.ts` (new)

Nothing under `specs/shared/` was touched. Not committed — the human gives
the commit word in this repository.
