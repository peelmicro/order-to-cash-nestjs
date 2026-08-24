// The seven notified facts (feature 23's scope), one Command class each —
// same "envelope-carrying Command, one CommandHandler each" shape
// apps/orders/src/application/commands/saga-fact.commands.ts establishes
// for its ten. `notifyCommandFor` is this service's `factCommandFor`
// equivalent: it is how notification-facts.controller.ts tells "one of the
// seven notified facts" apart from every other fact on the same three
// topics (order.despatched.v1's siblings stock.reserved.v1/credit.approved.v1/
// etc. — none of those seven are notified; NO command, NO dedup row, exactly
// SO2's "self-produced facts" branch in saga-facts.controller.ts, same
// reasoning, different membership).
import type { ICommand } from '@nestjs/cqrs';
import type { Envelope } from '@otc/contracts';

export class NotifyOrderPlacedCommand implements ICommand {
  constructor(public readonly envelope: Envelope) {}
}

export class NotifyOrderConfirmedCommand implements ICommand {
  constructor(public readonly envelope: Envelope) {}
}

export class NotifyOrderDespatchedCommand implements ICommand {
  constructor(public readonly envelope: Envelope) {}
}

export class NotifyInvoiceIssuedCommand implements ICommand {
  constructor(public readonly envelope: Envelope) {}
}

export class NotifyPaymentReceivedCommand implements ICommand {
  constructor(public readonly envelope: Envelope) {}
}

export class NotifyOrderCompletedCommand implements ICommand {
  constructor(public readonly envelope: Envelope) {}
}

export class NotifyOrderCancelledCommand implements ICommand {
  constructor(public readonly envelope: Envelope) {}
}

export type NotifyCommand =
  | NotifyOrderPlacedCommand
  | NotifyOrderConfirmedCommand
  | NotifyOrderDespatchedCommand
  | NotifyInvoiceIssuedCommand
  | NotifyPaymentReceivedCommand
  | NotifyOrderCompletedCommand
  | NotifyOrderCancelledCommand;

type NotifyCommandCtor = new (envelope: Envelope) => NotifyCommand;

const NOTIFY_COMMAND_FOR: Readonly<Record<string, NotifyCommandCtor>> = {
  'order.placed.v1': NotifyOrderPlacedCommand,
  'order.confirmed.v1': NotifyOrderConfirmedCommand,
  'order.despatched.v1': NotifyOrderDespatchedCommand,
  'invoice.issued.v1': NotifyInvoiceIssuedCommand,
  'payment.received.v1': NotifyPaymentReceivedCommand,
  'order.completed.v1': NotifyOrderCompletedCommand,
  'order.cancelled.v1': NotifyOrderCancelledCommand,
};

/** `undefined` for every fact type this service does not notify on (SO2-equivalent branch — see this file's header). */
export function notifyCommandFor(eventType: string): NotifyCommandCtor | undefined {
  return NOTIFY_COMMAND_FOR[eventType];
}
