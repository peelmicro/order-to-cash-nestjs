// The `CreditLedgerEntry` child entity of `BuyerCredit` (domain-model.md
// §5.1, design.md §3.2) — one append-only row of the ledger `credit-exposure.ts`
// sums over. Mirrors `apps/fulfillment/src/domain/reservation.ts`'s shape,
// but simpler: there is no status machine here, only three IMMUTABLE facts
// (order, amount, type) recorded once. **B2 (append-only) is enforced by
// shape, not by a rule**: this class exposes no setter and no mutating
// method of any kind — the only way to "reverse" an entry is to append a
// NEW one of a different type (`releaseHold`), never to touch a loaded one.
//
// A non-positive amount and a currency other than the line's (**B3**) are
// checked by the AGGREGATE (design.md §3.2) — `BuyerCredit` is the only
// construction site and only ever passes an already-validated amount in
// the line's own currency, so this entity stays a plain, unconditional
// factory, the same shape `Reservation.create` uses.
import { Entity, type Money, type OrderNumber, type UniqueId } from '@otc/shared-kernel';

export const CREDIT_ENTRY_TYPES = ['hold', 'consume', 'release'] as const;
export type CreditEntryType = (typeof CREDIT_ENTRY_TYPES)[number];

export interface CreditLedgerEntrySnapshot {
  readonly id: UniqueId;
  readonly orderReference: OrderNumber;
  readonly amount: Money;
  readonly type: CreditEntryType;
  readonly entryDate: Date;
}

interface CreditLedgerEntryProps {
  readonly orderReference: OrderNumber;
  readonly amount: Money;
  readonly type: CreditEntryType;
  readonly entryDate: Date;
}

export class CreditLedgerEntry extends Entity<CreditLedgerEntry> {
  private constructor(
    id: UniqueId,
    private readonly props: CreditLedgerEntryProps,
  ) {
    super(id);
  }

  /** The only construction site for a NEW entry — always through `BuyerCredit`, never directly by infrastructure. */
  static create(input: {
    readonly id: UniqueId;
    readonly orderReference: OrderNumber;
    readonly amount: Money;
    readonly type: CreditEntryType;
    readonly entryDate: Date;
  }): CreditLedgerEntry {
    return new CreditLedgerEntry(input.id, {
      orderReference: input.orderReference,
      amount: input.amount,
      type: input.type,
      entryDate: input.entryDate,
    });
  }

  static reconstitute(snapshot: CreditLedgerEntrySnapshot): CreditLedgerEntry {
    return new CreditLedgerEntry(snapshot.id, {
      orderReference: snapshot.orderReference,
      amount: snapshot.amount,
      type: snapshot.type,
      entryDate: snapshot.entryDate,
    });
  }

  get orderReference(): OrderNumber {
    return this.props.orderReference;
  }

  get amount(): Money {
    return this.props.amount;
  }

  get type(): CreditEntryType {
    return this.props.type;
  }

  get entryDate(): Date {
    return this.props.entryDate;
  }

  toSnapshot(): CreditLedgerEntrySnapshot {
    return {
      id: this.id,
      orderReference: this.props.orderReference,
      amount: this.props.amount,
      type: this.props.type,
      entryDate: this.props.entryDate,
    };
  }
}
