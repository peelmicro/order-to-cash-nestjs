// The `@nestjs/cqrs` `@Saga` construct (design.md §5.5, §9) — the
// IN-MEMORY FAST PATH over the durable `saga_commands` guarantee (§6.3,
// §6.4). One `@Saga()` method merges five `ofType` streams, each a pure
// `map` from a dispatch-owed event to its `Issue…Command`. Each branch is
// wrapped with the standard RxJS "resubscribe on error" recipe
// (`catchError((_, caught) => caught)`) — a cqrs saga stream that errors
// terminates its subscription to the GLOBAL event stream silently, which
// would otherwise stop this saga from ever dispatching another command for
// the lifetime of the process. Even that failure mode is absorbed by the
// sweeper (design.md §6.4): a crash here still leaves the durable pending
// row for a later sweep cycle to issue.
import { Injectable, Optional } from '@nestjs/common';
import { ofType, Saga, type ICommand, type IEvent } from '@nestjs/cqrs';
import { merge, type Observable } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import {
  IssueCreditHoldCommand,
  IssueDespatchCreateCommand,
  IssueInvoiceIssueCommand,
  IssueStockReleaseCommand,
  IssueStockReserveCommand,
} from '../commands/saga-dispatch.commands';
import {
  CreditRejectionRecorded,
  OrderConfirmed,
  OrderMarkedDespatched,
  OrderMarkedStockReserved,
  OrderPlacedFactRecorded,
} from '../events/saga-dispatch.events';

export interface OrderSagasLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: OrderSagasLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

/** Wraps one already-mapped branch so an error thrown anywhere in it (typically inside `map`) resubscribes to the SAME piped source instead of letting the error propagate and unsubscribe the branch forever. */
function resilient<T>(branch: Observable<T>, label: string, logger: OrderSagasLogger): Observable<T> {
  return branch.pipe(
    catchError((error: unknown, caught) => {
      logger.error(`order.sagas: ${label} branch threw — resubscribing, no command lost from durability`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return caught;
    }),
  );
}

@Injectable()
export class OrderSagas {
  private readonly logger: OrderSagasLogger;

  // `@Optional()` — see saga-command-sweeper.service.ts's constructor
  // comment: without it, Nest's container would try (and fail) to resolve
  // an interface-typed parameter with no registered provider at bootstrap.
  constructor(@Optional() logger: OrderSagasLogger = CONSOLE_LOGGER) {
    this.logger = logger ?? CONSOLE_LOGGER;
  }

  @Saga()
  dispatchOwedCommands = (events$: Observable<IEvent>): Observable<ICommand> => {
    const stockReserve = resilient(
      events$.pipe(
        ofType(OrderPlacedFactRecorded),
        map((event) => new IssueStockReserveCommand(event.orderId)),
      ),
      'stock.reserve',
      this.logger,
    );

    const creditHold = resilient(
      events$.pipe(
        ofType(OrderMarkedStockReserved),
        map((event) => new IssueCreditHoldCommand(event.orderId)),
      ),
      'credit.hold',
      this.logger,
    );

    const stockRelease = resilient(
      events$.pipe(
        ofType(CreditRejectionRecorded),
        map((event) => new IssueStockReleaseCommand(event.orderId)),
      ),
      'stock.release',
      this.logger,
    );

    const despatchCreate = resilient(
      events$.pipe(
        ofType(OrderConfirmed),
        map((event) => new IssueDespatchCreateCommand(event.orderId)),
      ),
      'despatch.create',
      this.logger,
    );

    const invoiceIssue = resilient(
      events$.pipe(
        ofType(OrderMarkedDespatched),
        map((event) => new IssueInvoiceIssueCommand(event.orderId)),
      ),
      'invoice.issue',
      this.logger,
    );

    return merge(stockReserve, creditHold, stockRelease, despatchCreate, invoiceIssue);
  };
}
