import { describe, expect, it } from 'vitest';

import * as sharedKernel from './index.js';

describe('shared-kernel public barrel', () => {
  it('exports exactly the deliberate public surface', () => {
    expect(Object.keys(sharedKernel).sort()).toEqual(
      [
        'AggregateRoot',
        'CreditLineReference',
        'CurrencyMismatchError',
        'DespatchReference',
        'DomainError',
        'Entity',
        'GLN',
        'InvalidBusinessReferenceError',
        'InvalidCurrencyCodeError',
        'InvalidDomainEventEnvelopeError',
        'InvalidGlnError',
        'InvalidMoneyAmountError',
        'InvalidQuantityError',
        'InvalidUniqueIdError',
        'InvoiceReference',
        'Money',
        'OrderNumber',
        'Quantity',
        'UniqueId',
        'assertValidDomainEventEnvelope',
        'createDomainEvent',
      ].sort(),
    );
  });

  it('the exported classes are usable end to end through the barrel alone', () => {
    const orderId = sharedKernel.UniqueId.generate();
    const money = sharedKernel.Money.of(124_299, 'EUR');
    const quantity = sharedKernel.Quantity.of(2);

    expect(money.multiply(quantity).amount).toBe(248_598);
    expect(money.mod100()).toBe(99);
    expect(orderId.equals(sharedKernel.UniqueId.from(orderId.value))).toBe(true);
  });
});
