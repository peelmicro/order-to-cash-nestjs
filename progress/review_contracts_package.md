# review_contracts_package

**Feature:** `contracts_package` (id 8, phase 5) — reviewed 2026-08-19/20
**Verdict: APPROVED** (first pass)

`sdd: false` — no `specs/contracts_package/` triple-doc required; reviewed
against the acceptance criteria ("pnpm contracts:generate reproduces the
types", "no hand-written API types anywhere else") and directly against
`specs/shared/asyncapi.yaml` / `specs/shared/openapi.yaml`, the same posture
as `messaging_topology`.

---

## Faithfulness spot-check (spec field → generated type), all verified by eye

The implementer applied two hand-rolled transforms (`$ref` rewrite to
`#/definitions/`, `title` stripping on 3 of 95 schemas). Both were audited
field-by-field on a hostile sample.

| Spec schema / field | Spec says | Generated (`asyncapi.types.ts`) | Match |
|---|---|---|---|
| `Envelope` — all 7 fields | `eventId/eventType/aggregateId/correlationId/causationId/occurredAt/payload`, **all required**, `eventType` pattern documented | all 7 present, none optional, exact names, doc comments carried | ✅ |
| `OrderPlacedPayload` | 12 props, `notes` the only optional; `lines` minItems 1 | `notes?` only; `lines: [OrderLine, ...OrderLine[]]` (non-empty tuple) | ✅ |
| `StockRejectedPayload` | `retailerCode` NOT in `required`; `reason` enum `insufficient_stock\|unknown_product` | `retailerCode?`; exact 2-value union | ✅ |
| `PaymentReceivedPayload` | 7 props all required; `amount` = MinorUnits; `source` = PaymentSource | all required; `amount: number` (see note 1); `source: PaymentSource` | ✅ |
| `PaymentReceivedEvent` | `allOf [Envelope, {eventType: const, payload}]`, no `required` on 2nd branch | `Envelope & { eventType?: 'payment.received.v1'; payload?: ... }` — intersection resolves to required narrowed members; optionality of the 2nd branch is exactly what the schema says | ✅ |
| `OrdersCreateRequestPayload` | line items require only `productCode, quantity`; `unitPrice`/`lineDiscount`/`requestId`/`orderDiscount`/`notes` optional | matches exactly, incl. non-empty tuple for `lines` | ✅ |
| `OrdersCreateReplyPayload` | required `orderId, orderReference, status(const placed), currency, totalAmount, orderDate`; `initialAmount`/`initialDiscount` optional | matches exactly; `status: 'placed'` literal | ✅ |
| DLQ (`DeadLetterRecord` message) | payload = `Envelope` (unmodified original), headers = `DeadLetterHeaders`; only `x-failed-consumer, x-attempts, x-error` required | both schemas compiled + exported; required/optional split exact, incl. `x-original-topic?`, `x-first-failed-at?`, `x-failed-at?`, `traceparent?`, `x-event-type?` | ✅ |
| `MinorUnits` | `type: integer, format: int64` | `type MinorUnits = number` + full "never a float" doc comment (TS has no integer type; **zero** `format: float` anywhere in either spec — the only "float" hits are prose saying *never* float) | ✅ |
| `Money` | `{amount: MinorUnits, currency: CurrencyCode}` both required | identical | ✅ |
| `OrderStatus` | 9 values `placed…cancelled` | exact 9-value union, exact strings | ✅ |
| `ReservationStatus` | `reserved\|released\|consumed` | exact | ✅ |
| `PaymentSource` | `operator\|robot\|test` | exact | ✅ |

### Title-stripping transform — shape audit of all three affected schemas

- `Envelope` (`title: Fact envelope`) — shape identical to spec (table above).
- `RpcError` (`title: RPC error reply`) — 12-value `code` enum exact, `message`
  required, `details?`/`correlationId?`/`occurredAt?` optional, exactly per
  spec `required: [code, message]`. ✅
- `RpcTimeout` (`title: RPC timeout — the absence of a reply`) — `code:
  'TIMEOUT'` const, `subject`/`attempt` required, `maxAttempts?`/`deadlineMs?`/
  `orderReference?` optional, exactly per spec `required: [code, subject,
  attempt]`. ✅

The transform affects **naming only** (keeps the `components.schemas` key as
the exported name); shape untouched, `description` doc comments preserved.

### Completeness

`components.schemas` count in `asyncapi.yaml`: **95** (verified with a YAML
parse). `grep -c '^export '` on `asyncapi.types.ts`: **95**. 1:1, guarded by
the regression test in `scripts/lib/generate-asyncapi.spec.ts` (which also
checks `exportedNames.size === schemaKeys.length` — no extras, no root-wrapper
leak). All 43 `components.messages` resolve to these 95 schemas.

---

## Probe results (all executed by the reviewer, real output)

1. **Determinism** — `pnpm contracts:generate` run twice; md5 of both
   generated files identical before/after each run
   (`348f2afb…` / `e490b9e9…`); `git status` on `src/generated` unchanged. ✅
2. **Drift check** — appended a probe line to `asyncapi.types.ts`;
   `pnpm contracts:check` exited **1**, named the file, printed a unified
   diff. `pnpm contracts:generate` restored it byte-identically (md5 back to
   baseline); check exits **0** again. ✅
3. **Spec→types linkage** — copied `asyncapi.yaml` to the scratchpad, renamed
   `CreditApprovedPayload.heldAmount` → `heldAmountCents` in the **copy only**,
   ran `generateAsyncApiTypes` against both: diff shows
   `- heldAmount: MinorUnits` / `+ heldAmountCents?: MinorUnits` (optional in
   the mutant because `required` still names `heldAmount` — the generator
   reports exactly what the document says). Afterwards: `git status` on both
   real specs empty, generated files at baseline md5, scratch files deleted. ✅
4. **`pnpm quality`** — exit 0; `packages/contracts` 5 files / **22 tests**
   passed, `shared-kernel` 68 passed, all apps green. ✅
5. **`pnpm -r build`** — exit 0. **`./init.sh`** — exit 0. ✅
6. **"No hand-written API types anywhere else"** — grepped all six apps + web
   for `interface`/`type` declarations: only the scaffold-era `HealthPayload`
   stub (`{service: string; status: 'ok'}`) on each app's root route. It is
   **not** a contract shape — the spec's `HealthResponse` is
   `{status: 'up'|'down', checks}` on `/health/live|ready`. No duplication of
   any Envelope/fact/RPC/REST schema anywhere. ✅
7. **Package hygiene** — all four generators/tools are `devDependencies` of
   `@otc/contracts` (consumers get `dist/` types only); `src/generated`
   ignored in `eslint.config.mjs` (line 40) and `.prettierignore` (line 10);
   DO-NOT-EDIT banner (no timestamp, no absolute path) present on both files;
   barrel documents that deep imports are not public surface. No Jest anywhere;
   `packages/shared-kernel` still has zero runtime dependencies. ✅
8. **Tests are real** — read all five spec files. The completeness regression
   test parses the YAML itself and cross-checks export names (independent
   oracle); `generate.spec.ts` re-asserts the drift check inside `pnpm test`;
   `check.spec.ts` exercises pass, corrupted-copy and missing-file paths plus
   the real CLI exit codes; `index.spec.ts` type-checks representative
   literals (the real assertion is compilation). No vacuous assertions found. ✅

## Observations (non-blocking, for the record)

1. `PaymentReceivedPayload.amount` and the inline `unitPrice` in
   `OrdersCreateRequestPayload` render as `number` with the `MinorUnits` doc
   comment inlined, rather than the `MinorUnits` alias — a
   `json-schema-to-typescript` behaviour when `$ref` carries a sibling
   `description` (the sibling description itself is dropped in favour of the
   target's). Shape-identical, doc-comment nuance only.
2. `Envelope.payload` compiles to `{}` (spec: `type: object`, no properties) —
   structurally faithful; each concrete `*Event` narrows it via intersection.
3. When the gateway implements `/health/live|ready` (feature 25), it must use
   `GatewayComponents['schemas']['HealthResponse']` and retire the scaffold
   `HealthPayload` stubs.
4. The barrel deliberately aliases only 10 of ~60 OpenAPI schemas
   (`GatewayComponents['schemas']` reaches the rest) — acceptable; revisit at
   `gateway_rest_auth` if ergonomics demand more aliases.

## CHECKPOINTS walked

### C1 — harness complete
- [x] AGENTS.md, CLAUDE.md, CHECKPOINTS.md, feature_list.json, init.sh exist
- [x] progress/current.md and progress/history.md exist
- [x] .claude/agents/ holds all five agents
- [x] every agent definition declares its model
- [x] ./init.sh exits 0 (run by reviewer)

### C2 — state coherent
- [x] at most one feature in_progress (after this close: none)
- [x] every status in rules.valid_status
- [x] every done feature has passing tests (22/22 here; 68 shared-kernel; all green in pnpm quality)
- [x] progress/current.md describes the active session
- [x] no blocked features

### C3 — architecture respected
- [x] no framework imports in any domain/ folder (ESLint rule active; pnpm quality green)
- [x] no cross-service DB access (no DB code exists yet; contracts carries business identifiers — `companyCode`/`retailerCode`/`orderReference` — never FKs)
- [x] no shared runtime code beyond shared-kernel and contracts
- [x] shared-kernel still has zero runtime dependencies (no `dependencies` key)
- [x] Kafka-fact vs NATS-RPC split preserved in the generated types (13 fact Events envelope-composed; 14 RPC request/reply pairs + RpcError/RpcTimeout distinct)
- [x] no stray debug logging, no context-free TODOs

### C4 — verification real
- [x] pnpm quality passes (exit 0, reviewer-run)
- [x] domain tests pure (n/a to this package; generator tests import only node:, js-yaml, vitest and the code under test)
- [x] integration via Testcontainers — n/a, no broker/DB in this feature
- [x] coverage: 91.6% st / 87.5% br on hand-written glue, gate ≥80% met; generated code excluded per task instruction
- [x] no Jest anywhere

### C5 — session closed cleanly
- [x] no suspicious untracked files (coverage/ and dist/ are gitignored build output; scratch probe files deleted)
- [x] history.md entry with effort record appended
- [x] feature_list.json reflects true state (contracts_package → done)
- [x] human told what was done and how to test manually (see below)
- [x] reviewer did not commit

### C6 — n/a (`sdd: false`; no sdd feature started yet)

## How to test manually

```bash
pnpm contracts:check                       # exit 0
pnpm contracts:generate && git diff --stat # empty — deterministic
echo '// drift' >> packages/contracts/src/generated/asyncapi.types.ts
pnpm contracts:check                       # exit 1, names the file, shows diff
pnpm contracts:generate && pnpm contracts:check   # green again
pnpm --filter @otc/contracts test          # 22/22
pnpm quality && ./init.sh                  # all green
```
