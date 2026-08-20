# Spec pass — `orders_aggregate` (feature 13, phase 8)

**Agent:** `spec_author`
**Date:** 2026-08-20
**Feature:** `orders_aggregate` — "Order aggregate + full status state machine", `"sdd": true`
**Status set:** `pending` → `spec_ready` (the human approval gate is next; nothing was implemented and nothing was committed)

---

## 1. Files written

| File | Purpose |
|---|---|
| `specs/orders_aggregate/requirements.md` | Cites the shared range `R1`–`R10`; adds five feature-local requirements `OA1`–`OA5` and their local traceability table |
| `specs/orders_aggregate/design.md` | The stack-specific design: file layout in the four layers, the `Order` aggregate (two construction paths, nine command methods), Table T-1 as data, the four facts, the ten domain errors, the repository port, the persistence-mapping notes for feature 15, the test plan |
| `specs/orders_aggregate/tasks.md` | 33 ordered tasks in nine groups (A wiring → I closing), tests inline with the behaviour they prove |
| `progress/spec_orders_aggregate.md` | This record |
| `feature_list.json` | `orders_aggregate.status`: `pending` → `spec_ready` (only field changed) |

No file under `apps/`, `packages/` or `specs/shared/` was modified. No test was written. No commit.

## 2. Sources read

`.claude/agents/spec_author.md`, `CLAUDE.md`, `feature_list.json` (id 13 acceptance), `specs/shared/domain-model.md` (§2 value objects, §3 the Orders context and Table T-1, §7 the envelope and the thirteen facts, §8 cross-cutting rules), `specs/shared/requirements.md` (§1 `R1`–`R10`, §9 coverage notes), `specs/shared/saga.md` (§2–§4, §6), `specs/shared/test-matrix.md` (§1), `packages/shared-kernel/src/**` (all eight value objects/bases and their public signatures), `packages/contracts/src/index.ts` and the generated AsyncAPI types (`OrderPlacedPayload`, `OrderConfirmedPayload`, `OrderCompletedPayload`, `OrderCancelledPayload`, `OrderStatus`, `CancellationReason`, `CompensationStep`), `apps/orders/src/infrastructure/persistence/schema/*` (all eight tables), `apps/orders/{package.json,tsconfig.json,vitest.config.mts}`, `eslint.config.mjs` (the domain-purity rule), root `package.json`.

## 3. Open points — what the sources left undecided, and what this spec decided

This is the table the approval gate reads. Every row is a question the source documents did **not** answer for this stack; the resolution is the position the spec adopts, and the last column says where it is written down so it is auditable later.

| # | Open point | Resolution adopted | Recorded in |
|---|---|---|---|
| 1 | Invariant **O8** says every successful transition appends exactly one domain event, but Table T-1 leaves the "Fact emitted by Orders" cell **empty** for five edges. Emit an internal event, or none? | **T-1 governs.** Exactly one event when T-1 names a fact (4 edges), none otherwise (5 edges). No fourteenth fact type is invented; the timeline stays complete because the projector consumes the foreign facts that drive those edges. | `requirements.md` **OA2**; `design.md` §6 |
| 2 | **O3**/R6 both say "plus any order-level discount", but the `Order` field table, the `orders` table and `OrderPlacedPayload` all lack such a field. | **No order-level discount in #7.** `initialDiscount = Σ lineDiscount`; the term survives as a named `Money.zero(currency)` in `computeOrderTotals` so a future addition has an obvious home. | `design.md` §4.3 |
| 3 | `OrderLine.description` is a required snapshot in `domain-model.md` §3.1 and appears in the fact payload, but `order_items` has **no `description` column**. | The aggregate carries it. The column is added **by migration in feature 15** (the feature that first persists an order); joining `products` at load time is explicitly rejected because it silently un-snapshots a historical order. | `design.md` §9; **superseded by §7 amendment 1 — the migration lands in this feature, not 15** |
| 4 | The aggregate speaks `retailerCode`/`companyCode`/`currency`/`productCode`; the write model stores `retailer_id`/`company_id`/`currency_id`/`product_id` foreign keys. | Code ↔ id resolution is **adapter-internal**. The port and `OrderSnapshot` speak value objects and business codes only; the domain never sees a reference-table id. | `design.md` §4.2, §9 |
| 5 | Does the Drizzle repository **adapter** land in this feature or later? | **Port interface here, adapter in feature 15.** Reasons: `save` cannot be written honestly before the outbox (14); the mapping needs the missing `description` column; and this feature's acceptance is "pure domain unit tests, zero framework imports". Accepted cost: the port gains a transactional-context parameter in feature 14 — expected, not drift. | `design.md` §8 (with the trade-off written out) |
| 6 | `domain-model.md` §8 mandates a **clock port**, but `packages/shared-kernel` has no `Clock` and none of the three services defines one. | The aggregate takes `TransitionContext { occurredAt, causationId }` **as an argument**; every method stays a pure function of `(state, input)`. The clock port lives in the application layer (features 15/16). **`shared-kernel` is not extended** by this feature. | `design.md` §4.6 (alternative and trade-off recorded) |
| 7 | `OrderStatus` and `CancellationReason` exist in `@otc/contracts` (generated). Should the domain import them or own them? | **The domain owns them** — as the existing comment in `orders.schema.ts` already mandates. Drift is caught by two parity tests: domain ↔ contracts (domain layer) and domain ↔ Drizzle schema (infrastructure layer, because a domain test may not import infrastructure). | `design.md` §3; `tasks.md` B3, B4 |
| 8 | May two lines of one order carry the same `productCode`? The shared spec is silent. | **Permitted; no new invariant.** Adding a restriction here would make #7 behave differently from #8/#9, which read only `specs/shared/`. Trilogy consistency outranks the small tidiness gain. | this table; `design.md` §4.4 (no such guard) |
| 9 | May an order be cancelled with `stock_rejected` from `stock_reserved` (or `credit_rejected` from `placed`)? R10 only constrains the reason to a closed set. | **Enforced pairing**: `stock_rejected` only from `placed`, `credit_rejected` only from `stock_reserved`, `operator_cancelled` from all four. This is a faithful reading of the T-1 "Trigger" cells, not a new rule — hence a **promotion candidate** for the shared spec at feature 38. | `requirements.md` **OA4**; `design.md` §4.5 |
| 10 | `OrderCancelledPayload.compensationSteps[]` — the aggregate never observes `stock.released.v1`, so it cannot know them. | `cancel(reason, ctx, compensationSteps = [])` takes them **from the caller**; the orchestrator (feature 16) passes what it observed. `[]` is correct for `stock_rejected` (nothing was ever acquired, R26). | `design.md` §4.5 |
| 11 | Invariant **O2** (single currency across lines and totals) has **no shared `R<n>`** — the §9 invariant map skips O2 and O8. | Local requirement **OA1**: the aggregate rejects at its own boundary with `ORDER_LINE_CURRENCY_MISMATCH` rather than letting the kernel's `CurrencyMismatchError` escape. | `requirements.md` **OA1**; `design.md` §7 |
| 12 | Reconstitution from persistence is not mentioned anywhere in the shared spec: may it re-emit events? Must it trust stored totals? | **OA3**: `reconstitute` emits nothing, and `OrderSnapshot` carries **no totals fields at all**, so a stored/derived mismatch is unrepresentable rather than merely detected. It also validates status membership and the "reason iff cancelled" rule. | `requirements.md` **OA3**; `design.md` §4.2 |
| 13 | No saga flow and no Gateway endpoint mutates order lines (ORDCHG is out of the model), yet R5/R6/R7 are entirely about line mutation. | Implement the minimal three mutators (`addLine`, `removeLine`, `changeLineQuantity`) because they are what makes those requirements testable, and expose none of them beyond the domain. | `design.md` §4.4 |
| 14 | `apps/orders/package.json` declares **neither** `@otc/shared-kernel` **nor** `@otc/contracts`, and both resolve through a git-ignored `dist/`, so `pnpm quality` on a clean clone would fail before `pnpm build`. | Add both as `workspace:*` in this feature (task A1) and build before typechecking (task A2). **Do not** change the root `quality` script here — making it build-first is proposed for feature 34 (`sonarqube_quality_gates`). | `tasks.md` A1, A2; `design.md` §2. **Widened by §7 amendment 2 — all three service apps, proved from a clean state** |
| 15 | How far can "invalid states unrepresentable" be pushed in TypeScript — should the state machine be typestate (a class per status)? | **Rejected**, with the reason written down: `reconstitute` returns a runtime-determined status, so a nine-way union would need narrowing at exactly the call sites that carry the risk. Instead: closed unions + value objects make invalid *values* unrepresentable, and the one runtime check (edge legality) is proved exhaustively over the 9 × 9 product (11 legal, 70 rejected). | `design.md` §5 |
| 16 | Traceability policy for the local ids: `specs/shared/test-matrix.md` is frozen at 61 contiguous rows and reused verbatim by #8/#9. Where do `OA<n>` rows go? | Local ids use the non-colliding `OA` prefix and are traced in `specs/orders_aggregate/requirements.md` §3. The **shared** matrix is touched only to flip `R5`–`R10` to `DONE`. Promotion of any `OA` to a shared `R` is a feature-38 decision. | `requirements.md` §2, §3; `tasks.md` I1, I2 |

## 4. Requirement coverage

| Range | Count | Where traced |
|---|---:|---|
| Shared `R1` – `R10` (`orders_aggregate`) | 10 | `specs/shared/test-matrix.md` §1 — `R1`–`R4` already `DONE` in `shared-kernel`; `R5`–`R10` flip to `DONE` in task I1 |
| Local `OA1` – `OA5` | 5 | `specs/orders_aggregate/requirements.md` §3 — all `TODO` |

Every one of the five acceptance bullets in `feature_list.json` maps to at least one requirement (`requirements.md` §4); no bullet is unowned and no requirement is orphaned.

## 5. `specs/shared/` hygiene

`specs/shared/` was **read only**. Re-checked that the stack-specific vocabulary this pass reasoned about — `nest`, `drizzle`, `nuxt`, `mysql`, `typescript`, `vitest` — appears nowhere in it: everything of that kind produced by this pass landed in `specs/orders_aggregate/design.md`, which is where #8 and #9 will write their own, different answers to the same `R1`–`R10`.

## 6. Next step

**Human approval gate.** `orders_aggregate` is `spec_ready`. It must not move to `in_progress` until a human has read this table and approved. The implementer then works `tasks.md` top to bottom and finishes at `in_review`.

---

## 7. Post-gate amendments (accepted 2026-08-20)

The human approval gate accepted the spec above **with two amendments and one addition**. The sixteen rows of §3 stand as written except where a row is explicitly revised below; `orders_aggregate` remains `spec_ready` (the leader flips it to `in_progress`). Nothing under `apps/`, `packages/` or `specs/shared/` was modified by this pass, no test was written and nothing was committed.

| # | Amendment (from the gate) | Revises | Where it landed |
|---|---|---|---|
| 1 | The `order_items.description` migration is **pulled into this feature** instead of being deferred to feature 15, so the schema stops contradicting the domain model and the `order.placed.v1` payload as of feature 13 | open point **3** | `design.md` §9 row + new §9.1, §2 file layout, §8 (reason (b) withdrawn), §10 note; `tasks.md` new group **J** (J1–J5) |
| 2 | The missing `workspace:*` dependency declarations are fixed in **all three** service apps (`orders`, `billing`, `fulfillment`), not `orders` alone, and the fix is proved from a genuinely clean state rather than a warm workspace | open point **14** | `tasks.md` A1 (widened), A2, new **A3**; `design.md` §2 "Workspace wiring" |
| 3 | `OA4` (reason ↔ status pairing) and `OA1` (single-currency invariant at the aggregate boundary) are accepted **on condition** they are explicitly flagged for promotion into `specs/shared/` at feature 38, since #8 and #9 read only the shared spec and would otherwise not enforce them | open points **9** and **11** | `requirements.md` new §5 "Promotion candidates for `specs/shared/`" |

### Detail worth carrying forward

**Amendment 1.** Verified against the repository, not assumed: `apps/orders/drizzle/0000_bizarre_champions.sql` gives `description varchar(255) NOT NULL` to `products` only, and `order_items` has exactly `id`, `order_id`, `product_id`, `price`, `quantity`, `discount`, `created_at`, `updated_at`. The column is specified as `varchar(255) NOT NULL` — `Text` in `domain-model.md` §3.1 is the model's *logical* string type (the same notation labels `productCode`, already mapped to `varchar(30)`), the sibling snapshot source `products.description` is `varchar(255)`, and `asyncapi.yaml` puts no `maxLength` on `OrderLine.description`; `NOT NULL` because the field is required on the domain entity. The rejection of the join-`products`-at-read-time alternative is **preserved verbatim in substance** in §9.1: joining would let a later catalogue edit rewrite a historical order's description, so the reconstituted aggregate would stop matching the fact published from it. Two collateral breakages were located and turned into tasks rather than left for the implementer to trip over: the Testcontainers round-trip in `apps/orders/src/infrastructure/persistence/migrations.integration.spec.ts` (J3) and the `apps/seed` writer plus its `OrderLineFixture` (J4, which reuses the value `orderPlacedLines(...)` already publishes, so row and fact agree by construction). A backfill note is included because a `NOT NULL` column with no default cannot be added over existing rows in strict `sql_mode`.

**Amendment 2.** Verified: only `apps/seed` declares `@otc/shared-kernel` and `@otc/contracts` today, because it is the only app that imports them so far — the omission is latent and identical in `orders`, `billing` and `fulfillment`. A3 requires `rm -rf node_modules …` → `pnpm install` → `pnpm build` → `pnpm quality`, because a warm workspace resolves those packages from the root hoist even when a package never declares them, which is precisely how the defect stayed invisible. The position of open point 14 is unchanged in one respect: the root `quality` script is **not** made build-first here; that remains proposed for feature 34.

**Amendment 3.** `OA2`, `OA3` and `OA5` are recorded as **not** promotion candidates, with the reason, so feature 38 does not have to re-derive the judgement.

**Task count.** `tasks.md` grew from 38 to **44** tasks (§1 above says "33"; that was a miscount in the original record — the pre-amendment file held 38): +1 in group A (A3) and +5 in the new group J. Group J is lettered out of sequence on purpose and runs between H and I, so every task id the gate read keeps its meaning.

## 8. Next step (unchanged)

The gate has been passed. The leader may set `orders_aggregate` to `in_progress` and launch the implementer, which works `tasks.md` in the order A → H → J → I and finishes at `in_review`.
