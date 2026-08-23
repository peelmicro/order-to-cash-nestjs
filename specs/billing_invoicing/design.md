# `billing_invoicing` — Design (NestJS / TypeScript, assessment #7)

> **Stack-specific.** This file is where the NestJS, `@nestjs/cqrs`, `@nestjs/microservices` NATS, Drizzle, MySQL, kafkajs and Testcontainers detail lives. Nothing here belongs in `specs/shared/`; assessments #8 and #9 write their own equivalent against the same `R45` and `R46`.
>
> Authorities: [`specs/shared/domain-model.md`](../shared/domain-model.md) §5.2 – §5.3 (`Invoice`, `InvoiceLine`, `Payment`, **B6** – **B10**), §5.1 (the `consume` entry), §7.1 – §7.2 (the envelope and fact 10), §8 (cross-cutting rules); [`specs/shared/saga.md`](../shared/saga.md) §2, §3.1 steps 4 – 5, §5, §6; [`specs/shared/asyncapi.yaml`](../shared/asyncapi.yaml) (`invoiceIssue`/`invoiceIssueReply`/`invoiceList`/`invoiceListReply` channels, `InvoiceIssueRequestPayload`/`InvoiceIssueReplyPayload`/`InvoiceListRequestPayload`/`InvoiceView`, `InvoiceIssuedPayload`); [`specs/outbox_and_idempotency/design.md`](../outbox_and_idempotency/design.md) §4 – §6; **and above all [`specs/billing_credit/design.md`](../billing_credit/design.md), which is this service's shape.** Invoicing *extends* the Billing service built by feature 19 — the same responder skeleton, the same bare-JSON wire, the same `UnitOfWork`, the same repository-drains-aggregate discipline, the same `rpc-error-mapper` vocabulary. Nothing about that shape is re-invented here; every section below says either "copy of feature 19's" or "new, and why".
>
> Inherited work resolved here: `review_billing_credit_simulator.md` **N1**, **N2**, **N3**, **N5** → §11; **N6** (a `specs/shared/test-matrix.md` sketch-column path) is already applied by this spec pass, §11.5.

## 1. Scope

**In scope.**

- The `Invoice` aggregate root, the `InvoiceLine` child entity, invariants **B6** – **B9**, the `invoice.issued.v1` and `payment.received.v1` fact builders, and `markPaid` (delivered, uncalled — feature 22's seam).
- Two NATS responders: `billing.invoice.issue` (`R45`) and `billing.invoice.list` (the read side).
- The `consume` ledger call that gives `R40` its first live caller, inside the invoice-issue transaction.
- The `INV-######` allocator: a port, a Drizzle counter-table adapter, and the migration that adds the counter table and the `orderReference` uniqueness that makes **B7** mechanical.
- The four inherited findings **N1**, **N2**, **N3**, **N5**.

**Out of scope.** The remittance intake — `billing.payment.register`, the `Payment` entity, the `payments` table, dedup by `paymentReference`, the `release` ledger call, `credit.released.v1` on payment (feature 22, `R47` – `R49`); the Gateway's callers of `billing.invoice.list` and the "Register payment" button (features 25 and 29); DLQ, retry policy, metrics, tracing, Terminus (feature 27); credit notes, dunning, partial payment and partial invoicing (out of the model, `domain-model.md` §9).

## 2. Where everything lives

```
apps/billing/src/
  domain/
    invoice.ts                       Invoice aggregate root (§3.1): issue / markPaid / reconstitute / toSnapshot, B6-B9
    invoice-line.ts                  InvoiceLine child entity (§3.2) — maps to the `invoice_items` table (§3.6)
    invoice-snapshot.ts              the plain snapshot shape the mapper reconstitutes from (mirrors buyer-credit-snapshot.ts)
    invoice-events.ts                invoiceIssuedEvent / paymentReceivedEvent builders (§3.4)
    invoice-errors.ts                DomainError subclasses with stable codes (§3.5)
    index.ts                         barrel — extended, not replaced
    invoice.spec.ts                  pure unit tests — BI10, BI11, BI14, shared R45/R46 domain halves
    invoice-events.spec.ts           BI13
  application/
    ports/
      invoice-repository.port.ts     INVOICE_REPOSITORY: findByOrderReference / lockByOrderReference / save (§5.2)
      invoice-read.port.ts           INVOICE_READ: list — the non-locking read for the QueryBus (§5.2)
      invoice-number-allocator.port.ts  INVOICE_NUMBER_ALLOCATOR (§5.2) — copy of Fulfillment's despatch port, one word changed
    queries/
      invoice.queries.ts             ListInvoicesQuery
      invoice.query-handlers.ts      one @QueryHandler class (explicit @Inject)
      invoice.query-handlers.spec.ts
    commands/
      invoice.commands.ts            IssueInvoiceCommand (carries correlationId / requestId)
      invoice.command-handlers.ts    one @CommandHandler class (explicit @Inject)
      invoice.command-handlers.spec.ts
    invoice-issue.handler.ts         the issue transactional unit as a plain class the @CommandHandler delegates to (§5.3)
    invoice-issue.handler.spec.ts    BI5 unit half, ordering probes
    invoice-application-errors.ts    NoActiveCreditHoldError, InvoiceCurrencyMismatchError (§5.5)
  infrastructure/
    persistence/
      invoice.repository.ts          DrizzleInvoiceRepository (§7.1)
      invoice.mapper.ts              rows <-> Invoice (snapshot in, snapshot out)
      invoice-read.repository.ts     DrizzleInvoiceReadRepository: paged list, no locks (§7.2)
      invoice-number-allocator.ts    DrizzleInvoiceNumberAllocator — copy of Fulfillment's despatch allocator (§7.3)
      invoice-number-allocator.spec.ts / .integration.spec.ts
      invoice.repository.integration.spec.ts        BI7
      invoice-read.repository.integration.spec.ts   BI15 SQL half
      schema/
        invoices.schema.ts                UNCHANGED shape; gains the uq index declaration (§6)
        invoice-number-sequences.schema.ts  NEW — the INV- counter row (§6)
        index.ts                          + the new table
    credit/
      simulator-credit-decision.ts   N3 — the numeral guard (§11.3)
      always-approve-credit-decision.ts  N5 — header trimmed (§11.4)
  presentation/
    invoice.controller.ts            two @MessagePattern(…, Transport.NATS) responders (§4.1)
    invoice.controller.spec.ts
    dto/invoice.dto.ts               class-validator DTOs implementing the two @otc/contracts request payloads (§4.2)
    rpc-error-mapper.ts              EXTENDED with this feature's two application errors (§4.3)
  app.module.ts                      + InvoiceController, the two cqrs handler sets, five useFactory providers
  main.ts                            UNCHANGED — still HTTP + ONE NATS microservice, still no Kafka consumer (BI1)
  billing-consumes-no-facts.spec.ts  NEW — BI1's structural guard
  invoice-issue.integration.spec.ts        BI2, BI3, BI4, BI5, BI6, BI9 + R45's integration half
  invoice-issue-race.integration.spec.ts   BI8
  invoice-list.integration.spec.ts         BI15
  invoice-wire.integration.spec.ts         BI16
  test-support/
    credit-integration-harness.ts    EXTENDED: seedInvoice, invoicesOf, issueRequest builder (§13.2)
    cents-rule-fixture-guard.ts      NEW — N2's guard (§11.2)
    cents-rule-fixture-guard.spec.ts BI17

apps/billing/drizzle/
  0002_invoice_sequences_and_order_uniqueness.sql   NEW (§6)
  meta/                                             regenerated by drizzle-kit

apps/orders/src/
  application/saga-command-payloads.ts       §12 — ONE added field, gated (BI21)
  application/saga-command-payloads.spec.ts  §12 — the case that proves it
```

**Layering.** Unchanged from feature 19: `domain/` imports only `@otc/shared-kernel` and `import type` from `@otc/contracts`; ports live in `application/`; every adapter in `infrastructure/`; the only NestJS-decorated classes are the controllers and the cqrs handlers, all with explicit `@Inject(TOKEN)` on every constructor parameter; plain classes are wired with `useFactory` + `inject: [...]`.

## 3. The domain

### 3.1 `Invoice` — the aggregate root

```ts
// apps/billing/src/domain/invoice.ts
export interface InvoiceContext {                      // identical shape to CreditContext — time + causation in, nothing pulled
  readonly occurredAt: Date;
  readonly causationId: UniqueId;
}

/** B9 made unrepresentable: `status` and `paidAt` are ONE value, so neither can exist without the other. */
export type InvoiceState =
  | { readonly status: 'issued' }
  | { readonly status: 'paid'; readonly paidAt: Date };

export interface IssueInvoiceInput {
  readonly id: UniqueId;
  readonly invoiceReference: InvoiceReference;
  readonly orderReference: OrderNumber;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly currency: string;
  readonly lines: readonly InvoiceLineInput[];         // productCode, units: Quantity, unitPrice: Money
  readonly discount: Money;                            // Money.of(0, currency) when the request omits it
  readonly correlationId: UniqueId;                    // the order id
}

export interface MarkPaidInput {
  readonly paymentReference: string;
  readonly amount: Money;                              // must equal totalAmount exactly — B10
  readonly valueDate: Date;
  readonly source: 'operator' | 'robot' | 'test';
  readonly correlationId: UniqueId;
}

export class Invoice extends AggregateRoot<Invoice> {
  /** The ONLY way an Invoice comes into being. Derives amount/totalAmount from the lines, refuses B6 violations, and appends exactly one invoice.issued.v1 before returning — a caller can never observe an Invoice whose fact was not recorded (the DespatchAdvice.create precedent). */
  static issue(input: IssueInvoiceInput, ctx: InvoiceContext): Invoice;

  /** Refuses (InvalidInvoiceSnapshotError) a row whose status and paidAt disagree, whose totals do not reconcile with its lines, or whose currency is not shared by every line (BI10, B6, B9). */
  static reconstitute(snapshot: InvoiceSnapshot): Invoice;

  get invoiceReference(): InvoiceReference;
  get invoiceDate(): Date;
  get orderReference(): OrderNumber;
  get retailerCode(): string; get companyCode(): string; get currency(): string;
  get lines(): readonly InvoiceLine[];
  get amount(): Money; get discount(): Money; get totalAmount(): Money;
  get status(): 'issued' | 'paid';                     // projection of `state`
  get paidAt(): Date | null;                           // projection of `state` — null iff issued, by construction

  /** FEATURE 22's caller, delivered here. issued -> paid in one indivisible step, appending exactly one payment.received.v1. Throws InvoiceAlreadyPaidError (B8), InvoicePaymentAmountMismatchError or InvoicePaymentCurrencyMismatchError (B10) — each of which changes nothing and appends no event. */
  markPaid(input: MarkPaidInput, ctx: InvoiceContext): void;

  toSnapshot(): InvoiceSnapshot;
}
```

**`paidAt` is an acceptance criterion, so it is made structural rather than checked.** `feature_list.json` asks for *"paidAt set exactly when status becomes paid"*. A design with two independent fields can only satisfy that by discipline plus a test. This design has **one private field**, `state: InvoiceState`, a discriminated union; `status` and `paidAt` are read-only projections of it and there is no setter for either. The only way to reach `{ status: 'paid', paidAt }` is `markPaid`, which constructs the pair in a single assignment. The remaining hole is the store — a hand-edited row, or a mapper bug, could present `paid` with a null `paid_at` — and `reconstitute` closes it by refusing the snapshot (`BI10`). This is the same technique feature 19 used for **B2**: an invariant enforced by shape is not a rule anyone can forget.

**No `cancel`, no `void`, no `credit note`.** `domain-model.md` §5.3 gives the invoice exactly one edge. Every other method a reader might expect is deliberately absent, so an illegal transition is a compile error rather than a runtime refusal wherever the type system can reach.

### 3.2 `InvoiceLine` — the child entity

```ts
// apps/billing/src/domain/invoice-line.ts
export class InvoiceLine extends Entity<InvoiceLine> {
  static create(input: { id: UniqueId; productCode: string; units: Quantity; unitPrice: Money }): InvoiceLine;
  static reconstitute(snapshot: InvoiceLineSnapshot): InvoiceLine;
  get productCode(): string; get units(): Quantity; get unitPrice(): Money;
  /** unitPrice × units — the only arithmetic on a line, and the only input to B6. */
  get lineTotal(): Money;
  // No mutator: lines are snapshotted at issue and never change (the OrderLine precedent).
}
```

**Naming, reconciled once.** `domain-model.md` §5.2 and `asyncapi.yaml` both call this `InvoiceLine`; the phase-6 table is `invoice_items` (chosen for symmetry with `order_items` and `despatch_items`). The class follows the shared model and the generated contract type — `InvoiceLine` — and the mapper is the single place the two vocabularies meet. The leader's brief said "`InvoiceItem` children"; the deviation is recorded as row 8 of the open-points table so it is a decision rather than a drift.

### 3.3 Totals — derived, never assigned (**B6**)

```
amount      = Σ (unitPrice × units)      -- Money arithmetic, single currency, integer minor units
totalAmount = amount − discount
```

Computed inside `issue` and recomputed inside `reconstitute` for comparison against the stored columns. `Invoice` exposes no setter for any of the three, exactly as `Order` does not (**O3**). Refusals: an empty line list (`EmptyInvoiceLinesError`), a line whose currency differs from the invoice's (`InvoiceCurrencyMismatchError` — the domain-layer twin of §5.5's application-layer one, raised on a *line*, not on the credit line), a negative `totalAmount` (`NegativeInvoiceTotalError`), and a snapshot whose stored totals disagree with its lines (`InvalidInvoiceSnapshotError`). `Quantity` already refuses zero and negatives at construction, so `BI11`'s unit clause needs no separate check.

### 3.4 The two fact builders

`invoice-events.ts` mirrors `credit-events.ts` and `stock-events.ts` exactly: `createDomainEvent` from `@otc/shared-kernel`, payload types `InvoiceIssuedPayload` / `PaymentReceivedPayload` from `@otc/contracts` (`import type`), the same `Indexed<TPayload>` intersection, `aggregateId = this.id` (the invoice — `domain-model.md` §7.2 names `Invoice` as the producing aggregate of facts 10 and 11), `correlationId = input.correlationId` (the order id), `causationId`/`occurredAt` from `InvoiceContext`.

`invoice.issued.v1` has **one** builder and **one** call site — `Invoice.issue`. `payment.received.v1` has **one** builder and **one** call site — `Invoice.markPaid`. Neither is reachable from the application layer, the repository or a controller, so "the fact accompanies the state change" is structural (**O8**'s analogue for this aggregate).

### 3.5 Domain errors

All extend `DomainError` with a stable `code`: `EmptyInvoiceLinesError` (`EMPTY_INVOICE_LINES`), `InvoiceLineCurrencyMismatchError` (`INVOICE_LINE_CURRENCY_MISMATCH`), `NegativeInvoiceTotalError` (`NEGATIVE_INVOICE_TOTAL`), `InvalidInvoiceSnapshotError` (`INVALID_INVOICE_SNAPSHOT`), `InvoiceAlreadyPaidError` (`INVOICE_ALREADY_PAID`), `InvoicePaymentAmountMismatchError` (`INVOICE_PAYMENT_AMOUNT_MISMATCH`), `InvoicePaymentCurrencyMismatchError` (`INVOICE_PAYMENT_CURRENCY_MISMATCH`). §4.3 maps them to wire codes.

### 3.6 Invariants → where they are enforced

| Invariant | Enforced by | Proven by |
|---|---|---|
| **B6** totals derive from lines, non-negative, one currency | `issue` computes; `reconstitute` refuses a disagreeing snapshot; no setter exists | `R45` domain unit, `BI11` |
| **B7** exactly one invoice per `orderReference` | the fast-path lookup, the in-transaction locking re-read under the `credits` lock, **and** a unique index (§6) | `BI9`, `BI8` |
| **B8** `issued → paid` is the only transition | there is no other mutator on the aggregate; `markPaid` throws on `paid` | `R46` domain unit, `BI14` |
| **B9** `paidAt` iff `paid` | one discriminated-union field; `reconstitute` refuses a disagreeing row | `BI10` |
| **B10** amount must match (payment) | `markPaid` refuses a mismatched amount or currency | `BI14` (the `paymentReference` half is feature 22's) |

## 4. Presentation — two more responders on the existing controller surface

### 4.1 The controller

```ts
// apps/billing/src/presentation/invoice.controller.ts
export const INVOICE_ISSUE_SUBJECT = 'billing.invoice.issue';
export const INVOICE_LIST_SUBJECT = 'billing.invoice.list';

@Controller()
export class InvoiceController {
  constructor(@Inject(QueryBus) private readonly queries: QueryBus, @Inject(CommandBus) private readonly commands: CommandBus) {}

  @MessagePattern(INVOICE_ISSUE_SUBJECT, Transport.NATS) issue(@Payload() p: unknown, @Ctx() ctx: NatsContext): Promise<InvoiceIssueReplyPayload | RpcError>;
  @MessagePattern(INVOICE_LIST_SUBJECT, Transport.NATS) list(@Payload() p: unknown): Promise<InvoiceListReplyPayload | RpcError>;
}
```

A **separate controller class** from `CreditController`, not two more methods on it: they answer different aggregates and have different DTOs, and `app.module.ts`'s `controllers: [...]` array is the only place that changes. Everything else is `credit.controller.ts` verbatim — `Transport.NATS` named explicitly on both patterns (CLAUDE.md non-negotiable + ESLint guard), the same `parseRpcMeta` header discipline (`BI2`), the same never-throws shape (validate → dispatch → `try/catch` → `toRpcError`), the same read-the-spec-as-text subject assertion (`BI16`). `parseRpcMeta` and `missingHeadersRpcError` are **hoisted** out of `credit.controller.ts` into `presentation/rpc-meta.ts` and imported by both, rather than copied — they are one function with two callers inside one service, which is not the cross-service duplication the parity guards exist for.

`list` reads no headers, exactly as `credit.list` does not.

### 4.2 DTOs

`dto/invoice.dto.ts` — two `class-validator` classes each `implements` its generated `@otc/contracts` request payload.

- `InvoiceIssueRequestDto`: `orderReference` matching `/^ORD-\d{6}$/`, `retailerCode`/`companyCode` non-empty, `currency` matching `/^[A-Z]{3}$/`, `lines` a `@ValidateNested({ each: true })` array with `@ArrayMinSize(1)` of `InvoiceLineDto` (`productCode` non-empty, `units` `@IsInt() @Min(1)`, `unitPrice` `@IsInt() @Min(0)`), `discount` optional `@IsInt() @Min(0)`.
- `InvoiceListRequestDto`: optional `status` `@IsIn(['issued','paid'])`, `retailerCode`, `companyCode`, `orderReference`, `issuedBeforeMinutes` `@IsInt() @Min(0)`, plus `page ≥ 1` default 1 and `pageSize 1..200` default 25 — the `PageRequest` shape `CreditListRequestDto` already uses.

Validated manually with `validate(dto, { whitelist: true })` inside the controller so a failure is an `RpcError` under this feature's control. `discount > amount` is **not** a DTO rule — the amount is not known until the lines are summed — it is the domain's `NegativeInvoiceTotalError`, mapped at §4.3.

### 4.3 `rpc-error-mapper.ts` — extended, not replaced

Four cases are added to Billing's existing mapper, ahead of the generic `DomainError` fallback:

| Error | Code | `details` |
|---|---|---|
| `NoActiveCreditHoldError` (application) | `PRECONDITION_FAILED` | `{ code: 'NO_ACTIVE_HOLD', orderReference }` — `BI5` |
| `InvoiceCurrencyMismatchError` (application) | `VALIDATION_FAILED` | `{ expected, received }` — `BI4`, identical treatment to `CreditCurrencyMismatchError` |
| `NegativeInvoiceTotalError`, `EmptyInvoiceLinesError`, `InvoiceLineCurrencyMismatchError` (domain) | `VALIDATION_FAILED` | `{ code }` — they are statements about the *request's* lines, not about an invoice's state |
| `InvoiceAlreadyPaidError`, `InvoicePayment*MismatchError` (domain) | `PRECONDITION_FAILED` | `{ code }` — feature 22 will map them at its own subject; declared here so the vocabulary is complete on delivery |

`CreditLineNotFoundError` is **reused unchanged** for `BI3` — the same error, the same `NOT_FOUND`, the same `details`, raised from the same repository port. `InvalidInvoiceSnapshotError` falls to the existing `DomainError` → `DOMAIN_ERROR` branch, as a programming-error guard rather than client input.

**A refusal is never a fact, and invoice issue has no business rejection at all** (`BI6`). Feature 19 had to distinguish a `rejected` *outcome* from an `RpcError`, because `credit.rejected.v1` exists. Nothing analogous exists for invoicing: `domain-model.md` §7.2's catalogue has thirteen facts and none of them is an invoice refusal. Therefore **every** non-success on `billing.invoice.issue` is an `RpcError` and the only two successful replies are `created: true` and `created: false`. This is stated in the controller's header comment so a later reader does not go looking for the missing rejection branch.

## 5. The application layer — `@nestjs/cqrs`, binding

### 5.1 Buses and handlers

| Subject | Bus | Message class | Handler | Transactional? |
|---|---|---|---|---|
| `billing.invoice.list` | `QueryBus` | `ListInvoicesQuery { status?, retailerCode?, companyCode?, orderReference?, issuedBeforeMinutes?, page, pageSize }` | `ListInvoicesHandler` → `InvoiceReadPort.list` | no — two plain SELECTs |
| `billing.invoice.issue` | `CommandBus` | `IssueInvoiceCommand { request, correlationId, requestId }` | `IssueInvoiceHandler` → `InvoiceIssueHandler.issue` | yes — §5.4 |

The same thin-`@CommandHandler`/plain-class split feature 19 uses, for the same reason: the plain class can be `new`ed with fakes in a unit test. **No `EventBus`, no `@Saga`** — the orchestrator lives in Orders.

### 5.2 Ports

```ts
// invoice-repository.port.ts
export const INVOICE_REPOSITORY = Symbol('InvoiceRepository');
export interface InvoiceRepository {
  /** The B7 fast path: a non-transactional read by orderReference, no lock, before any transaction is opened (the DespatchRepository.findByOrderReference precedent). */
  findByOrderReference(orderReference: OrderNumber): Promise<InvoiceSnapshot | null>;
  /** The B7 authority: the same read `FOR UPDATE`, INSIDE `tx` and AFTER the credits row lock (§5.4 step 2). A locking read is a CURRENT read, so it removes the REPEATABLE-READ snapshot reasoning entirely — the argument feature 19 §5.5 made for its steps 2 and 3 — and its gap lock on `uq_invoices_order_reference` blocks a concurrent insert for the same order. */
  lockByOrderReference(tx: TransactionContext, orderReference: OrderNumber): Promise<InvoiceSnapshot | null>;
  /** INSERTs the invoice row and its line rows, then drains `invoice.pullDomainEvents()` into the outbox, all inside `tx` (R13). Never UPDATEs on the issue path. `tx` required — never opens its own. */
  save(invoice: Invoice, tx: TransactionContext): Promise<void>;
}

// invoice-read.port.ts — the QueryBus side; never locks, never mutates
export const INVOICE_READ = Symbol('InvoiceRead');
export interface InvoiceReadPort {
  list(query: InvoiceListRequestPayload, now: Date): Promise<InvoiceListReplyPayload>;
}

// invoice-number-allocator.port.ts — Fulfillment's despatch port with one word changed
export const INVOICE_NUMBER_ALLOCATOR = Symbol('InvoiceNumberAllocator');
export interface InvoiceNumberAllocator {
  /** Allocates the next InvoiceReference inside `tx` — never opens a transaction of its own. Concurrency-safe: two callers racing this must never receive the same value. */
  next(tx: TransactionContext): Promise<InvoiceReference>;
}
```

`InvoiceReadPort.list` takes `now` as a parameter rather than injecting a clock into the adapter: the handler reads `clock.now()` once and passes it, so the SQL adapter stays a pure translation of a query into statements and `BI15`'s `issuedBeforeMinutes` case can be driven by a fixed clock without a container-level fake.

`BuyerCreditRepository` is **reused unchanged**. `lockForOrder(tx, retailerCode, companyCode, orderReference)` already returns exactly what the consume needs — the locked credit line with that order's entries — and `save(credit, tx)` already inserts `appendedEntries` and drains the (empty) event list. No port changes, no new method, no signature change. That is the measure of how well feature 19's seam was cut.

### 5.3 Application errors

`invoice-application-errors.ts`: `NoActiveCreditHoldError(orderReference)` (`BI5`) and `InvoiceCurrencyMismatchError(expected, received)` (`BI4`). Both are contract violations of the incoming command rather than statements about an invoice's state, so they live in `application/`, mirroring `credit-application-errors.ts`.

### 5.4 The issue transactional unit, and the lock protocol

```ts
// apps/billing/src/application/invoice-issue.handler.ts  (plain class)
export class InvoiceIssueHandler {
  constructor(unitOfWork: UnitOfWork, credits: BuyerCreditRepository, invoices: InvoiceRepository, invoiceNumbers: InvoiceNumberAllocator, clock: Clock) {}
  issue(cmd: IssueInvoiceCommand): Promise<InvoiceIssueReplyPayload>;
}
```

**Step 0 — the B7 fast path, outside any transaction** (the `DespatchCreationHandler` precedent, feature 18): `invoices.findByOrderReference(orderReference)`; on a hit, return `created: false` immediately. The common redelivery case therefore opens no transaction and takes no lock at all — which matters, because the sweeper retries and `saga.md` §6 layer 3 makes repeats routine rather than exceptional.

Then, inside one `UnitOfWork.execute`, in this order and nothing else:

```sql
-- 1. claim the credit line — ALWAYS the first lock this service takes (BI8)
--    BuyerCreditRepository.lockForOrder: SELECT ... FROM credits
--      WHERE retailer_code = :retailer AND company_code = :company FOR UPDATE;
--    then, under it, the committedExposure scalar and this order's credit_items, both FOR UPDATE.
-- no row -> ROLLBACK, CreditLineNotFoundError -> RpcError NOT_FOUND (BI3). Nothing written, no fact.

-- 2. the B7 authority, now that the credit lock serialises every competitor
SELECT * FROM invoices WHERE order_reference = :ref FOR UPDATE;   -- uq_invoices_order_reference
-- a row -> COMMIT (nothing was written) and reply created:false (BI9).

-- 3. currency check against the credit line -> InvoiceCurrencyMismatchError (BI4)
-- 4. activeHold(order) from the loaded ledger; 0 -> NoActiveCreditHoldError (BI5). Nothing written, no fact.

-- 5. allocate the reference — the LAST lock taken (BI8)
SELECT next_value FROM invoice_number_sequences WHERE id = 1 FOR UPDATE;  UPDATE ... SET next_value = next_value + 1;

-- 6. domain: Invoice.issue(...)  -> appends invoice.issued.v1 to itself
--            credit.consumeHold({ orderReference }, ctx, newId) -> appends ONE `consume` entry, NO fact (R40)

-- 7. invoices.save(invoice, tx)   -> INSERT invoices + INSERT invoice_items + outbox(invoice.issued.v1)
--    credits.save(credit, tx)     -> INSERT credit_items (one `consume` row); drains an EMPTY event list
-- COMMIT
```

- **`ctx = { occurredAt: clock.now(), causationId: cmd.requestId }`**, read **once** and used for the invoice's `invoiceDate`, the fact's `occurredAt` and the ledger entry's `entryDate`, so all three agree exactly (`BI13`).
- **Why the credit line is locked before the invoice.** Two concurrent issues for the same order contend on the `credits` row first and are therefore fully serialised before either looks at `invoices` — precisely how feature 18's despatch handler uses the stock-row locks to serialise `F8`. The loser then finds the committed invoice at step 2 and answers `created: false`. The unique index of §6 is the belt to that braces: it cannot be reached in normal operation, and if a future change removes the lock it turns a silent double-invoice into a loud constraint violation.
- **Why the allocator is last.** The counter row is a global hot spot: every invoice in the service contends on it. Taking it last minimises the time it is held, and taking it *always* last means it can never be the first edge of a cycle. `BI8` states the order as a service-wide rule precisely so feature 22 inherits it rather than rediscovering it.
- **Why this transaction may touch two aggregates.** See `requirements.md` `BI7`'s note and §5.6 below.
- **The reply is built from the domain outcome before commit but returned after `execute` resolves**, so a rollback can never produce a success reply — feature 19's rule, unchanged.

### 5.5 Responder idempotency — the key, stated once

| Command | Idempotency key (`saga.md` §2) | What a repeat observes | Reply | Fact | Ledger |
|---|---|---|---|---|---|
| `invoice.issue` | **`orderReference`** | an `invoices` row for that order | `created: false` + the existing reference, date, currency, total and **current** status | none | none |
| `invoice.issue` | `orderReference` | no row, but no active hold either | `RpcError PRECONDITION_FAILED` | none | none |
| `invoice.list` | — (read) | — | — | none | none |

**The key is the order reference, not a request id and not the invoice reference.** `saga.md` §2 fixes it (`(orderReference, issue)`), **B7** makes it a domain invariant rather than a transport convenience, and the AsyncAPI reply schema's `created` flag is the wire expression of it. A `requestId`-keyed alternative was considered and rejected: the sweeper generates a fresh `x-request-id` per attempt, so it would deduplicate nothing, and it would let two *different* commands mint two invoices for one order — exactly what **B7** forbids.

**`created: false` is returned even when the invoice is already `paid`.** The reply carries `status`, so the caller sees the truth; no transition is attempted, so **B8** is not consulted; and the saga's own precondition (`invoice.issued.v1` requires order status `despatched`) already discards the redelivered fact. This is `saga.md` §6's three layers doing their job with nothing added.

### 5.6 The two-aggregate transaction, argued

`domain-model.md` §8 rule 6 says *"one transaction mutates exactly one aggregate instance plus its outbox records"*. This transaction mutates two: an `Invoice` and a `BuyerCredit`. That is a deliberate, argued deviation — the second in this repository, after `F3`.

| Alternative | Why not |
|---|---|
| Invoice first, `consume` in a second transaction | A crash between them leaves an invoice issued with the hold still active. The hold is then released twice-over at payment (once as exposure that never existed), or blocks credit forever. **Nothing can detect it**: `consume` emits no fact, so no consumer, no projector and no saga step can observe the gap. |
| `consume` first, invoice in a second transaction | Symmetric, and worse: the hold is converted for an invoice that may never exist, and the `invoice.issue` retry then hits `NO_ACTIVE_HOLD` (`BI5`) forever. |
| Make `consume` emit a fact and drive the invoice from it | A fourteenth fact in a thirteen-fact catalogue, a Billing-side consumer that `saga.md` §5 forbids, and a trilogy-wide contract change — to remove a window that a single transaction removes for free. |
| Split `Invoice` and the ledger into one aggregate | Collapses two genuinely independent lifecycles (an invoice is per order, a credit line is per party pair and outlives every order) and would make the credit line a write hot spot for every invoice read. |
| **One transaction, two aggregates, one fixed lock order** | **Chosen.** Both writes are in one service, one database and one `UnitOfWork`; the lock order of `BI8` makes the composition deadlock-free; and the resulting invariant — *an invoice exists if and only if its hold was consumed* — is checkable by a single SQL query at any time, which `BI7`'s integration test does. |

The precedent is exact: feature 17 accepted a multi-aggregate transaction because **F3** ("reservation is all-or-nothing per order") is an invariant no single aggregate owns. Here the invariant is *"an issued invoice's hold is consumed"*, which likewise spans two aggregates and has no fact to repair it. In both cases the deviation is justified by an invariant, never by convenience — which is the test this design proposes any future deviation must pass.

## 6. The migration — the one schema change

`apps/billing/drizzle/0002_invoice_sequences_and_order_uniqueness.sql`, generated by `drizzle-kit` from two schema edits:

1. **`invoice_number_sequences`** — new table, byte-for-byte the shape of `despatch_number_sequences` and `order_number_sequences` (`id tinyint PRIMARY KEY`, `next_value int NOT NULL`), with the same header comment naming it a technical allocation primitive rather than a business entity.
2. **`uq_invoices_order_reference`** — a unique index on `invoices.order_reference`, making **B7** mechanical. Also the index the fast path and the locking re-read of §5.4 use, and the gap lock that blocks a concurrent insert.
3. **`idx_invoices_status_invoice_date`** — a plain index on `(status, invoice_date)` for `BI15`'s `status` + `issuedBeforeMinutes` filter, which is what the demo bank robot (feature 33) will poll.

**Before adding the unique index the implementer verifies the existing rows satisfy it** (`SELECT order_reference, COUNT(*) FROM invoices GROUP BY 1 HAVING COUNT(*) > 1` returns nothing — the seed writes one invoice per completed order, so it should). A migration that fails on a live dev database is a worse outcome than a task that checks first.

**No recreate.** `ADD UNIQUE` and `CREATE TABLE` both apply over existing rows, so `docker compose down -v` is **not** required — unlike feature 14's `ADD COLUMN NOT NULL`. The `payments` table and its FK to `invoices` are untouched (feature 22's).

**`OI11` is unaffected.** The outbox-schema byte-identity guard compares the three services' `outbox`/`processed_events` statements; this migration mentions neither table. Feature 19 fixed `outbox-parity.spec.ts`'s comment-matching bug (**N1** of `review_fulfillment_despatch.md`), so the migration header may use the word "outbox" freely — a task re-runs that spec to confirm the count is unchanged.

## 7. Persistence — the Drizzle adapters

### 7.1 `DrizzleInvoiceRepository` (write side)

Plain class; `BillingDb` + `Clock` + `OutboxRecorder`, defaulted exactly as `DrizzleBuyerCreditRepository` defaults them.

- `findByOrderReference`: one `SELECT` on `invoices` by `order_reference` plus one on `invoice_items` by `invoice_id`, no lock, no transaction. Returns the snapshot, not the aggregate — the fast path only needs to build a reply.
- `lockByOrderReference`: the same two reads inside `tx`, the parent `.for('update')` (no `skipLocked`: a contender must **wait**, not skip).
- `save`: `insert(invoices).values(row)` then `insert(invoiceItems).values(rows)` — never an `UPDATE` on this path (feature 22 adds the `markPaid` update, and adds it to this same file) — then `outboxRecorder.record(tx, invoice.pullDomainEvents())`. The repository drains, never the handler (feature 14 §4.4; `OI9`'s drained-events hazard applies unchanged).
- `invoice.mapper.ts`: `rowToSnapshot` / `snapshotToRow`, amounts as integer minor units, dates as UTC `Date`s (the pool is created with `timezone: 'Z'`), `paid_at` ↔ the `InvoiceState` union — the one place the two representations meet, and the one place `BI10`'s store-side hole is closed.

### 7.2 `DrizzleInvoiceReadRepository` (`InvoiceReadPort`)

Two queries, no transaction, no lock: the page of `invoices` with the four optional equality filters plus `invoice_date <= now − issuedBeforeMinutes` when supplied, `ORDER BY invoice_date DESC, invoice_reference DESC`, `LIMIT/OFFSET`; and a `COUNT(*)` over the same filter for `PageInfo.total`. Lines are **not** joined — `InvoiceView` does not carry them (`asyncapi.yaml`), and the demo robot pages over hundreds of rows. `paidAt` is serialised as an ISO string or `null`, matching the schema's `oneOf`.

### 7.3 `DrizzleInvoiceNumberAllocator`

A copy of `apps/fulfillment/src/infrastructure/persistence/despatch-number-allocator.ts` with `DES-`→`INV-`, `despatches`→`invoices`, `despatchReference`→`invoiceReference`, carrying a `// COPY OF —` banner naming its source. Same mechanism, and same reason for the mechanism: a numeric `MAX(CAST(SUBSTRING(...)))` self-initialisation so the first live allocation continues past the seed's `INV-00000n` instead of colliding with it, an idempotent `ON DUPLICATE KEY UPDATE` ensure-insert, then `SELECT ... FOR UPDATE` + `UPDATE`.

**Not added to a parity guard.** There are now three near-identical allocators (`ORD-`, `DES-`, `INV-`), and unlike the outbox-relay family they are *not* one implementation duplicated — each names its own table and prefix, so banner-stripped byte identity is impossible without the same `WriteModelDb`-style indirection feature 19 applied to the relay. Extending that treatment to the allocator family is recorded as an open point (row 10), deliberately not smuggled into this feature.

## 8. Consumers — still none (`BI1`)

`main.ts` is **unchanged**: HTTP plus one NATS microservice with the bare-JSON (de)serializers, and no Kafka consumer transport. The relay's kafkajs producer remains the only Kafka client in the service. `consumer-name.ts` still declares `CONSUMER_NAMES = [] as const`.

`billing-consumes-no-facts.spec.ts` is the structural guard: pure text over `apps/billing/src/**/*.ts` (excluding `*.spec.ts` and `test-support/`), asserting that no file contains `@EventPattern`, that `main.ts` calls `connectMicroservice` exactly once and with `Transport.NATS`, and that no file imports a Kafka **consumer** API. The `kafkajs` producer import in the relay is explicitly allowed and named, so the guard is specific rather than a blanket ban. Non-vacuity: the assertion list is exercised against a fixture string containing `@EventPattern` to prove the matcher works.

## 9. First boot against the live compose stack — the expectation, stated in advance

**Pre-state.** At the time of writing, `otc_orders.saga_commands` holds **seven** `invoice.issue` rows in status `parked`, each with `last_error` reading *"transport failure on subject \"billing.invoice.issue\": no responder is subscribed to this subject"* — the five orders `ORD-000007` … `ORD-000011` that reached `despatched` during feature 19's live boot, plus the happy-path orders placed during features 19 and 20's passes. **The implementer records the exact set before booting** (`SELECT order_reference, command, status, attempts, last_error FROM otc_orders.saga_commands WHERE command = 'invoice.issue' ORDER BY order_reference;`) rather than trusting this paragraph; the number may have moved.

**What happens on the first boot with the responder registered.** For each parked row, on its next `next_attempt_at`, the sweeper re-dispatches. Billing now answers. In one transaction per order: the credit line is locked, no invoice is found, the currency matches, the order's `activeHold` is its `hold` amount, `INV-00000n` is allocated, the invoice and its lines are inserted, one `consume` entry is appended, one `invoice.issued.v1` outbox record is written. The relay publishes it to `otc.billing.facts.v1` keyed by the order id; the orchestrator consumes it, finds the order in `despatched`, and moves it to **`invoiced`**.

**And then it stops.** `saga.md` §3.1 step 5 is explicit: *"The saga now waits for the outside world — no internal timer, no polling."* There is no command owed at `invoiced`, so no `saga_commands` row is enqueued, nothing parks, nothing retries and nothing warns. The steady state is:

| Where | Expected steady state |
|---|---|
| `otc_orders.orders` | the seven orders at `status = 'invoiced'`; `ORD-000012`/`ORD-000013`/`ORD-000016`/`ORD-000017` remain `cancelled` |
| `otc_orders.saga_commands` | every `invoice.issue` row `sent`/completed, **zero** parked rows for those orders, and **no new row of any kind** |
| `otc_billing.invoices` | the five seeded rows plus one per unparked order, each `status = 'issued'`, `paid_at` NULL |
| `otc_billing.credit_items` | one new `consume` row per order, amount equal to that order's `hold` |
| `availableCredit` per line | **numerically unchanged** by the whole exercise — `R40`'s neutrality, now visible in production data for the first time. This is the single most convincing observation of the boot, and the implementer records the before/after `SELECT` for the same credit line side by side |
| `otc_billing.outbox` | one `invoice.issued.v1` per order, all with `published_at` stamped |
| Mongo `order_timeline` | unchanged — the projector is feature 24 |

**What must NOT happen**, and is asserted rather than assumed: no `payment.received.v1`, no `credit.released.v1`, no order reaching `paid` or `completed`, and no parked `payment.register` row — feature 22 does not exist, and nothing in this feature invents a payment trigger. A saga that stalls at `invoiced` is the **designed** end state of this phase, not a defect, and the implementer says so explicitly in `progress/impl_billing_invoicing.md` so the human's manual verification does not read it as a stall.

**A fresh end-to-end order** is placed as the control (`node scripts/place-order.mjs --qty 2`, a non-`.99` total well within credit) and must traverse `placed → stock_reserved → credit_approved → confirmed → despatched → invoiced` unattended — the first time an order in this repository crosses all three services in one continuous run.

## 10. Testing approach

| File | Level | Runner | Proves |
|---|---|---|---|
| `domain/invoice.spec.ts` | domain unit | `vitest.config.mts` (in `pnpm quality`) | `R45` and `R46` (matrix names, verbatim), `BI10`, `BI11`, `BI14` |
| `domain/invoice-events.spec.ts` | domain unit | idem | `BI13` |
| `application/invoice-issue.handler.spec.ts` | unit | idem | `BI5` unit half; the fast path opens no transaction; the credit line is locked before the invoice is read; reply built after commit; rollback ⇒ no reply |
| `application/invoice.{command,query}-handlers.spec.ts` | unit | idem | delegation only |
| `presentation/invoice.controller.spec.ts` | unit | idem | `BI2` header refusal, validation ⇒ `RpcError`, never throws, subject constants = AsyncAPI addresses (`BI16` half) |
| `presentation/rpc-error-mapper.spec.ts` (extended) | unit | idem | every added error class → its code and `details` |
| `infrastructure/persistence/invoice-number-allocator.spec.ts` | unit | idem | `BI12` formatting half |
| `billing-consumes-no-facts.spec.ts` | unit (structural) | idem | `BI1` |
| `test-support/cents-rule-fixture-guard.spec.ts` | unit | idem | `BI17` |
| `infrastructure/credit/simulator-credit-decision.spec.ts` (extended) | unit | idem | `BI18` |
| `invoice-issue.integration.spec.ts` | integration | `vitest.integration.config.mts` — Testcontainers MySQL `mysql:8.4.11` + NATS `nats:2.14.5-alpine` + Kafka `apache/kafka:4.3.1` | `R45` integration half, `BI2` – `BI6`, `BI9` |
| `invoice-issue-race.integration.spec.ts` | integration | idem | `BI8` |
| `invoice-list.integration.spec.ts` | integration | MySQL + NATS | `BI15` |
| `invoice-wire.integration.spec.ts` | integration | MySQL + NATS | `BI16` |
| `infrastructure/persistence/invoice.repository.integration.spec.ts` | integration | MySQL | `BI7` |
| `infrastructure/persistence/invoice-read.repository.integration.spec.ts` | integration | MySQL | `BI15` SQL half |
| `infrastructure/persistence/invoice-number-allocator.integration.spec.ts` | integration | MySQL | `BI12` concurrency half |
| `credit-rejection-parity.integration.spec.ts` (amended) | integration | idem | `BI19` |
| `apps/orders/.../saga-command-payloads.spec.ts` (extended) | unit | idem | `BI21` — **only if the gate approves row 5** |

**The synchronisation rule is binding** (reviewer ruling, feature 16 third pass; feature 19 design §13). Wait only on **terminal or monotonic** evidence: an RPC reply, an outbox row's `published_at` (set once, never cleared), the row count of the append-only `credit_items` table, the presence of an `invoices` row (inserted once, never deleted on this path), the `claimed`/`published` result of a hand-driven `relay.runOnce()`, or a Kafka consumer's received-message list. **Never** poll a status a correct system passes through. For `BI8`: fire two raw-`nats` `invoice.issue` requests with `Promise.all`, then assert on the **replies** (exactly one `created: true`, exactly one `created: false`, both naming the same `invoiceReference`), on the **final** `COUNT(*)` of `invoices` and of `consume` entries for the order (both exactly 1), and on the outbox holding exactly one `invoice.issued.v1`. Repeat on ten fresh orders so a scheduling fluke is visible rather than lucky.

**The fact-emission rule is binding, and this feature has two branches under it.** `Invoice.issue`'s `invoice.issued.v1` has a live caller and is reachable from integration; `Invoice.markPaid`'s `payment.received.v1` has **no** caller and is reachable only from `invoice.spec.ts`. Both emissions are armed for deletion by the implementer before submitting, and `progress/impl_billing_invoicing.md` records which named test failed and with what message. A third, subtler case belongs to the same rule and is easy to miss: `consumeHold`'s **deliberate suppression** of any fact (`R40`). Deleting a fact that is not there is not possible, so the guard is inverted — `BI7`'s integration test asserts the outbox holds **exactly one** record for the correlation id after issue, and the implementer arms it by *adding* a spurious `credit.consumed` outbox record and confirming the test fails.

**Harness.** `test-support/credit-integration-harness.ts` is **extended, not forked** — it already boots the real `AppModule` graph against Testcontainers with the bare-JSON (de)serializers, and `AppModule` now contains the invoice providers, so a second harness would only diverge. It gains `seedInvoice(row)`, `invoicesOf(orderReference)`, `invoiceItemsOf(invoiceId)` and the `issueRequest(...)` fixture builder of §11.2. The file is renamed to `billing-integration-harness.ts` (with every import updated) since it is no longer credit-specific — a mechanical rename, listed as its own task.

## 11. The four inherited findings, and one already applied

### 11.1 Which are fixed here and which are reassigned

| Finding | Decision | Where |
|---|---|---|
| **N1** — the `R44` parity test compares against a hard-coded key list | **Fix here.** Three lines in one test file. Route to `test_maintainer`: it is a mechanical assertion strengthening in a spec file after a landed change, exactly that agent's remit, and it cannot touch source. | §11.2 below is unrelated; the change is `credit-rejection-parity.integration.spec.ts` only |
| **N2** — every billing fixture is silently subject to the `.99` rule | **Fix here**, and it is this feature's biggest inherited hazard because invoicing fixtures carry *computed* totals. §11.2 | new `test-support/cents-rule-fixture-guard.ts` + spec |
| **N3** — `Number('0x1')` → rate 1 | **Fix here.** One regex guard plus spec cases in `simulator-credit-decision.ts`; this feature's own live boot runs against that config, so a silent "reject everything" would corrupt its evidence | §11.3 |
| **N5** — the always-approve adapter's header cites a consumer that does not exist | **Fix here.** Comment-only, zero risk | §11.4 |
| **N6** — the matrix's `billing/domain/…` sketch for an infrastructure adapter | **Already applied by this spec pass** — it is a `specs/shared/` edit, which is the spec author's file, not the implementer's | §11.5 |

### 11.2 N2 — the durable guard, and why a text scan alone is not one

The reviewer offered two candidate fixes: a unit test scanning integration specs for a literal `≡ 99 (mod 100)`, or a `harness.amount()` helper that refuses such values. **Neither alone is sufficient here**, and the reason is specific to invoicing: an invoice fixture's credit-relevant amount is usually **computed**, not written. A fixture of three lines at `8_333` minor units totals `24_999`, which ends in 99 and which no scan of literals would ever see. Conversely a helper only guards the amounts routed through it, and a hand-built payload bypasses it.

So the guard is **both halves, with the computed half load-bearing**:

```ts
// apps/billing/src/test-support/cents-rule-fixture-guard.ts
export const CENTS_RULE_OPT_IN = 'cents-rule-intentional';

/** Throws unless `minorUnits % 100 !== 99` or the caller opts in explicitly. Called by every harness builder whose amount can reach the credit-decision port. */
export function assertNotCentsRuleAmount(minorUnits: number, context: string, optIn?: typeof CENTS_RULE_OPT_IN): void;

/** The backstop: scans `apps/billing/src/**\/*.integration.spec.ts` for integer literals in money positions and fails on an un-opted-in `…99`. */
export function findUnguardedCentsRuleLiterals(sourceRoot: string): { file: string; line: number; value: number }[];
```

- The **runtime half** is called from the harness's `holdRequest(...)`, `issueRequest(...)` and `seedCreditItem(...)` builders on the *computed* total, so `3 × 8_333` fails loudly at the moment the fixture is built, naming the file and the amount, with the message *"this amount triggers the simulated cents rule (R42) — pass CENTS_RULE_OPT_IN if that is the point of the test"*.
- The **text half** is `BI17`'s spec, catching payloads assembled by hand that never reach a builder. It has an explicit allow-list of one file — `credit-rejection-parity.integration.spec.ts`, whose whole purpose is a `.99` amount — expressed as an inline `// cents-rule-intentional` marker on the offending line rather than a filename list, so it cannot rot when the file is renamed.
- **Scope, stated honestly.** The `.99` rule lives behind the credit-decision port, which is consulted **only** on `billing.credit.hold`. An invoice total ending in 99 is by itself harmless — invoicing never consults the port. The hazard is precisely an amount that *reaches a hold*, which for this feature's specs means a fixture that places a hold before issuing. The guard is deliberately broader than the hazard (it also refuses a harmless `.99` invoice total) because a guard whose scope a reader has to reason about is a guard that gets bypassed; the opt-in marker is the escape hatch.

**Rejected alternative, recorded:** binding `AlwaysApproveCreditDecision` in the integration harness via `overrideProvider`, which would remove the hazard entirely *and* give `N5`'s header a real consumer. Rejected because feature 19's harness deliberately compiles the real `AppModule` with **no** overrides so that the DI, decorator and serializer wiring under test is the wiring `main.ts` boots — the property that would have caught feature 16's transport-binding crash. Trading it away to avoid writing a fixture guard would be a bad exchange.

### 11.3 N3 — `CREDIT_FAILURE_RATE` numeral strictness

`loadCreditSimulatorConfig` gains a shape check before `Number()`: the raw value, after `trim()`, must match `/^(?:\d+|\d*\.\d+)$/` — plain decimal digits with an optional single decimal point, no sign, no hex, no exponent, no whitespace-only. Absent and `''` continue to mean `0` (shared `R43`'s default). Anything else throws the same start-up error `R43` already specifies, naming the offending value. `BI18`'s cases: `'0x1'`, `'  '`, `'1e0'`, `'+0.5'`, `'NaN'` all fail to start; `'0'`, `'1'`, `'0.25'`, `''`, absent all continue to work exactly as today. This **strengthens** `R43` without amending it — `R43` already says an out-of-range value fails startup; this makes an *uninterpretable* value fail too, rather than be coerced.

### 11.4 N5 — the honest header

`always-approve-credit-decision.ts`'s header drops *"for any harness that wants approve-everything behaviour without the simulator's rules"* and states what is true: it is the credit-decision port's reference implementation, kept as the minimal example an adapter author copies, and the provider a future harness may bind through `overrideProvider`. §11.2 records that this feature considered being that harness and deliberately declined, so the claim stays honest.

### 11.5 N6 — already applied

`specs/shared/test-matrix.md`'s `R42` and `R43` sketch column now reads `billing/infrastructure/credit-simulator.spec` instead of `billing/domain/credit-simulator.spec`. The sketch column is what #8 and #9 build from, and the old value would have led both to put an adapter's test in the domain layer, where a domain-purity rule would then fight it. The `Actual` columns were already correct and are untouched. Recorded as row 9 of the open-points table because it is a `specs/shared/` edit, however small.

## 12. `apps/orders` — one field, gated

**Only if open-point row 5 is approved:** `apps/orders/src/application/saga-command-payloads.ts`'s `case 'invoice.issue'` gains `discount: order.initialDiscount.amount`, and `saga-command-payloads.spec.ts` gains one case asserting that a discounted order's `invoice.issue` request carries the discount so the invoice total equals the order total (`BI21`). That is the entire Orders footprint: one property, one test case, no schema change (`discount` is already an optional field of `InvoiceIssueRequestPayload`), no contract regeneration.

If the gate declines, nothing in `apps/orders` is touched and the divergence is recorded as owed in `progress/impl_billing_invoicing.md`'s hand-over, with feature 25 (the Gateway, the first component that can place a discounted order from outside) as its owner.

## 13. Configuration and dependencies

**No new environment variable. No new package. No new catalog entry.** Everything this feature needs — `@nestjs/cqrs`, `@nestjs/microservices`, `class-validator`, `class-transformer`, `kafkajs`, `nats`, `@nestjs/testing`, `@testcontainers/*` — is already in `apps/billing/package.json` from feature 19. This is worth stating explicitly, because a phase commit message that lists no packages should be read as a fact, not an omission.

`BILLING_PORT`, `NATS_URL`, `KAFKA_BROKERS`, `BILLING_KAFKA_CLIENT_ID`, `CREDIT_FAILURE_RATE` and the four `OUTBOX_*` settings are unchanged. `.env.example` is untouched.

## 14. Rejected alternatives, recorded

| Alternative | Why not |
|---|---|
| A Kafka consumer in Billing for `order.despatched.v1` | Duplicates the trigger, bypasses the saga's dedup record and order-status precondition (`saga.md` §6 layers 1 and 2), puts a second unsequenced writer on the invoice, and contradicts `saga.md` §5's consumption map. `BI1` guards against it structurally |
| Deriving the invoice lines from Billing's own data | Billing has none: it holds no order, no despatch and no product catalogue. The lines arrive in the request, which is why `InvoiceIssueRequestPayload` carries them (`asyncapi.yaml`: *"The invoice mirrors them exactly"*, **F7**) |
| Checking the order's status before invoicing | Would require Billing to read the Orders write model, which `domain-model.md` §1 boundary rule 1 forbids. The active hold is the proxy, and `BI5` says so out loud rather than pretending the check exists |
| Emitting a rejection fact when there is no active hold | There is no such fact in the thirteen-fact catalogue, and inventing one is a trilogy-wide contract change to describe a two-write-model disagreement that a human must look at |
| Keying idempotency on `requestId` instead of `orderReference` | The sweeper generates a fresh request id per attempt, so it would deduplicate nothing, and two different commands could mint two invoices for one order — exactly what **B7** forbids |
| Two independent fields for `status` and `paidAt` | Makes an acceptance criterion depend on discipline. One discriminated-union field makes the invalid pair unrepresentable (`BI10`) |
| A `Payment` child collection on `Invoice` now | Feature 22's. `markPaid` takes the payment's fields as arguments and emits the fact; persisting a `payments` row, deduplicating by `paymentReference` and releasing the credit are 22's additions to the same aggregate and the same repository file |
| Splitting a second integration harness for invoicing | The existing harness already boots the real `AppModule`, which now contains the invoice providers. A fork would only diverge |
| A parity guard over the three `*-number-allocator.ts` files | They are not one implementation duplicated — each names its own table and prefix. Guarding them needs the `WriteModelDb`-style indirection feature 19 applied to the relay, which is a refactor with its own scope. Open point, row 10 |

## 15. Out of scope — restated

- **`billing.payment.register`, the `Payment` entity, the `payments` table, dedup by `paymentReference`, the `release` ledger call, `credit.released.v1` on payment, `R47` – `R49`**: feature 22. `markPaid` is delivered, unit-tested and uncalled; `BI8`'s lock order is binding on it.
- **The Gateway's callers of `billing.invoice.list` and the "Register payment" button**: features 25 and 29.
- **DLQ, retries, metrics, tracing, `traceparent`/`x-deadline-ms`, Terminus**: feature 27.
- **The projector's `order_timeline` entries for `invoice.issued.v1`**: feature 24.
- **Credit notes, dunning, partial payment, partial invoicing, invoice cancellation**: out of the model (`domain-model.md` §9).
- **A parity guard over the allocator family**: open point, row 10.
- **The `apps/orders` discount field**: §12, gated on open-point row 5.
