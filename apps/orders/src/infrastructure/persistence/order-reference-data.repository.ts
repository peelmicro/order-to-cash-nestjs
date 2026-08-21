// The Drizzle adapter for `OrderReferenceDataPort` — resolves the business
// codes an `orders.create` request carries against the reference tables
// (`retailers`, `companies`, `currencies`, `products`), the same tables
// `DrizzleOrderRepository.save` resolves internally, but as a read
// performed BEFORE the placing transaction opens (see the port's own header
// comment for why).
import { eq, inArray } from 'drizzle-orm';
import { GLN, Money } from '@otc/shared-kernel';
import type {
  OrderReferenceData,
  OrderReferenceDataInput,
  OrderReferenceDataPort,
  ProductReference,
} from '../../application/ports/order-reference-data.port';
import type { OrdersDb } from './client';
import { companies, currencies, products, retailers } from './schema';

export class DrizzleOrderReferenceDataRepository implements OrderReferenceDataPort {
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
}
