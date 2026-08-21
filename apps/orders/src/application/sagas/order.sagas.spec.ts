// Pure unit — a plain RxJS `Subject`, NO Nest runtime (design.md §5.5, §11,
// SO3's fast-path row). Proves the `@Saga` stream mapping (each of the
// five dispatch-owed events in -> its `Issue…Command` out, all five
// streams) and that an error thrown inside one branch's `map` does not
// terminate the merged subscription — a later event on ANY branch is still
// observed.
import { UniqueId } from '@otc/shared-kernel';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { ICommand, IEvent } from '@nestjs/cqrs';
import {
  IssueCreditHoldCommand,
  IssueDespatchCreateCommand,
  IssueInvoiceIssueCommand,
  IssueStockReleaseCommand,
  IssueStockReserveCommand,
} from '../commands/saga-dispatch.commands.js';
import {
  CreditRejectionRecorded,
  OrderConfirmed,
  OrderMarkedDespatched,
  OrderMarkedStockReserved,
  OrderPlacedFactRecorded,
} from '../events/saga-dispatch.events.js';
import { OrderSagas } from './order.sagas.js';

describe('OrderSagas — the @Saga stream mapping (design.md §5.5)', () => {
  function harness() {
    const events$ = new Subject<IEvent>();
    const sagas = new OrderSagas();
    const commands$ = sagas.dispatchOwedCommands(events$);
    const seen: ICommand[] = [];
    commands$.subscribe((command) => seen.push(command));
    return { events$, seen };
  }

  it('maps OrderPlacedFactRecorded -> IssueStockReserveCommand', () => {
    const { events$, seen } = harness();
    const orderId = UniqueId.generate().value;

    events$.next(new OrderPlacedFactRecorded(orderId, orderId));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(IssueStockReserveCommand);
    expect((seen[0] as IssueStockReserveCommand).orderId).toBe(orderId);
  });

  it('maps OrderMarkedStockReserved -> IssueCreditHoldCommand', () => {
    const { events$, seen } = harness();
    const orderId = UniqueId.generate().value;

    events$.next(new OrderMarkedStockReserved(orderId, orderId));

    expect(seen[0]).toBeInstanceOf(IssueCreditHoldCommand);
    expect((seen[0] as IssueCreditHoldCommand).orderId).toBe(orderId);
  });

  it('maps CreditRejectionRecorded -> IssueStockReleaseCommand', () => {
    const { events$, seen } = harness();
    const orderId = UniqueId.generate().value;

    events$.next(new CreditRejectionRecorded(orderId, orderId));

    expect(seen[0]).toBeInstanceOf(IssueStockReleaseCommand);
    expect((seen[0] as IssueStockReleaseCommand).orderId).toBe(orderId);
  });

  it('maps OrderConfirmed -> IssueDespatchCreateCommand', () => {
    const { events$, seen } = harness();
    const orderId = UniqueId.generate().value;

    events$.next(new OrderConfirmed(orderId, orderId));

    expect(seen[0]).toBeInstanceOf(IssueDespatchCreateCommand);
    expect((seen[0] as IssueDespatchCreateCommand).orderId).toBe(orderId);
  });

  it('maps OrderMarkedDespatched -> IssueInvoiceIssueCommand', () => {
    const { events$, seen } = harness();
    const orderId = UniqueId.generate().value;

    events$.next(new OrderMarkedDespatched(orderId, orderId));

    expect(seen[0]).toBeInstanceOf(IssueInvoiceIssueCommand);
    expect((seen[0] as IssueInvoiceIssueCommand).orderId).toBe(orderId);
  });

  it('an event with no mapped stream (e.g. an unrelated IEvent) produces no command', () => {
    const { events$, seen } = harness();

    events$.next({} as IEvent);

    expect(seen).toHaveLength(0);
  });

  it('survives a stream error thrown inside one branch — a later event on the SAME branch is still mapped (no-termination guard)', () => {
    const loggedErrors: Array<Record<string, unknown>> = [];
    const events$ = new Subject<IEvent>();
    const sagas = new OrderSagas({ error: (message, meta) => loggedErrors.push({ message, ...meta }) });
    const commands$ = sagas.dispatchOwedCommands(events$);
    const seen: ICommand[] = [];
    commands$.subscribe((command) => seen.push(command));

    // A real `OrderPlacedFactRecorded` whose `orderId` getter THROWS when
    // read — `ofType` still matches it (real `instanceof`), so the branch's
    // `map` callback synchronously throws when it dereferences `.orderId`.
    // RxJS's `map` turns that into an error notification on the branch's
    // observable, which the `catchError((_, caught) => caught)` wrapper
    // resubscribes to — a cqrs `@Saga` stream that does NOT do this would
    // have its subscription to the GLOBAL event stream torn down here,
    // silently losing every future command for the lifetime of the process
    // (design.md §5.5's header comment).
    const poisoned = new OrderPlacedFactRecorded('placeholder', 'placeholder');
    Object.defineProperty(poisoned, 'orderId', {
      get(): string {
        throw new Error('boom — simulated malformed event');
      },
    });
    events$.next(poisoned);

    expect(seen).toHaveLength(0);
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]?.message).toContain('stock.reserve');

    const orderId = UniqueId.generate().value;
    events$.next(new OrderPlacedFactRecorded(orderId, orderId));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(IssueStockReserveCommand);
    expect((seen[0] as IssueStockReserveCommand).orderId).toBe(orderId);
  });
});
