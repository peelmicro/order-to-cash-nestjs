// packages/shared-kernel — the only shared runtime code besides
// packages/contracts (CLAUDE.md § Non-negotiables). Zero runtime
// dependencies. Pure TypeScript, copied verbatim per service, never a
// runtime dependency edge between services.
//
// This barrel is the deliberate public surface: everything a consuming
// service needs, nothing internal (e.g. the abstract `BusinessReference`
// base class stays private to business-reference.ts).

export { DomainError } from './domain/domain-error.js';

export { UniqueId, InvalidUniqueIdError } from './domain/unique-id.js';

export { Quantity, InvalidQuantityError } from './domain/quantity.js';

export {
  Money,
  InvalidMoneyAmountError,
  InvalidCurrencyCodeError,
  CurrencyMismatchError,
} from './domain/money.js';

export { GLN, InvalidGlnError } from './domain/gln.js';

export {
  OrderNumber,
  DespatchReference,
  InvoiceReference,
  CreditLineReference,
  InvalidBusinessReferenceError,
} from './domain/business-reference.js';

export { Entity } from './domain/entity.js';

export { AggregateRoot } from './domain/aggregate-root.js';

export type {
  DomainEventEnvelope,
  CreateDomainEventParams,
} from './domain/event-envelope.js';
export {
  createDomainEvent,
  assertValidDomainEventEnvelope,
  InvalidDomainEventEnvelopeError,
} from './domain/event-envelope.js';
