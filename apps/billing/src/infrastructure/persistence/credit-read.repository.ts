// The `CreditReadPort` adapter (design.md §7.2) — the `QueryBus` side: no
// lock, no transaction, no mutation. Three queries: the page of `credits`,
// a `COUNT(*)` for `PageInfo.total`, and one grouped read of `credit_items`
// restricted to the page's `credit_id IN (…)`. The three amounts of each
// `CreditView` are then folded through the SAME `summariseLedger` the
// aggregate uses (BC6) — one implementation, two callers.
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { CreditListReplyPayload, CreditListRequestPayload, CreditView } from '@otc/contracts';
import type { CreditReadPort } from '../../application/ports/credit-read.port';
import { summariseLedger } from '../../domain/credit-exposure';
import type { CreditLedgerEntrySnapshot } from '../../domain/credit-ledger-entry';
import type { BillingDb } from './client';
import { creditItems, credits } from './schema';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;

function syntheticEntry(orderReference: string, amount: number, type: 'hold' | 'consume' | 'release', currency: string): CreditLedgerEntrySnapshot {
  return {
    id: UniqueId.generate(),
    orderReference: OrderNumber.of(orderReference),
    amount: Money.of(amount, currency),
    type,
    entryDate: new Date(0),
  };
}

interface GroupedRow {
  creditId: string;
  orderReference: string;
  sumHold: number;
  sumConsume: number;
  sumRelease: number;
}

export class DrizzleCreditReadRepository implements CreditReadPort {
  constructor(private readonly db: BillingDb) {}

  async list(query: CreditListRequestPayload): Promise<CreditListReplyPayload> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const conditions = [];
    if (query.retailerCode !== undefined) {
      conditions.push(eq(credits.retailerCode, query.retailerCode));
    }
    if (query.companyCode !== undefined) {
      conditions.push(eq(credits.companyCode, query.companyCode));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(credits)
        .where(where)
        .orderBy(credits.retailerCode, credits.companyCode)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(credits).where(where),
    ]);

    const pageInfo = { page, pageSize, total: totalRows[0]?.total ?? 0 };
    if (rows.length === 0) {
      return { items: [], page: pageInfo };
    }

    const creditIds = rows.map((row) => row.id);
    const groupedRows: GroupedRow[] = await this.db
      .select({
        creditId: creditItems.creditId,
        orderReference: creditItems.orderReference,
        sumHold: sql<number>`COALESCE(SUM(CASE WHEN ${creditItems.type} = 'hold' THEN ${creditItems.amount} ELSE 0 END), 0)`,
        sumConsume: sql<number>`COALESCE(SUM(CASE WHEN ${creditItems.type} = 'consume' THEN ${creditItems.amount} ELSE 0 END), 0)`,
        sumRelease: sql<number>`COALESCE(SUM(CASE WHEN ${creditItems.type} = 'release' THEN ${creditItems.amount} ELSE 0 END), 0)`,
      })
      .from(creditItems)
      .where(inArray(creditItems.creditId, creditIds))
      .groupBy(creditItems.creditId, creditItems.orderReference);

    const groupedByCreditId = new Map<string, GroupedRow[]>();
    for (const row of groupedRows) {
      const bucket = groupedByCreditId.get(row.creditId);
      if (bucket) {
        bucket.push(row);
      } else {
        groupedByCreditId.set(row.creditId, [row]);
      }
    }

    const items: CreditView[] = rows.map((row) => {
      const groups = groupedByCreditId.get(row.id) ?? [];
      const entries: CreditLedgerEntrySnapshot[] = groups.flatMap((group) => {
        const list: CreditLedgerEntrySnapshot[] = [];
        const hold = Number(group.sumHold);
        const consume = Number(group.sumConsume);
        const release = Number(group.sumRelease);
        if (hold > 0) list.push(syntheticEntry(group.orderReference, hold, 'hold', row.currencyCode));
        if (consume > 0) list.push(syntheticEntry(group.orderReference, consume, 'consume', row.currencyCode));
        if (release > 0) list.push(syntheticEntry(group.orderReference, release, 'release', row.currencyCode));
        return list;
      });
      const summary = summariseLedger(entries);
      const availableCredit = row.creditLimit - summary.committedExposure;

      return {
        creditCode: row.code,
        retailerCode: row.retailerCode,
        companyCode: row.companyCode,
        currency: row.currencyCode,
        creditLimit: row.creditLimit,
        activeHolds: summary.activeHolds,
        openExposure: summary.openExposure,
        availableCredit,
      };
    });

    return { items, page: pageInfo };
  }
}
