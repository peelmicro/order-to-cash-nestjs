// A minimal, valid `PlaceOrderInput` matching the reference rows
// `startOrdersTestFixture` seeds (`RET-0001`/`COM-0001`/`PRD-0001`/`EUR`) —
// shared by every relay integration spec so each one is not re-deriving it.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { PlaceOrderInput } from '../../../domain/order';
import {
  FIXTURE_COMPANY_CODE,
  FIXTURE_COMPANY_GLN,
  FIXTURE_CURRENCY,
  FIXTURE_PRODUCT_CODE,
  FIXTURE_RETAILER_CODE,
  FIXTURE_RETAILER_GLN,
} from '../../persistence/test-support/orders-test-fixture';

let sequence = 1;

export function placeOrderInput(overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return {
    id: UniqueId.generate(),
    orderReference: OrderNumber.fromSequence(sequence++),
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
    buyer: { gln: GLN.of(FIXTURE_RETAILER_GLN), code: FIXTURE_RETAILER_CODE },
    supplier: { gln: GLN.of(FIXTURE_COMPANY_GLN), code: FIXTURE_COMPANY_CODE },
    currency: FIXTURE_CURRENCY,
    lines: [
      {
        productCode: FIXTURE_PRODUCT_CODE,
        description: 'Widget',
        quantity: Quantity.of(2),
        unitPrice: Money.of(1_000, FIXTURE_CURRENCY),
        lineDiscount: Money.of(0, FIXTURE_CURRENCY),
      },
    ],
    ...overrides,
  };
}
