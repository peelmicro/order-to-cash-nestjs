// The ten fact commands (design.md §3.3, §5.5) — one per consumed fact
// event type, each carrying the parsed envelope. `factCommandFor` is the
// module-scope map the presentation controller routes through: the three
// self-produced facts map to nothing (SO2 — no `CommandBus` dispatch at
// all), and every other event type is a producer bug the controller logs
// and acknowledges (design.md §3.3).
import { Command } from '@nestjs/cqrs';
import type { Envelope } from '@otc/contracts';
import type { SagaFactResult } from '../saga-fact-handler.js';

export class HandleOrderPlacedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export class HandleStockReservedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export class HandleStockRejectedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export class HandleCreditApprovedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export class HandleCreditRejectedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export class HandleStockReleasedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export class HandleOrderDespatchedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export class HandleInvoiceIssuedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export class HandlePaymentReceivedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export class HandleCreditReleasedFactCommand extends Command<SagaFactResult> {
  constructor(readonly envelope: Envelope) {
    super();
  }
}

export type FactCommandConstructor = new (envelope: Envelope) => Command<SagaFactResult>;

const FACT_COMMAND_BY_EVENT_TYPE: Readonly<Record<string, FactCommandConstructor>> = {
  'order.placed.v1': HandleOrderPlacedFactCommand,
  'stock.reserved.v1': HandleStockReservedFactCommand,
  'stock.rejected.v1': HandleStockRejectedFactCommand,
  'credit.approved.v1': HandleCreditApprovedFactCommand,
  'credit.rejected.v1': HandleCreditRejectedFactCommand,
  'stock.released.v1': HandleStockReleasedFactCommand,
  'order.despatched.v1': HandleOrderDespatchedFactCommand,
  'invoice.issued.v1': HandleInvoiceIssuedFactCommand,
  'payment.received.v1': HandlePaymentReceivedFactCommand,
  'credit.released.v1': HandleCreditReleasedFactCommand,
};

/** `undefined` for the three self-produced facts (and anything else this service does not consume) — the caller's cue to acknowledge without dispatching (SO2). */
export function factCommandFor(eventType: string): FactCommandConstructor | undefined {
  return FACT_COMMAND_BY_EVENT_TYPE[eventType];
}
