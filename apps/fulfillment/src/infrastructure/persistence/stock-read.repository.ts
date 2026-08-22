// The `StockReadPort` adapter (design.md §7) — the `QueryBus` side: no
// lock, no transaction, no mutation. `availability` = one SELECT + per-line
// arithmetic, unknown product ⇒ `{ available: 0, sufficient: false }`
// (R31). `list` = `WHERE` from the optional filters, `belowThreshold` ⇒
// `units - reserved_units < low_stock_threshold` in SQL, ordered by
// `(company_code, product_code)`, paged, plus a `COUNT(*)` for
// `PageInfo.total`. Two queries, no transaction (FS15).
import { and, count, eq, inArray, lt, sql } from 'drizzle-orm';
import type {
  StockCheckReplyPayload,
  StockListReplyPayload,
  StockListRequestPayload,
  StockView,
} from '@otc/contracts';
import type { StockReadPort } from '../../application/ports/stock-read.port';
import type { FulfillmentDb } from './client';
import { stock } from './schema';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;

function toStockView(row: { companyCode: string; productCode: string; units: number; reservedUnits: number; lowStockThreshold: number }): StockView {
  return {
    companyCode: row.companyCode,
    productCode: row.productCode,
    units: row.units,
    reservedUnits: row.reservedUnits,
    availableUnits: row.units - row.reservedUnits,
    lowStockThreshold: row.lowStockThreshold,
  };
}

export class DrizzleStockReadRepository implements StockReadPort {
  constructor(private readonly db: FulfillmentDb) {}

  async availability(
    companyCode: string,
    lines: readonly { readonly productCode: string; readonly quantity: number }[],
  ): Promise<StockCheckReplyPayload> {
    const productCodes = [...new Set(lines.map((line) => line.productCode))];
    const rows =
      productCodes.length > 0
        ? await this.db
            .select({ productCode: stock.productCode, units: stock.units, reservedUnits: stock.reservedUnits })
            .from(stock)
            .where(and(eq(stock.companyCode, companyCode), inArray(stock.productCode, productCodes)))
        : [];
    const byProduct = new Map(rows.map((row) => [row.productCode, row]));

    const replyLines = lines.map((line) => {
      const row = byProduct.get(line.productCode);
      const available = row ? row.units - row.reservedUnits : 0;
      const sufficient = available >= line.quantity;
      return { productCode: line.productCode, requested: line.quantity, available, sufficient };
    });

    return { available: replyLines.every((line) => line.sufficient), lines: replyLines };
  }

  async list(query: StockListRequestPayload): Promise<StockListReplyPayload> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const conditions = [];
    if (query.companyCode !== undefined) {
      conditions.push(eq(stock.companyCode, query.companyCode));
    }
    if (query.productCode !== undefined) {
      conditions.push(eq(stock.productCode, query.productCode));
    }
    if (query.belowThreshold === true) {
      conditions.push(lt(sql`${stock.units} - ${stock.reservedUnits}`, stock.lowStockThreshold));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      this.db
        .select({
          companyCode: stock.companyCode,
          productCode: stock.productCode,
          units: stock.units,
          reservedUnits: stock.reservedUnits,
          lowStockThreshold: stock.lowStockThreshold,
        })
        .from(stock)
        .where(where)
        .orderBy(stock.companyCode, stock.productCode)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(stock).where(where),
    ]);

    return {
      items: rows.map(toStockView),
      page: { page, pageSize, total: totalRows[0]?.total ?? 0 },
    };
  }
}
