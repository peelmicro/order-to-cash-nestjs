// The Drizzle adapter for `OrderReferenceDataPort` — resolves the business
// codes an `orders.create` request carries against the reference tables
// (`retailers`, `companies`, `currencies`, `products`), the same tables
// `DrizzleOrderRepository.save` resolves internally, but as a read
// performed BEFORE the placing transaction opens (see the port's own header
// comment for why).
//
// `orders_catalog_responder`: this class ALSO implements
// `CatalogReferenceListPort` (`list(...)`) — the read-only "give me the
// whole catalogue" counterpart to `resolve(...)`'s "give me these specific
// codes". Same `OrdersDb` connection, same four tables, same file: see
// `catalog-reference-list.port.ts`'s header for why this is one class
// implementing two ports rather than two independent repositories.
import { eq, inArray } from 'drizzle-orm';
import { GLN, Money } from '@otc/shared-kernel';
import type { CatalogReferenceListReplyPayload, Party, Product } from '@otc/contracts';
import {
  ALL_CATALOG_KINDS,
  type CatalogReferenceListInput,
  type CatalogReferenceListPort,
} from '../../application/ports/catalog-reference-list.port';
import type {
  OrderReferenceData,
  OrderReferenceDataInput,
  OrderReferenceDataPort,
  ProductReference,
} from '../../application/ports/order-reference-data.port';
import type { OrdersDb } from './client';
import { companies, currencies, products, retailers } from './schema';

export class DrizzleOrderReferenceDataRepository implements OrderReferenceDataPort, CatalogReferenceListPort {
  constructor(private readonly db: OrdersDb) {}

  async resolve(input: OrderReferenceDataInput): Promise<OrderReferenceData> {
    const uniqueProductCodes = [...new Set(input.productCodes)];

    const [retailerRows, companyRows, currencyRows, productRows] = await Promise.all([
      this.db
        .select({ code: retailers.code, gln: retailers.gln })
        .from(retailers)
        .where(eq(retailers.code, input.retailerCode))
        .limit(1),
      this.db
        .select({ code: companies.code, gln: companies.gln })
        .from(companies)
        .where(eq(companies.code, input.companyCode))
        .limit(1),
      this.db.select({ code: currencies.code }).from(currencies).where(eq(currencies.code, input.currency)).limit(1),
      uniqueProductCodes.length > 0
        ? this.db
            .select({
              code: products.code,
              description: products.description,
              price: products.price,
              currencyCode: currencies.code,
            })
            .from(products)
            .innerJoin(currencies, eq(products.currencyId, currencies.id))
            .where(inArray(products.code, uniqueProductCodes))
        : Promise.resolve([]),
    ]);

    const productMap = new Map<string, ProductReference>(
      productRows.map((row) => [
        row.code,
        {
          productCode: row.code,
          description: row.description,
          price: Money.of(row.price, row.currencyCode),
        },
      ]),
    );

    return {
      retailer: retailerRows[0] ? { code: retailerRows[0].code, gln: GLN.of(retailerRows[0].gln) } : null,
      company: companyRows[0] ? { code: companyRows[0].code, gln: GLN.of(companyRows[0].gln) } : null,
      currencyExists: currencyRows.length > 0,
      products: productMap,
    };
  }

  // `CatalogReferenceListPort.list` — "only the requested collections are
  // present" (asyncapi.yaml `CatalogReferenceListReplyPayload`'s own
  // description): a key is set on the reply ONLY for a requested `kind`,
  // never as an empty array for one that was not asked for — the Gateway's
  // `CatalogController` reads `reply.products ?? []` etc., so an omitted
  // key and an empty array both degrade gracefully there, but only the
  // omitted-key shape matches the documented contract exactly.
  async list(input: CatalogReferenceListInput): Promise<CatalogReferenceListReplyPayload> {
    const kinds = input.kinds.length > 0 ? input.kinds : ALL_CATALOG_KINDS;
    const reply: CatalogReferenceListReplyPayload = {};

    if (kinds.includes('products')) {
      reply.products = await this.listProducts(input.includeDisabled);
    }
    if (kinds.includes('retailers')) {
      reply.retailers = await this.listParties(retailers, input.includeDisabled);
    }
    if (kinds.includes('companies')) {
      reply.companies = await this.listParties(companies, input.includeDisabled);
    }
    if (kinds.includes('currencies')) {
      reply.currencies = await this.db
        .select({ code: currencies.code, isoNumber: currencies.isoNumber, symbol: currencies.symbol, decimalPoints: currencies.decimalPoints })
        .from(currencies);
    }

    return reply;
  }

  // Reference tables at this scale (a seeded catalogue, not transactional
  // data) — filtering `enabled`/`disabled` in application code after one
  // unconditional SELECT is simpler and just as correct as composing a
  // conditional Drizzle `.where()`, and keeps this method (and its
  // `retailers`/`companies` sibling below) readable.
  private async listProducts(includeDisabled: boolean): Promise<Product[]> {
    const rows = await this.db
      .select({
        code: products.code,
        ean: products.ean,
        name: products.name,
        description: products.description,
        price: products.price,
        currencyCode: currencies.code,
        disabledAt: products.disabledAt,
      })
      .from(products)
      .innerJoin(currencies, eq(products.currencyId, currencies.id));

    return rows
      .filter((row) => includeDisabled || row.disabledAt === null)
      .map((row) => ({
        code: row.code,
        ean: row.ean,
        name: row.name,
        description: row.description,
        price: row.price,
        currency: row.currencyCode,
        enabled: row.disabledAt === null,
      }));
  }

  // `retailers` and `companies` share an identical shape (companies.schema.ts's
  // own header: "same shape as `retailers` ... kept as a separate table
  // rather than a shared 'party' table" — no cross-context FK, CLAUDE.md §
  // Database per service), so one private helper serves both call sites
  // above rather than two near-duplicate methods.
  private async listParties(table: typeof retailers | typeof companies, includeDisabled: boolean): Promise<Party[]> {
    const rows = await this.db
      .select({
        code: table.code,
        name: table.name,
        country: table.country,
        vat: table.vat,
        gln: table.gln,
        currencyCode: currencies.code,
        disabledAt: table.disabledAt,
      })
      .from(table)
      .innerJoin(currencies, eq(table.currencyId, currencies.id));

    return rows
      .filter((row) => includeDisabled || row.disabledAt === null)
      .map((row) => ({
        code: row.code,
        name: row.name,
        country: row.country,
        vat: row.vat,
        gln: row.gln,
        currency: row.currencyCode,
        enabled: row.disabledAt === null,
      }));
  }
}
