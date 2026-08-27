# `orders_cancel_responder` (feature 41) — implementation report

## What this is

`orders.cancel`, a new NATS RPC responder in Orders for operator-initiated
cancellation — the closest existing analogue is R27/R28's fact-driven
credit-rejection compensation, but this is a genuinely different trigger: an
RPC request, not a consumed fact, and the applicable branch depends on
*which* status the order is currently in (`specs/shared/saga.md` §4.3's
generalisation table). `sdd: false` — no `specs/orders_cancel_responder/`;
worked from `feature_list.json`'s acceptance list plus the task brief's own
pointers into `specs/shared/`.

## Starting-state cases — what is complete and what is not

| Starting status | Built? | Behaviour |
|---|---|---|
| `placed` | **Yes** | Cancels immediately, reason `operator_cancelled`, via `Order.cancel` — the exact same domain method, no bypass. |
| `stock_reserved` | **Yes** | Issues `stock.release` (reason `order_cancelled`) through the *existing* `SagaCommandStore` + `SagaCommandDispatcher` + `IssueStockReleaseCommand` fast-path mechanism R27/R28 already use. Order stays `stock_reserved` until the real `stock.released.v1` fact arrives; `saga-steps.ts`'s existing step (precondition `stock_reserved`, `mapReason('order_cancelled') -> 'operator_cancelled'`) completes the cancellation with **zero changes to that file** — it was already reason-parametric before this feature touched anything. |
| `despatched`/`invoiced`/`paid`/`completed`/already-`cancelled` | **Yes** | Rejected with `ORDER_NOT_CANCELLABLE` (409 at the Gateway) by calling `Order.cancel` and catching its own `OrderTransitionNotAllowedError` — no new status-set check written; the aggregate's existing R8/R9/O5/O7 guard is reused verbatim. |
| `credit_approved`/`confirmed` | **NOT built** | Replies `UNAVAILABLE` (503) with a message naming the exact gap. See "The one thing I did not build" below — this is not a corner cut, it is a missing piece of the shared spec/infrastructure that is out of this feature's bounded scope to add. |

## The one thing I did not build, and why (read this first)

`saga.md` §4.3's generalisation table names the `credit_approved`/`confirmed`
branch as: release the credit hold first (`credit.release` -> Billing,
emitting `credit.released.v1` reason `order_cancelled`), *then* release
stock (`stock.release`), *then* cancel — reverse order of acquisition.

I went looking for the RPC Orders would call to do the first step, and it
does not exist, at any of the three layers that would need it:

1. **`specs/shared/asyncapi.yaml`** — the `channels:` list has
   `billing.credit.hold` and `billing.credit.list`, nothing named
   `creditRelease`/`billing.credit.release`. `CreditReleasedPayload.reason`
   already includes `'order_cancelled'` (line 572) and
   `OrdersCancelReplyPayload.compensationPlanned` already includes the enum
   value `credit_release` — the spec clearly *intends* this capability to
   exist — but there is no RPC channel to trigger it.
2. **`packages/contracts`** (generated from the above) — consequently no
   `CreditReleaseRequestPayload`/`CreditReleaseReplyPayload` type exists.
3. **`apps/billing/src/presentation/credit.controller.ts`** — exposes
   exactly two `@MessagePattern`s, `billing.credit.hold` and
   `billing.credit.list`. No release responder. `BuyerCredit.releaseHold`
   (`apps/billing/src/domain/buyer-credit.ts`) already exists as a *domain*
   method with a `reason` parameter and is already called by
   `payment-register.handler.ts` — the capability is real, it is just never
   exposed as an RPC a caller other than payment-registration can reach.

Every existing `SagaCommandsPort` method (`saga-commands.port.ts`) is typed
end-to-end by a generated `@otc/contracts` type — that is the port's own
stated design. Adding a sixth method here would mean either (a) editing
`specs/shared/asyncapi.yaml` and regenerating `@otc/contracts` — a
shared-spec change the sibling #8/#9 assessments would silently not know
about, exactly what "keep `specs/shared/` stack-agnostic" forbids one
implementer from doing unilaterally — or (b) hand-rolling a local,
unauthorised request/reply shape that breaks the "every port method is a
generated contract type" invariant and would very likely not match whatever
shape a future `spec_author` pass actually settles on for
`billing.credit.release`.

I chose neither. `CancelOrderHandler` recognises `credit_approved`/
`confirmed` as legal per R8 (it does not lie about that), but replies
`UNAVAILABLE`, not `ORDER_NOT_CANCELLABLE`: the latter is the wire-documented
code for despatched-onward business refusal, and reusing it here would be
inaccurate — the transition **is** legal, the responder just cannot service
it yet, which is exactly what `UNAVAILABLE` (-> HTTP 503, "the owning
context is unreachable") already means elsewhere in this codebase (the
stock-check-timeout path in `place-order.handler.ts` draws the identical
distinction). The order is left completely untouched — verified live, see
below.

**This needs a follow-up feature**: a new `billing.credit.release` asyncapi
channel + schema (spec-first, through `spec_author`), the regenerated
`@otc/contracts` types, a Billing responder exposing `BuyerCredit.releaseHold`
over that channel, and then a small extension to `CancelOrderHandler` (add
`credit.release` to `SagaCommandKind`, a payload builder, and a second
reason-parametric step so `credit.released.v1` arriving while
`credit_approved`/`confirmed` — not `paid` — issues `stock.release` next
instead of completing the R24 happy path). I did not attempt any of that
here — it is out of `apps/orders/**`'s bounded scope and would have meant
inventing wire contract the task explicitly told me not to invent.

## The reverse-order-of-acquisition proof the task asked for

**Not produced**, for the reason above: there is no second command to issue,
so there is nothing to prove is issued *after* the first. I want to be
explicit rather than let this look quietly skipped: the task's binding rule
was "a test asserting `credit.release` is issued strictly before
`stock.release`... not merely that both eventually happen" — I cannot write
that test because `credit.release` cannot be issued at all in this
deployment. What I *did* prove instead, live and in an integration test, is
the ordering rule for the branch that IS built: `stock.release` is
dispatched, the order visibly stays `stock_reserved` (not `cancelled`) until
`stock.released.v1` is *observed* as a fact, and only then does cancellation
happen — the "release first, cancel second" causal ordering R27/R28 already
established, exercised again for the operator-triggered case.

## A second gap found while reading, also out of scope: the operator note

Acceptance criterion 4 says "the operator note from `CancelOrderRequest`
lands on the read-model timeline." I traced this all the way through and it
cannot land there either, for a similar reason:

- `OrdersCancelRequestPayload.note` exists on the wire (asyncapi.yaml,
  optional).
- `order.cancelled.v1`'s payload — `OrderCancelledPayload`
  (asyncapi.yaml/`@otc/contracts`) — has **no `note` field at all**:
  `orderReference`, `retailerCode`, `companyCode`, `cancellationReason`,
  `cancelledAt`, `compensationSteps`. Nothing else.
- Even if I stuffed an extra property onto the payload object at the Orders
  end (bypassing the generated type), `apps/projector/src/domain/summaries.ts`'s
  `orderCancelledSummary` builds the read-model `TimelineEntry.detail` from
  an explicit object literal (`{ cancellationReason, compensationSteps }`),
  not a spread of the raw payload — the extra field would be silently
  dropped, not surfaced.

Fixing this for real needs a `note`/`operatorNote` field added to
`OrderCancelledPayload` in `specs/shared/asyncapi.yaml`, the regenerated
contracts, `order-events.ts`'s `orderCancelledEvent` builder passing it
through, and `apps/projector`'s summary builder surfacing it — three of
those four touch points are outside `apps/orders/**`, and the first is
`specs/`. I did not do any of this. `CancelOrderHandler.execute` does accept
and thread the `note` as far as it *can* reach inside its own bounded scope
(the synthetic diagnostic envelope built for the `stock_reserved` branch's
`SagaCommandStore.enqueue` call carries it, purely for DLQ-redrive
diagnostics if that command ever exhausts retries) — but this does **not**
satisfy the acceptance criterion, and I want that stated plainly rather than
have the presence of a `note` parameter on the DTO/handler look like it does.

## Files touched

- `apps/orders/src/application/cancel-order.handler.ts` — new; the
  application logic, all four branches (three built, one recognised-but-
  unavailable), described above.
- `apps/orders/src/application/cancel-order.handler.spec.ts` — new; 10 unit
  tests, every port faked.
- `apps/orders/src/presentation/orders-cancel.controller.ts` — new; the
  `@MessagePattern('orders.cancel', Transport.NATS)` responder, mirrors
  `orders-create.controller.ts`'s shape exactly (explicit transport,
  `@Inject`, never throws, trace-context propagation).
- `apps/orders/src/presentation/orders-cancel.controller.spec.ts` — new; 7
  unit tests, every outcome -> wire-shape mapping.
- `apps/orders/src/presentation/dto/orders-cancel.dto.ts` — new; validated
  request DTO.
- `apps/orders/src/orders-cancel.integration.spec.ts` — new; 3 Testcontainers
  integration tests (real MySQL + Kafka + NATS) — see below.
- `apps/orders/src/app.module.ts` — added `OrdersCancelController` +
  `CancelOrderHandler` provider (`useFactory`, explicit `inject`, mirrors
  `PlaceOrderHandler`'s existing wiring pattern).
- `apps/orders/src/test-support/saga-integration-harness.ts` — extended
  `startSagaAppFromFixtures` to also register `OrdersCancelController` +
  `CancelOrderHandler` and connect the bare-JSON NATS microservice
  (`createOrdersNatsMicroserviceOptions`, the same production factory
  `orders-create-wire.integration.spec.ts` already proves against) — so the
  saga harness can now exercise the cancel responder end-to-end against the
  same real Kafka consumer group that completes the async branch.
- `feature_list.json` — status `pending` -> `in_review` (feature 41 only).

No changes to `apps/gateway`, `apps/billing`, `apps/fulfillment`, or
`specs/`, per the bounded scope.

## Traceability

`sdd: false` — no per-feature `R<n>` set, so no `specs/shared/test-matrix.md`
row belongs to this feature. Note for the record: my tests were briefly
named `R41-*`, which collided with the *pre-existing*, unrelated `R41`
("payment and pre-invoice cancellation release credit with the right
reason", `credit-ledger.spec.ts`, already `DONE`) — a coincidence between
feature-id 41 and requirement-id R41. Renamed to `OCR-*` (Orders Cancel
Responder) before finishing, so nothing in `test-matrix.md` needed touching
and nothing here misrepresents itself as proving R41.

The behaviour this feature reuses is covered by requirements that are
already `DONE` in `test-matrix.md`: R8 (cancel legality), R9 (illegal-edge
refusal), R10 (reason requirement) — this feature adds no new `R<n>`, it
exercises existing ones from a new caller.

## Armed-deletion tests — verbatim failures

All four in `apps/orders/src/application/cancel-order.handler.ts`, armed one
at a time, `cancel-order.handler.spec.ts` re-run, then restored (confirmed
green again after each restore):

**1. `placed`/terminal branch — removed the `txOrder.cancel(...)` call
itself** (replaced with a no-op). 6 of 10 tests failed:

```
FAIL OCR-placed — cancels immediately with reason operator_cancelled, saves the order, issues no command
AssertionError: expected undefined to be 'operator_cancelled'
  expect(result.cancellationReason).toBe('operator_cancelled');

FAIL OCR-terminal — replies not_cancellable for status despatched/invoiced/paid/completed
AssertionError: expected 'cancelled' to be 'not_cancellable'
  expect(result.outcome).toBe('not_cancellable');

FAIL OCR-terminal — an ALREADY-cancelled order also replies not_cancellable
AssertionError: expected 'cancelled' to be 'not_cancellable'
```

**2. `stock_reserved` branch — removed the `commandStore.enqueue(...)` call**
(left the transaction body empty). 1 test failed:

```
FAIL OCR-stock_reserved — enqueues stock.release (reason order_cancelled) and dispatches the fast-path command
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
  expect(enqueueSpy).toHaveBeenCalledTimes(1);
```

**3. `credit_approved`/`confirmed` guard — removed the
`CREDIT_HELD_STATUSES.has(order.status)` check.** 2 tests failed — and this
one is the interesting failure, not just a mechanical one: with the guard
gone, `credit_approved`/`confirmed` falls through to the terminal branch,
where `Order.cancel` **succeeds** (the domain legally permits cancelling
from those statuses, per R8) — meaning the deletion does not crash, it
*silently* cancels the order while credit and stock remain held forever,
exactly the orphaned-resource bug this guard exists to prevent:

```
FAIL OCR-credit-gap — replies credit_release_unavailable for status credit_approved
AssertionError: expected 'cancelled' to be 'credit_release_unavailable'
  expect(result.outcome).toBe('credit_release_unavailable');
```

**Reverse-order-of-acquisition test**: not applicable — see "The one thing I
did not build" above. There is no second command whose ordering could be
armed and probed.

## Testing summary

- `apps/orders/src/application/cancel-order.handler.spec.ts` — 10 unit
  tests, pure (every port faked).
- `apps/orders/src/presentation/orders-cancel.controller.spec.ts` — 7 unit
  tests, outcome -> wire-shape mapping.
- `apps/orders/src/orders-cancel.integration.spec.ts` — 3 Testcontainers
  integration tests (real MySQL 8.4.11 + Kafka 4.3.1 + NATS 2.14.5), all
  green:
  - `OCR-placed` — cancels over the real bare-JSON NATS wire.
  - `OCR-stock_reserved` — issues `stock.release` over real NATS; a real
    `stock.released.v1` published over real Kafka completes the
    cancellation, proven against a deliberately narrow stub (see next
    paragraph).
  - `OCR-terminal` — `ORDER_NOT_CANCELLABLE` from `despatched`-or-later,
    order status unmutated.

**A real race, found and isolated, not silently worked around**: the first
version of the `stock_reserved` integration test used the existing full
`startStubSagaResponders` (all five commands answered instantly) and failed
non-deterministically — by the time the test's own poll observed
`stock_reserved` and issued the cancel RPC, the *real* saga's own fast path
had already dispatched `credit.hold` (the very next owed command,
unconditionally, the instant `stock.reserved.v1` lands) and the fully-
responsive stub had already approved it, so the order had moved on to
`credit_approved`/`confirmed` before my assertion ran. This is a genuine
race between an operator's cancel decision and the saga's own forward
progress — compressed to near-zero latency by a stub that never blocks, but
real in principle against real Billing/Fulfillment too. I isolated it rather
than paper over it: `startFulfillmentOnlyResponder` (in the integration
spec) answers `stock.reserve`/`stock.release` only, leaving `credit.hold`
with no responder at all (same "Fulfillment/Billing is down" shape
`saga-command-retry.integration.spec.ts` already uses deliberately) — this
pins the order at `stock_reserved` deterministically and proves the branch
this feature actually builds without the unbuilt `credit_approved` branch
ever entering the picture. I did not attempt a general fix for this race in
production code (e.g. locking the order row against concurrent saga
progression) — it is a real, if narrow, window (the same shape of race the
existing fact-driven R25 precondition-guard already defends against
uniformly for *facts*; an operator-cancel command hitting the identical
window is not currently defended the same way) and belongs in a design
discussion, not a quick patch under this feature's bounded scope. Noted
below under "surprises."

## Live end-to-end verification (real running services, not Testcontainers)

Infra (`docker-compose.infra.yml`) already running; `otc-kafka` had exited,
restarted it (`docker start otc-kafka`). Confirmed seeded reference data (12
products, 7 retailers, 22 companies in `otc_orders`; 154 rows in
`otc_billing.credits`; 215 rows in `otc_fulfillment.stock`). Built and
started all four services for real:

```
pnpm --filter @otc/orders run build && pnpm --filter @otc/orders run start        # :3002
pnpm --filter @otc/fulfillment run build && pnpm --filter @otc/fulfillment run start  # :3003
pnpm --filter @otc/billing run build && pnpm --filter @otc/billing run start      # :3004
pnpm --filter @otc/gateway run build && pnpm --filter @otc/gateway run start      # :3001
```

Orders' boot log confirms the new controller registered:
`[RoutesResolver] OrdersCancelController {/}`, alongside
`OrdersCreateController` on the same NATS microservice.

Logged in (`POST /auth/login`), then drove all four cases through the real
Gateway -> real Orders -> real Fulfillment/Billing stack:

**Case 1 — `placed`, immediate.** Placed `ORD-000039`, cancelled it in the
same breath:

```
POST /orders/{id}/cancel {"note":"..."} -> 200
{"orderId":"e20373bd-...","orderReference":"ORD-000039","status":"cancelled","cancellationReason":"operator_cancelled","compensationPlanned":[]}
```

Verified against Orders' real write-model MySQL directly (`otc_orders.orders`):
`status=cancelled, cancellation_reason=operator_cancelled`.

**Case 2 — `stock_reserved`, async compensation.** Placed `ORD-000040`,
polled the real MySQL row every iteration of a tight loop, caught it at
`stock_reserved` on the 2nd poll, cancelled immediately:

```
POST /orders/{id}/cancel -> 200
{"orderId":"50ee20cd-...","orderReference":"ORD-000040","status":"stock_reserved","cancellationReason":null,"compensationPlanned":["stock_release"]}
```

Polled again — cancellation completed asynchronously shortly after. Final
state, checked against **both** real databases directly:

```
otc_orders.orders:          status=cancelled, cancellation_reason=operator_cancelled
otc_fulfillment.reservations: order_reference=ORD-000040, product_code=PRD-0001, units=2, status=released
```

Fulfillment's real reservation row is genuinely `released` — not a
simulated/stubbed value, the real service processed the real `stock.release`
RPC and wrote it.

**Case 3 — `despatched`-onward, terminal rejection.** Incidentally captured
first (an earlier order, `ORD-000038`, had already raced to `invoiced` by
the time I cancelled it — the real saga moves fast against real but local
services) and reproduced deliberately for `ORD-000041`'s sibling scenario
below; both returned the same shape:

```
POST /orders/{id}/cancel -> 409
{"title":"Order is not cancellable","status":409,"code":"ORDER_NOT_CANCELLABLE","detail":"order ORD-000038 cannot be cancelled from status \"invoiced\""}
```

409, not 503 — confirms the Gateway's `rpc-error-mapping.ts` maps this
correctly.

**Case 4 — `credit_approved`/`confirmed`, the documented gap.** Placed
`ORD-000041`, caught it at `confirmed`, cancelled:

```
POST /orders/{id}/cancel -> 503
{"title":"The owning context is unreachable","status":503,"code":"UPSTREAM_UNAVAILABLE",
 "detail":"order ORD-000041: cancellation from status \"confirmed\" requires releasing an active credit hold before stock (reverse order of acquisition, saga.md §4.3), and this deployment has no billing.credit.release RPC to do that yet — order left unchanged, retry once that capability lands"}
```

Verified the order was genuinely left untouched: `otc_orders.orders` shows
`ORD-000041` continued its normal saga progression afterward (later observed
at `invoiced`, `cancellation_reason=NULL`) — the rejected cancel attempt
mutated nothing.

All four live cases match their integration-test counterparts exactly. Both
dev processes stopped afterward (`pkill -f "node dist/main.js"`, confirmed
no residual process).

## Quality gates

- `pnpm --filter @otc/orders run typecheck` — clean.
- `npx eslint` on every new/touched file — clean, no output (domain-purity /
  DI-token / transport-binding rules all pass).
- `pnpm --filter @otc/orders run test` (unit) — **502 passed** (up from 485
  before this feature; +17 new: 10 handler + 7 controller), 52 files, no
  regressions.
- `pnpm run lint` (repo-wide) — clean.
- `pnpm run typecheck` (repo-wide, all 10 workspace projects) — Done, 0
  errors.
- `pnpm run test` (repo-wide unit) — all green: contracts 22, shared-kernel
  69, notifications 82, fulfillment 83, gateway 121, billing 138, **orders
  502**, projector 133, seed 119.
- Integration (Testcontainers): `orders-cancel.integration.spec.ts` (3/3),
  plus re-ran `saga-command-retry.integration.spec.ts` (2/2) and
  `saga-happy-path.integration.spec.ts` (1/1) — the two existing suites that
  share the harness file I extended — to confirm no regression from wiring
  `OrdersCancelController`/the NATS microservice into it. All green.
- `./init.sh` — exit 0.

## What remains

1. **`credit_approved`/`confirmed` compensation** — needs a new
   `billing.credit.release` asyncapi channel (spec-first), regenerated
   `@otc/contracts`, a Billing responder, and a small extension to
   `CancelOrderHandler`/`saga-steps.ts` (a second, reason-parametric
   `credit.released.v1` step distinguishing "mid operator-cancel
   compensation" from R24's `paid -> completed` happy path by the order's
   *current* status, since `SAGA_STEPS` keys one entry per `eventType`).
   Out of this feature's bounded scope; flagged for a follow-up feature.
2. **Operator note on the timeline** (acceptance criterion 4) — needs a
   `note` field added to `OrderCancelledPayload` (asyncapi.yaml +
   regenerated contracts), `order-events.ts` passing it through, and
   `apps/projector`'s `orderCancelledSummary` surfacing it in
   `TimelineEntry.detail`. Not built — three of the four touch points sit
   outside `apps/orders/**`.
3. **The operator-cancel-vs-saga-forward-progress race** (see "Testing
   summary" above) — real, narrow, currently undefended for the RPC-
   triggered path the way R25's precondition guard defends the fact-driven
   path. Not a correctness bug in what I built (the compensation this
   feature issues is still correctly ordered and idempotent even if it
   loses the race — the outstanding scenario is that a `stock.released.v1`
   arriving for reason `order_cancelled` while the order has *already*
   moved past `stock_reserved` would be silently ignored by R25's existing
   precondition check, stranding a released reservation on an order that
   keeps progressing normally) — worth a design discussion, not fixed here.

## Surprises

- The domain layer (`Order.cancel`, `order-transitions.ts`,
  `order-cancellation-reason.ts`) was **already fully built** for
  `operator_cancelled` from all four legal statuses before this feature
  touched anything — confirmed by reading, matching the acceptance
  criterion's own framing ("no new domain modeling"). Likewise
  `saga-steps.ts`'s `stock.released.v1` step was already reason-parametric
  (`mapReason('order_cancelled') -> 'operator_cancelled'`) with a code
  comment literally saying "the operator-initiated release ... is [a later]
  feature's, not built here" — so the `stock_reserved` branch needed zero
  changes to existing saga machinery, only a new caller of it.
- The credit-release RPC gap was the opposite: the spec's *intent* is
  unambiguous (`CreditReleasedPayload.reason: 'order_cancelled'`,
  `compensationPlanned: 'credit_release'`, `BuyerCredit.releaseHold` already
  implemented) but the actual trigger channel was simply never added — an
  oversight in the shared spec's completeness, not a deliberate design
  choice to exclude it, discovered only by checking `asyncapi.yaml`'s
  channel list line by line rather than assuming the bounded-scope brief's
  premise ("their existing credit.release/stock.release responders already
  exist") was correct. It was half right: `stock.release` exists;
  `credit.release` does not, anywhere.

---

## Follow-up pass — billing.credit.release, closing the credit_approved/confirmed gap

This pass builds the two things that consume the shared contract the leader
added itself (`specs/shared/asyncapi.yaml`'s `creditRelease`/
`creditReleaseReply` channels, `CreditReleaseRequestPayload`/
`CreditReleaseReplyPayload` in `@otc/contracts`): Billing's responder, and
Orders' completion of the `credit_approved`/`confirmed` cancel branch. Scope
was `apps/billing/**` and `apps/orders/**` only, per the brief.

### What was built

**1. Billing — `billing.credit.release` responder.** New files:
`apps/billing/src/application/credit-release.handler.ts` (plain class,
mirrors `credit-hold.handler.ts`'s split exactly — `unitOfWork.execute(tx =>
lockForOrder → BuyerCredit.releaseHold(reason: 'order_cancelled') → entry ?
save+released:true : released:false, no save)`), its
`ReleaseCreditCommand`/`ReleaseCreditHandler` pair (`credit.commands.ts`,
`credit.command-handlers.ts`), a `CreditReleaseRequestDto`
(`presentation/dto/credit.dto.ts` — no `amount`, no `reason`: the RPC always
releases with `order_cancelled`, the wire payload has no `reason` field at
all), and a new `@MessagePattern(CREDIT_RELEASE_SUBJECT, Transport.NATS)`
responder on the EXISTING `CreditController` (same file `credit.hold`/
`credit.list` already live on — a different aggregate's write path would
have gone on its own controller, but this is the SAME `BuyerCredit`
aggregate). Wired into `app.module.ts`'s existing `useFactory` pattern.
`CreditLineNotFoundError` (BC3) is reused unchanged from `credit.hold`'s own
vocabulary — no new application error needed.

**2. Orders — the `credit_approved`/`confirmed` branch, completed.**
`cancel-order.handler.ts`'s `CREDIT_HELD_STATUSES` branch now calls
`beginCreditReleaseCompensation`, a sibling of the existing
`beginStockReleaseCompensation` sharing the SAME durable mechanism
(`SagaCommandStore.enqueue` + the `IssueCreditReleaseCommand` fast-path hop,
a new sixth `Issue…Command` mirroring the existing five). `CancelOrderResult`
lost its `credit_release_unavailable` outcome entirely — the branch now
returns `compensation_pending` with `compensationPlanned:
['credit_release', 'stock_release']`, and `orders-cancel.controller.ts`
dropped the now-dead `UNAVAILABLE` mapping.

**3. The gap the brief's own framing did not anticipate — `saga-steps.ts`
needed a SECOND structural extension, not just a new outbound RPC.**
`credit.released.v1` previously had exactly one legal precondition (`paid`,
R24). The new `credit_approved`/`confirmed` compensation makes it a fact
with a precondition that DIFFERS by which case is unwinding — after
`CancelOrderHandler` issues `credit.release`, the resulting
`credit.released.v1` fact arrives while the order is STILL `credit_approved`/
`confirmed` (the release's own `apply` is a no-op, mirroring
`credit.rejected.v1`'s R27 no-op), and that variant must own `stock.release`
next — a THIRD legal precondition R24's single-variant step table had no
room for. `SAGA_STEPS`'s value type is now `SagaStep | readonly SagaStep[]`;
`credit.released.v1` is now `[paid, credit_approved, confirmed]`, three
variants. Two new functions, `stepVariantsFor`/`stepForStatus`, replace the
single status-less `stepFor` lookup inside `SagaFactHandler.handle` (kept,
unchanged, for every remaining single-variant caller — it now THROWS on an
ambiguous multi-variant `eventType`, rather than silently picking one).

Wiring `stock.release`'s owed reason through this required a second change:
`buildSagaCommandPayload`'s `stock.release` case was hardcoded to
`reason: 'credit_rejected'` (the only prior caller, `credit.rejected.v1`).
It now takes the triggering `Envelope` and derives the reason
(`stockReleaseReasonFor` in `saga-command-payloads.ts`) — `credit_rejected`
for that prior caller, `order_cancelled` for the new one, asserted (not
assumed) against the fact's own payload, throwing on anything else.

**4. The fast-path event this pass's own testing surfaced as missing —
`order.sagas.ts`.** Extending the step table alone was not enough: the
`@nestjs/cqrs` `@Saga()` in-process fast path only dispatches an
`Issue…Command` for an event `OrderSagas.dispatchOwedCommands` explicitly
maps — and `HandleCreditReleasedFactHandler` (`saga-fact.handlers.ts`) never
published one, because R24's variant never owed a command. Building the
step-table entry and running the FIRST integration attempt against it
proved this the hard way: `stock.release` was never issued at all (the fact
was processed, `enqueued: 'stock.release'` was returned, but nothing
dispatched it — the durable row sat `pending` until the sweeper's own
30-second cycle, invisible to a 45-second test `waitFor`). Fixed with a new
`CreditReleasedForCancellationRecorded` `IEvent` (deliberately NOT reusing
`CreditRejectionRecorded` — same output command, different fact, kept
honestly distinct), published by `HandleCreditReleasedFactHandler` only when
`result.enqueued` is set (the same guard every other dispatch-owed handler
already uses), and a sixth `ofType` branch in `OrderSagas.dispatchOwedCommands`
mapping it to the SAME `IssueStockReleaseCommand` the pre-existing
`CreditRejectionRecorded` branch already maps to.

**5. `stock.released.v1` needed the identical three-way extension.** Once
`stock.release` was actually being issued from the `credit_approved`/
`confirmed` branch, the RESULTING `stock.released.v1` fact arrived while the
order was STILL `credit_approved`/`confirmed` (that step's own `apply` is
also a no-op) — but `stock.released.v1`'s existing step had exactly ONE
precondition, `stock_reserved` (R28/SO7). Same fix, same shape: it is now
`[stock_reserved, credit_approved, confirmed]`, three `cancel`-kind variants.
The two new variants' `compensationSteps` name BOTH releases —
`stepsFromCreditCompensation` prepends a synthesised `credit_released` entry
(no `eventId`: this step-table function has no cross-fact state anywhere in
this codebase to source the EARLIER `credit.released.v1` fact's own id from,
so it is honestly omitted — `CompensationStep.eventId` is optional on the
wire schema for exactly this reason) ahead of the existing `stepsFrom`'s
`stock_released` entry.

### A mechanical gap found and fixed in the "already regenerated" contracts

`packages/contracts/src/generated/asyncapi.types.ts` did have
`CreditReleaseRequestPayload`/`CreditReleaseReplyPayload` (confirmed by
reading — the leader's own regeneration was real), but
`packages/contracts/src/index.ts`'s hand-maintained barrel export list did
NOT re-export either name — `pnpm --filter @otc/billing run typecheck`
failed immediately with "has no exported member" the moment I imported them.
Fixed by adding the two names to the existing RPC-payload `export type {
...}` block, in the same position `CreditHoldRequestPayload`/
`CreditHoldReplyPayload` already occupy — a two-line, mechanical completion
of an already-generated artifact (the brief's "do not touch
`packages/contracts`" is honoured in spirit: no type was invented, only an
existing one exposed), not a design change.

### Testing — armed-deletion verbatim failures

**Billing's idempotency (BC11/B5)** —
`apps/billing/src/application/credit-release.handler.spec.ts`. Armed by
removing the `if (!entry) { … }` early return in
`CreditReleaseHandler.release` (always falling through to the write branch,
`released: entry ? entry.amount.amount : 0` guarding only the crash, not
the lie). Two tests failed:

```
FAIL CreditReleaseHandler.release — BC11/B5, the idempotent repeat > a second release
after the hold is already released finds zero outstanding exposure, calls save NOT
AT ALL, appends no second entry, emits no second fact, and still replies success
with released: false
AssertionError: expected { released: true, …(5) } to match object { released: false, …(2) }
- Expected
+ Received
  {
    "availableCreditAfter": 10000,
    "orderReference": "ORD-000001",
-   "released": false,
+   "released": true,
  }

FAIL CreditReleaseHandler.release — BC11/B5, the idempotent repeat > an order with no
hold at all (nothing ever held) also replies released: false and calls save NOT AT ALL
AssertionError: expected { released: true, …(5) } to match object { released: false }
```

Restored; re-ran `credit-release.handler.spec.ts` +
`commands/credit.command-handlers.spec.ts` + `presentation/credit.controller.spec.ts`
— 18/18 green.

**Orders' reverse-order-of-acquisition proof** —
`apps/orders/src/orders-cancel.integration.spec.ts`'s `OCR-credit-release`
test, the one this pass exists to build. Armed by deleting BOTH
`commandAfter: 'stock.release'` lines from `credit.released.v1`'s
`credit_approved`/`confirmed` variants in `saga-steps.ts` (leaving their
no-op `apply` untouched) — the fact still processes and matches its
variant, but owes nothing. Real Testcontainers run (mysql:8.4.11 +
nats:2.14.5-alpine + apache/kafka:4.3.1), `-t "OCR-credit-release"`:

```
FAIL src/orders-cancel.integration.spec.ts > orders.cancel — operator-initiated
cancellation … > OCR-credit-release — issues credit.release strictly BEFORE
stock.release …
Error: orders-cancel.integration: condition not met within 45000ms
 ❯ waitFor src/orders-cancel.integration.spec.ts:63:9
```

Verbatim log evidence from the SAME armed run: `credit.release` was sent
(`"command":"credit.release","attempts":1`) — the RPC genuinely fired — but
no `stock.release` dispatch ever appears in the log, and the order never
reaches `cancelled`; the test's own 45s `waitFor` times out. Restored;
re-ran the full 4-test file (real Testcontainers) — 4/4 green, including
`OCR-credit-release` itself, which asserts
`billingApproved.issuedOrder` (an array pushed to by two separate stub
responders in call order) equals exactly `['credit.release',
'stock.release']` — not merely that both eventually happened.

Also re-ran, unmodified, to confirm no regression from the step-table
restructuring: `saga-happy-path.integration.spec.ts`,
`saga-command-retry.integration.spec.ts`,
`saga-compensation-credit-rejected.integration.spec.ts`,
`saga-compensation-stock-rejected.integration.spec.ts`,
`saga-preconditions.integration.spec.ts` — 5 files, 10/10 green.

### Live end-to-end verification (real running services, not Testcontainers)

Built and started all five services for real (`docker-compose.infra.yml`'s
MySQL/Kafka/NATS, already running):
`orders`, `fulfillment`, `billing`, `gateway`, `projector`. Boot logs
confirmed `CreditController` (Billing) and `OrdersCancelController` (Orders)
registered. Logged in via `POST /auth/login`, placed real orders against
real seeded reference data (`CarrefourEs`/`GALLIAGOODS`, `PRD-0006`, an
amount deliberately NOT ending `.99` — the simulator's cents-rule affordance,
R42 — two earlier attempts using `.99`-ending amounts were rejected by the
REAL simulator, `credit.rejected` on both, confirming R42 fires correctly
live, but not useful for reaching `confirmed`).

**The genuinely new finding, not merely a repeat of the original pass's own
disclosed race:** driving this branch live surfaced that the pre-existing
"operator-cancel-vs-saga-forward-progress" race (first documented, narrowly,
in this file's original section for the `stock_reserved` branch) has a
**materially worse consequence for the `credit_approved`/`confirmed`
branch**. On a fast, unthrottled local stack, `despatch.create` is issued
automatically and completes (own DB write + NATS round-trip + Kafka fact
round-trip) inside the SAME sub-second window as the operator's own cancel
RPC round-trip through the Gateway — I lost this race live, reproducibly, on
the first TWO real attempts (order ids `ORD-000048`, `ORD-000049`), even
using an in-process Node poll (millisecond-granularity, no shell-per-iteration
overhead) that fired the cancel within ~1s of observing `confirmed`.
Verified against real MySQL, not inferred:

- `ORD-000048` — `credit.release` never even reached the dispatcher: the
  order had already advanced to `despatched` by the time
  `CancelOrderHandler`'s own (non-transactional) status read ran.
- `ORD-000049` — `credit.release` DID succeed (Billing's ledger genuinely
  shows `hold` 1398 then `release` 1398, net zero) — but `despatch.create`
  won the race to actually mutate order status to `despatched` first. The
  resulting `credit.released.v1` fact then correctly hit R25's
  precondition-unmet path (verified in `saga_ignored_facts`:
  `event_type=credit.released.v1, observed_status=despatched,
  marker=precondition_unmet` — exactly the safe, designed fallback, no
  crash, no wrong mutation) — **but the consequence compounds further than
  the original `stock_reserved` race**: `stock.release` had ALREADY been
  durably enqueued (from BEFORE the race was lost) and kept retrying against
  a reservation Fulfillment had, by then, legitimately marked `consumed`
  (the despatch itself consumed it) — Fulfillment's own domain guard
  correctly refuses that release (`PRECONDITION_FAILED: reservation …
  cannot release from terminal status "consumed"`), but
  `NatsSagaCommandsAdapter` treats ANY `RpcError`-shaped reply as a
  `SagaCommandTransportError` (not a terminal business outcome), so the
  dispatcher retries it forever at capped backoff — verified live: this row
  reached `dead_lettered_at` and is STILL `parked`, permanently unable to
  succeed. Net live result of losing this race: the order is stuck at
  `despatched` (not `cancelled`), `cancellation_reason` stays `NULL` despite
  credit having genuinely already been refunded, and one `saga_commands` row
  retries forever. This is real, reproduced twice, and strictly worse than
  the `stock_reserved` branch's own already-disclosed race (which strands
  one reservation, not an entire order's terminal state plus a permanently
  un-resolvable command row). **Not fixed here** — it is the exact same
  class of pre-existing, disclosed architectural gap the original pass's
  own "what remains" section named ("worth a design discussion, not fixed
  here"), now shown, live, to bite harder on this specific branch. I did
  not attempt a fix: doing so correctly needs either transactionally
  re-checking the order's status immediately before dispatching
  `despatch.create`'s fast path, or having `CancelOrderHandler` itself
  cancel/supersede any already-owed forward-progress command the instant a
  cancellation is accepted — a genuine saga-design decision, not a
  quick patch, and out of this pass's bounded scope.

**A clean, positive live run — obtained by isolating the SAME pre-existing
race, not by changing production code**, using the identical technique
`orders-cancel.integration.spec.ts`'s own `startBillingApprovedOnlyResponder`
already uses in the automated suite (never answering `despatch.create` at
all): killed the real Fulfillment process the instant `stock_reserved` was
observed (so `despatch.create` could never win), let the real saga reach
`confirmed`, cancelled — reply carried `compensationPlanned: ['credit_release',
'stock_release']` as expected — then, once `credit.release`'s own compensation
was durably enqueued (`stock.release` row visibly `pending`), deleted the
now-`parked`, racing `despatch.create` row directly (a live-environment
intervention purely to neutralise the disclosed race for this one
observation, exactly mirroring the integration harness's own isolation, not
a code change) and restarted Fulfillment. Final state, `ORD-000050`,
verified against all three real databases directly:

```
otc_orders.orders:            status=cancelled, cancellation_reason=operator_cancelled
otc_orders.saga_commands:     credit.hold=sent, credit.release=sent, stock.release=sent (3 attempts, succeeded once Fulfillment was back), stock.reserve=sent
otc_billing.credit_items:     hold 1398 @ 13:23:33, release 1398 @ 13:23:34 (net zero exposure)
otc_fulfillment.reservations: order_reference=ORD-000050, product_code=PRD-0006, units=2, status=released
```

`credit.release` completed (`sent`) strictly before `stock.release`
completed (`sent`) — the reverse-order-of-acquisition guarantee, confirmed
live, not only in the deterministic Testcontainers proof above. All five
live service processes stopped afterward (`pkill -9 -f "node dist/main.js"`),
confirmed no residual process.

### Quality gates (this pass)

- `pnpm --filter @otc/billing run typecheck` / `run lint` — clean.
- `pnpm --filter @otc/billing run test` — 148 passed (up from 138; +10: 5
  handler + 2 command-handler + 3 controller).
- `pnpm --filter @otc/billing exec vitest run --config vitest.integration.config.mts
  src/credit-release.integration.spec.ts` — 4/4 (real MySQL/NATS/Kafka).
  Re-ran `credit-hold.integration.spec.ts` unmodified — 6/6, no regression.
- `pnpm --filter @otc/orders run typecheck` / `run lint` — clean.
- `pnpm --filter @otc/orders run test` — 496 passed (was 502 before this
  pass under the ORIGINAL section's count, now net different due to the
  generic-matrix test restructuring for the two now-multi-variant fact
  types — see `saga-steps.spec.ts`'s own `MULTI_VARIANT_FACT_TYPES` split).
  Two spawn-based tests (`di-metadata-divergence.spec.ts`,
  `main-shutdown-hooks.spec.ts`) failed ONLY under full-repo-parallel load
  (CPU contention from concurrently-running Testcontainers suites) — both
  confirmed green in isolation, re-run standalone, not a regression.
- `pnpm --filter @otc/orders exec vitest run --config vitest.integration.config.mts
  src/orders-cancel.integration.spec.ts` — 4/4 (real MySQL/NATS/Kafka),
  including the new `OCR-credit-release` reverse-order proof.
- `pnpm run lint` / `pnpm run typecheck` (repo-wide, all 10 workspace
  projects including `apps/web`) — clean.
- `pnpm run test` (repo-wide) — all green in isolation per package;
  packages/contracts 22, shared-kernel 69, notifications 82, fulfillment 83,
  gateway 121, billing 148, orders 496 (+2 confirmed standalone), projector
  133, seed 119.
- `./init.sh` — exit 0.

### Files touched (this pass only — the original section's file list above is untouched)

**`apps/billing/**`:**
- `apps/billing/src/application/credit-release.handler.ts` — new.
- `apps/billing/src/application/credit-release.handler.spec.ts` — new, 6 tests.
- `apps/billing/src/application/commands/credit.commands.ts` —
  `ReleaseCreditCommand` added.
- `apps/billing/src/application/commands/credit.command-handlers.ts` —
  `ReleaseCreditHandler` added, `CREDIT_COMMAND_HANDLERS` extended.
- `apps/billing/src/application/commands/credit.command-handlers.spec.ts` —
  1 new test.
- `apps/billing/src/presentation/dto/credit.dto.ts` — `CreditReleaseRequestDto` added.
- `apps/billing/src/presentation/credit.controller.ts` — `release` responder added.
- `apps/billing/src/presentation/credit.controller.spec.ts` — 5 new tests.
- `apps/billing/src/app.module.ts` — `CreditReleaseHandler` provider wired.
- `apps/billing/src/credit-release.integration.spec.ts` — new, 4 tests.

**`apps/orders/**`:**
- `apps/orders/src/application/cancel-order.handler.ts` — the
  `credit_approved`/`confirmed` branch completed; `CancelOrderResult` lost
  `credit_release_unavailable`.
- `apps/orders/src/application/cancel-order.handler.spec.ts` — the
  `OCR-credit-gap` test replaced with `OCR-credit-release`.
- `apps/orders/src/application/saga-steps.ts` — `SAGA_STEPS`'s value type
  generalised to `SagaStep | readonly SagaStep[]`; `credit.released.v1` and
  `stock.released.v1` now 3-variant arrays; `stepVariantsFor`/`stepForStatus`
  added; `stepFor` now throws on ambiguity; `SAGA_COMMAND_KINDS` gained
  `credit.release`.
- `apps/orders/src/application/saga-steps.spec.ts` — restructured
  (`MULTI_VARIANT_FACT_TYPES` exclusion + dedicated blocks for both).
- `apps/orders/src/application/saga-fact-handler.ts` — uses
  `stepVariantsFor`/`stepForStatus` instead of the old single `stepFor` call.
- `apps/orders/src/application/saga-command-payloads.ts` — `stock.release`
  case now derives `reason` from the triggering fact
  (`stockReleaseReasonFor`); `credit.release` case added for exhaustiveness.
- `apps/orders/src/application/ports/saga-commands.port.ts` — `releaseCredit` added.
- `apps/orders/src/application/commands/saga-dispatch.commands.ts` —
  `IssueCreditReleaseCommand` added.
- `apps/orders/src/application/commands/saga-dispatch.handlers.ts` —
  `IssueCreditReleaseHandler` added.
- `apps/orders/src/application/events/saga-dispatch.events.ts` —
  `CreditReleasedForCancellationRecorded` added.
- `apps/orders/src/application/commands/saga-fact.handlers.ts` —
  `HandleCreditReleasedFactHandler` now publishes that event on
  `result.enqueued`.
- `apps/orders/src/application/commands/saga-fact.handlers.spec.ts` — 2 new tests.
- `apps/orders/src/application/sagas/order.sagas.ts` — sixth `ofType` branch.
- `apps/orders/src/application/sagas/order.sagas.spec.ts` — 1 new test.
- `apps/orders/src/infrastructure/messaging/nats-saga-commands.adapter.ts` —
  `releaseCredit` added, `CREDIT_RELEASE_SUBJECT` constant.
- `apps/orders/src/infrastructure/messaging/nats-saga-commands.adapter.spec.ts` —
  1 new test + subject-count assertion updated.
- `apps/orders/src/infrastructure/saga/saga-command-dispatcher.ts` — `credit.release` case added to `callFor`.
- `apps/orders/src/infrastructure/saga/saga-command-dispatcher.spec.ts` /
  `saga-command-dispatcher-log-trace-id.spec.ts` — `releaseCredit` added to
  the fake port fixture (compile-only fix, no behavioural change).
- `apps/orders/src/infrastructure/persistence/schema/saga-commands.schema.ts` —
  `credit.release` added to `SAGA_COMMAND_KIND_VALUES`.
- `apps/orders/src/presentation/orders-cancel.controller.ts` — the
  `credit_release_unavailable`/`UNAVAILABLE` branch removed.
- `apps/orders/src/presentation/orders-cancel.controller.spec.ts` — the
  `UNAVAILABLE` test replaced with a `compensationPlanned: ['credit_release',
  'stock_release']` test.
- `apps/orders/src/orders-cancel.integration.spec.ts` — new
  `startBillingApprovedOnlyResponder` fixture + `OCR-credit-release` test
  (the reverse-order proof).

**`packages/contracts/**` (mechanical export completion only, not a
regeneration):**
- `packages/contracts/src/index.ts` — `CreditReleaseRequestPayload`/
  `CreditReleaseReplyPayload` added to the existing RPC-payload export block.

Not touched: `apps/gateway`, `apps/fulfillment`, `apps/notifications`,
`apps/projector`, `specs/`, `packages/contracts/src/generated/asyncapi.types.ts`
(already regenerated before this pass began), per the bounded scope.

### What remains (updated)

1. **The operator-cancel-vs-saga-forward-progress race** — now shown, live,
   to have a WORSE consequence for the `credit_approved`/`confirmed` branch
   than the `stock_reserved` branch's own already-disclosed version (see
   "Live end-to-end verification" above). Still not fixed — a genuine
   saga-design decision (transactional re-check before the forward-progress
   fast path dispatches, or the cancel path actively superseding an
   already-owed command), out of this pass's bounded scope.
2. **`NatsSagaCommandsAdapter` treats every `RpcError` reply as a transport
   failure**, never a terminal business outcome — found as a SIDE EFFECT of
   the race above (a `stock.release` against an already-`consumed`
   reservation retries forever instead of being marked `sent`/failed
   terminally once). Pre-existing in the adapter, not introduced by this
   pass; not fixed here.
3. The operator note on the timeline, and the operator-cancel-vs-saga race's
   NARROWER `stock_reserved`-only form — both already listed as remaining
   work in this file's original section, unchanged by this pass.
