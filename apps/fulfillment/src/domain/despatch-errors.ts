// The domain error of the `DespatchAdvice` aggregate root — mirrors
// `stock-errors.ts`'s shape.
import { DomainError } from '@otc/shared-kernel';

/** F6 — a `DespatchAdvice` must have at least one line. Defensive: the only caller, `order-despatch.ts`'s `createDespatchForOrder`, never invokes `DespatchAdvice.create` with an empty line list (it returns `{ kind: 'no_reservations' }` first), so this guards the aggregate's own invariant against a future caller that forgets to check. */
export class EmptyDespatchLinesError extends DomainError {
  readonly code = 'EMPTY_DESPATCH_LINES';

  constructor(readonly orderReference: string) {
    super(
      `despatch advice for order ${orderReference}: must have at least one line (invariant F6)`,
    );
  }
}
