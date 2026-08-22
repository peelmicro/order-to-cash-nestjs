// Application-layer error of `DespatchCreationHandler` — a refusal raised
// above the domain (the order-scoped precondition R36 names — "the order
// holds no reservation in status reserved") but not itself a violation of a
// domain invariant. Same shape `stock-application-errors.ts` established: a
// stable `code`, translated by `rpc-error-mapper.ts` alongside the domain
// errors of `domain/despatch-errors.ts` and `domain/stock-errors.ts`.
export abstract class DespatchApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * `despatch.create` — the order holds no reservation in status `reserved`:
 * either it was never reserved at all, or every reservation was released
 * (compensation already ran). R36's second half: "create no despatch advice
 * and emit no fact" — a business precondition failure, not a silent
 * no-op, because (unlike `stock.release`'s F5) there is no sensible empty
 * despatch to reply with. Distinguished from the F8 idempotent-repeat case
 * (which returns the EXISTING despatch, not this error) by
 * `DespatchCreationHandler` checking `despatches` before raising it — see
 * `despatch-creation.handler.ts`.
 */
export class NoReservedStockForDespatchError extends DespatchApplicationError {
  readonly code = 'NO_RESERVED_STOCK_FOR_DESPATCH';

  constructor(readonly orderReference: string) {
    super(
      `despatch.create: order ${orderReference} holds no reservation in status "reserved" — nothing to despatch`,
    );
  }
}
