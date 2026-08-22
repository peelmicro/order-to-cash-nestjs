// The crux of this feature, deliberately the smallest file — design.md
// §3.3. `summariseLedger` is the ONE place `BC5`/`BC6` are computed, in
// this service and in the read model alike (`DrizzleCreditReadRepository`
// folds the same function over SQL-grouped rows).
//
// Why this formula and not `domain-model.md` §5.1's literal one. The
// shared model writes `activeHold = Σhold − Σconsume − Σrelease applied to
// holds` and `openExposure = Σconsume − Σrelease applied to exposures`.
// The qualifier "applied to holds" is not computable: a `release` row
// carries a type, an amount and an order reference, and nothing that says
// which of the two quantities it unwinds. Worse, the naive unqualified
// reading breaks **B5**: for an order cancelled before invoicing (`h`, then
// `r = h`, `c = 0`) it yields `openExposure = c − r = −h`, a negative
// exposure the model explicitly forbids. The two-term identity below is
// exact, needs no qualifier, and is what this assessment implements:
//
//   exposure(order)      = Σ hold(order) − Σ release(order)             -- B5 keeps this >= 0
//   openExposure(order)  = min( Σ consume(order), exposure(order) )     -- the invoiced part of what is still tied up
//   activeHold(order)    = exposure(order) − openExposure(order)
//   committedExposure    = Σ_orders exposure(order) = Σ_line hold − Σ_line release
//   availableCredit      = creditLimit − committedExposure              -- computed by the aggregate, which alone knows creditLimit
//
// `consume` is numerically neutral by construction: it appears in neither
// term of `committedExposure`, which is WHY invoice issue is `R40`-neutral
// — a property of the formula, not a rule applied on top of it.
import type { CreditLedgerEntrySnapshot } from './credit-ledger-entry.js';

export interface OrderExposure {
  readonly orderReference: string;
  /** Σ hold − Σ release, in minor units — what the order still ties up. */
  readonly exposure: number;
  /** min(Σ consume, exposure) — the invoiced portion. */
  readonly openExposure: number;
  /** exposure − openExposure — the not-yet-invoiced portion. */
  readonly activeHold: number;
  /** BC7's idempotency predicate: a `hold` was recorded, whatever happened since. */
  readonly hasHoldEntry: boolean;
}

export interface LedgerSummary {
  readonly byOrder: readonly OrderExposure[];
  /** Σ exposure over every order = Σ hold − Σ release over the whole line. */
  readonly committedExposure: number;
  readonly activeHolds: number;
  readonly openExposure: number;
}

interface OrderAccumulator {
  hold: number;
  release: number;
  consume: number;
  hasHoldEntry: boolean;
}

/** PURE. The only place BC5 and BC6 are computed, in this service and in the read model alike. */
export function summariseLedger(entries: readonly CreditLedgerEntrySnapshot[]): LedgerSummary {
  const byOrderAcc = new Map<string, OrderAccumulator>();
  // Preserve first-seen order — a deterministic, but otherwise
  // unimportant, iteration order for `byOrder`.
  const orderOrder: string[] = [];

  for (const entry of entries) {
    const orderReference = entry.orderReference.value;
    let acc = byOrderAcc.get(orderReference);
    if (!acc) {
      acc = { hold: 0, release: 0, consume: 0, hasHoldEntry: false };
      byOrderAcc.set(orderReference, acc);
      orderOrder.push(orderReference);
    }
    if (entry.type === 'hold') {
      acc.hold += entry.amount.amount;
      acc.hasHoldEntry = true;
    } else if (entry.type === 'release') {
      acc.release += entry.amount.amount;
    } else {
      acc.consume += entry.amount.amount;
    }
  }

  const byOrder: OrderExposure[] = orderOrder.map((orderReference) => {
    const acc = byOrderAcc.get(orderReference)!;
    const exposure = acc.hold - acc.release;
    const openExposure = Math.min(acc.consume, exposure);
    const activeHold = exposure - openExposure;
    return { orderReference, exposure, openExposure, activeHold, hasHoldEntry: acc.hasHoldEntry };
  });

  const committedExposure = byOrder.reduce((sum, order) => sum + order.exposure, 0);
  const activeHolds = byOrder.reduce((sum, order) => sum + order.activeHold, 0);
  const openExposure = byOrder.reduce((sum, order) => sum + order.openExposure, 0);

  return { byOrder, committedExposure, activeHolds, openExposure };
}
