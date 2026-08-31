# B5 closeout — `console-notification-sender.ts` traceability, and the `nats-stream-signal.adapter.ts` logging violation

Closes **B5** from `progress/review_final_checkpoint.md`, in code, per the human's instruction (not re-opening whether the malformed-envelope exclusion is legitimate — the reviewer already confirmed it is; this pass only touches the two items the reviewer found actually wrong).

## Scope of this pass

Touched only:

- `apps/notifications/src/infrastructure/notification/console-notification-sender.ts`
- `apps/notifications/src/infrastructure/notification/console-notification-sender.spec.ts` (read only, unchanged — the existing two tests still pass unmodified because the new fields are additive and omitted when absent)
- `apps/notifications/src/infrastructure/notification/console-notification-sender-log-trace-id.spec.ts` (new)
- `apps/gateway/src/infrastructure/messaging/nats-stream-signal.adapter.ts`
- `apps/gateway/src/infrastructure/messaging/nats-stream-signal.adapter.spec.ts` (updated: `fakeSubscription` now carries a `subject`, and the malformed-frame test asserts the new structured-JSON shape instead of the old free-text `console.error` call)
- `apps/gateway/src/infrastructure/messaging/nats-stream-signal-log-trace-id.spec.ts` (new)

Did not touch `specs/shared/**` (a spec pass owns the `R58` matrix cell), any other app, `packages/`, the README, `docs/`, the plan document, or `feature_list.json`. No commit made.

## 1. `console-notification-sender.ts` — the production-fallback line now carries `correlationId` + `traceId`

**What was threaded.** `ConsoleNotificationSender.send` now reads `message.correlationId` (already on the port, populated by `NotificationDispatchService.dispatch` — B5's finding #2) and calls the existing `activeTraceId()` helper (`../observability/trace-context.ts`, the same one `degrading-notification-sender.ts`'s `CONSOLE_LOGGER` already uses). Both are spread onto the JSON object only when truthy — the file's own established "omit, never log the literal string `undefined`" convention, matching `degrading-notification-sender.ts` exactly:

```ts
async send(message: NotificationMessage): Promise<void> {
  this.sent.push(message);
  const traceId = activeTraceId();
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'notifications: console adapter — would have sent an email',
      to: message.to,
      subject: message.subject,
      ...(message.correlationId ? { correlationId: message.correlationId } : {}),
      ...(traceId ? { traceId } : {}),
    }),
  );
}
```

No change to the port's shape (`NotificationMessage.correlationId` already existed — finding #2 in B5).

**Why this closes the finding, not just narrows it.** The finding's point 3 was that this sender is *also* the production degradation fallback (`app.module.ts:118`, `new DegradingNotificationSender(new SmtpNotificationSender(...), new ConsoleNotificationSender())`), and on that path this line is the *only* record a notification went out. The third test below drives the fix through exactly that composition, not a direct call.

### Tests — `console-notification-sender-log-trace-id.spec.ts` (new, 3 tests, all green)

1. `"logs the message's OWN correlationId and the REAL active span's traceId on a direct send"` — proves R58's own bar (**real** ids, equal to the originating span/message, not merely field presence) — **proves the finding's point 2**.
2. `'omits correlationId and traceId entirely — never the literal string "undefined" — when neither is available'` — proves the omit-not-fabricate convention holds for both new fields.
3. `"the PRODUCTION degraded path — DegradingNotificationSender falling back to ConsoleNotificationSender after a PERMANENT SMTP failure — still produces a traceable console line"` — composes `DegradingNotificationSender(inner=failing-SMTP-stand-in, fallback=real ConsoleNotificationSender)`, exactly `app.module.ts`'s binding, with the inner sender rejecting with a `classifySendFailure === 'permanent'` error (the quota-exhausted shape already used by `degrading-notification-sender.spec.ts`). Asserts both `console.error` (the degradation warning) and `console.log` (the fallback's own line) fired, and that the fallback's line carries the real `correlationId` and `traceId`. **This is the test the brief specifically demanded** — it does not call `ConsoleNotificationSender` directly.

### Armed-deletion evidence

Reverted the `send` method to its pre-fix body (removed `activeTraceId()` call and both spread clauses) and re-ran `console-notification-sender-log-trace-id.spec.ts`:

```
FAIL … logs the message's OWN correlationId and the REAL active span's traceId on a direct send
AssertionError: expected undefined to be 'order-1'
- Expected: "order-1"
+ Received: undefined
 ❯ … :62:36  expect(logged.correlationId).toBe('order-1');

FAIL … omits correlationId and traceId entirely …
AssertionError: expected "log" to be called 1 times, but got 2 times

FAIL … the PRODUCTION degraded path …
AssertionError: expected "log" to be called 1 times, but got 3 times
```

(The 2nd/3rd tests' call-count mismatch is a side effect of the first test's `logSpy.mockRestore()` never running because its own assertion threw first, so the spy accumulates across tests in the same file run — the deletion is still unambiguously proven by test 1's exact-value failure.) Restored the file from a pre-edit copy and diffed byte-identical (`diff … && echo IDENTICAL` printed `IDENTICAL`) before re-running green (5/5 across both spec files).

## 2. `nats-stream-signal.adapter.ts` — the decode-failure log, now structured

**What I found before writing the fix — this changed the plan.** The brief anticipated (conditionally) that a decode failure "may have none" of a correlation id, by analogy to the malformed-envelope precedent. I checked the actual wiring rather than assuming the analogy holds: `apps/projector/src/infrastructure/signal/nats-update-signal.publisher.ts` sets an `x-correlation-id` NATS **header** (`document.orderId`) via `natsHeaders()` *before* encoding the JSON body onto the same publish call. NATS headers are a channel entirely separate from the payload (`Msg.headers?: MsgHdrs`, decoded by the client independently of `Msg.data`), so a malformed body does **not** take the header down with it — unlike `saga-facts.controller.ts`'s malformed-envelope case, where no trustworthy value exists at all. So this is *not* the same class as the ratified precedent, and I threaded the real header value rather than declaring "none available."

`traceId` **is** honestly absent on this service's actual production call site: `main.ts` calls `NatsStreamSignalAdapter.start()` once at boot, outside any request span (there is no auto-instrumentation for a plain core-NATS subscribe loop, unlike the HTTP case `problem-json.filter.ts` relies on). I verified this both ways rather than asserting it from documentation alone — see tests 3 and 4 below, one of which surprised me (see "What surprised me").

```ts
private logDecodeFailure(message: Msg, error: unknown): void {
  const correlationId = message.headers?.get('x-correlation-id');
  const traceId = activeTraceId();
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'gateway: nats-stream-signal — failed to decode a signal frame',
      subject: message.subject,
      ...(correlationId ? { correlationId } : {}),
      ...(traceId ? { traceId } : {}),
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
```

`message.subject` is also included — a genuinely available, non-fabricated identifier (which of the two wildcarded subjects the frame arrived on) that the old free-text line didn't carry either.

### Tests

- `nats-stream-signal.adapter.spec.ts` — updated `fakeSubscription` to carry a `subject` per frame (matching the real `Msg` shape) and rewrote the existing malformed-frame test to assert the new structured JSON (`level`, `message`, `subject`) instead of merely `errorSpy.toHaveBeenCalled()`.
- `nats-stream-signal-log-trace-id.spec.ts` (new, 4 tests):
  1. reads `x-correlation-id` from real NATS headers set via `natsHeaders()`, independent of the malformed body.
  2. omits `correlationId` (never the string `"undefined"`) when no header is present.
  3. omits `traceId` when the adapter is started with no span active — the actual production shape, proven with a real OTel provider registered but no active span.
  4. threads a real `traceId` when one genuinely is active at the moment the log fires — proves `activeTraceId()` is actually wired, not a dead call.

### Armed-deletion evidence (two separate deletions, each independently confirmed)

**Deletion A — remove `correlationId` threading** (kept `traceId` line):
```
FAIL … reads x-correlation-id from the NATS HEADERS …
AssertionError: expected undefined to be 'order-42'
- Expected: "order-42"
+ Received: undefined
 ❯ …:78:34  expect(logged.correlationId).toBe('order-42');
```
Subsequent tests in the same run also failed (call-count cascade, same benign mechanism as above — `errorSpy.mockRestore()` never reached). Restored from the pre-edit backup; `diff` printed `IDENTICAL`.

**Deletion B — remove `traceId` threading** (kept `correlationId` line), run narrowed to the one test that proves the mechanism:
```
$ vitest run … -t "threads the REAL active span"
FAIL … threads the REAL active span's traceId …
AssertionError: expected undefined to be 'b27117ed6fe4d2fb4f15b125d9be49f2'
- Expected: "b27117ed6fe4d2fb4f15b125d9be49f2"
+ Received: undefined
 ❯ …:141:30  expect(logged.traceId).toBe(originTraceId);
```
Restored from the pre-edit backup; `diff` printed `IDENTICAL` again. Re-ran both spec files green (7/7) after restoring.

### What surprised me (recorded per the brief)

My first draft of test 3 assumed `traceId` would be absent in **every** case this test file could construct, including one where I deliberately wrapped `adapter.start()` in an active span to "prove the plumbing works, like nothing is fabricated." That draft failed — `activeTraceId()` **did** pick up the wrapping span's `traceId`, because `NatsStreamSignalAdapter.consume`'s `for await` loop is kicked off synchronously (via `void this.consume(...)`, fire-and-forget) from inside `start()`, and Node's `AsyncLocalStorage`-based context manager propagates the context active at that synchronous call across every subsequent microtask continuation of that same async chain — for as long as the loop runs, which in production is the lifetime of the process. That is real, not a test artifact: if this service's boot sequence ever had an active span at the moment `main.ts` calls `.start()`, every single decode-failure log for the rest of the process's life would carry that one boot-time `traceId`, which is arguably not very useful but is exactly what the "same formula everywhere" rule produces. I corrected the test file to state this precisely (split into "no span active — the actual production shape" and "a span **is** active — proves the wiring") rather than the imprecise "typically undefined" I initially wrote in the source comment, and also tightened the source comment itself to say the same thing accurately.

### Deliberately left without a `correlationId`

None on this file — the real header made the "no trustworthy value" narrowing inapplicable here, so nothing was deliberately left out. Where the header itself is genuinely absent (test 2), the line omits the key, which is the honest outcome for that concrete input, not a class-wide narrowing.

## Verification

- `pnpm --filter @otc/notifications exec vitest run src/infrastructure/notification/console-notification-sender-log-trace-id.spec.ts src/infrastructure/notification/console-notification-sender.spec.ts` — 2 files / 5 tests passed.
- `pnpm --filter @otc/gateway exec vitest run src/infrastructure/messaging/nats-stream-signal.adapter.spec.ts src/infrastructure/messaging/nats-stream-signal-log-trace-id.spec.ts` — 2 files / 7 tests passed.
- Both armed deletions (console sender's fields; gateway adapter's `correlationId` and, separately, its `traceId`) turned a NAMED test red with the verbatim messages recorded above, then were restored byte-identical (`diff` confirmed) before re-verifying green.
- `pnpm quality` (lint + typecheck + `test:coverage` across all workspaces) — **exit 0**. First run surfaced one new lint warning (`'JSONCodec' is defined but never used` in the new gateway spec, from an import I ended up not needing); fixed by removing the unused import; re-ran `pnpm quality` — exit 0 again, 0 lint warnings, all workspaces' test suites green including `apps/web` (74/74, no timeout this run — noted per the task's environment caveat that `apps/web` can time out under load; it did not this run, so nothing to disclose there).
- `./init.sh` — not re-run in this pass (no harness/state files touched); nothing in this change touches anything `init.sh` checks.

## Not done / out of scope

- Did not touch `specs/shared/test-matrix.md`'s `R58` cell — the human's instruction and the task brief both reserve that to a spec pass, and the scope explicitly excludes `specs/shared/**`.
- Did not re-litigate the malformed-envelope exclusion (`saga-facts.controller.ts`) — the reviewer already confirmed it is legitimate; out of scope for this pass by direct instruction.
- Did not touch `apps/orders`' `saga-command-sweeper.service.ts` claim-cycle log or `order.sagas.ts`'s `resilient()` branch — B5's note about the row's own enumeration being incomplete is a matrix-wording issue, not a code defect, and out of this pass's file scope.
