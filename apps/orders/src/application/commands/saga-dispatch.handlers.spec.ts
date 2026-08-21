// Pure unit — the dispatcher faked. Proves each `Issue…Command` handler
// claims + dispatches its `(orderId, command)` pending row via the
// dispatcher (design.md §5.5, §11).
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import type { DispatchesSagaCommands } from '../../infrastructure/saga/saga-command-dispatcher.js';
import {
  IssueCreditHoldCommand,
  IssueDespatchCreateCommand,
  IssueInvoiceIssueCommand,
  IssueStockReleaseCommand,
  IssueStockReserveCommand,
} from './saga-dispatch.commands.js';
import {
  IssueCreditHoldHandler,
  IssueDespatchCreateHandler,
  IssueInvoiceIssueHandler,
  IssueStockReleaseHandler,
  IssueStockReserveHandler,
} from './saga-dispatch.handlers.js';

function fakeDispatcher(): DispatchesSagaCommands & { dispatch: ReturnType<typeof vi.fn> } {
  return { dispatch: vi.fn().mockResolvedValue('sent') };
}

describe('saga-dispatch.handlers — each Issue…Command dispatches its (orderId, command) pair', () => {
  it('IssueStockReserveHandler dispatches stock.reserve for the command orderId', async () => {
    const dispatcher = fakeDispatcher();
    const orderId = UniqueId.generate();
    const handler = new IssueStockReserveHandler(dispatcher);

    await handler.execute(new IssueStockReserveCommand(orderId.value));

    expect(dispatcher.dispatch).toHaveBeenCalledWith(orderId, 'stock.reserve');
  });

  it('IssueCreditHoldHandler dispatches credit.hold', async () => {
    const dispatcher = fakeDispatcher();
    const orderId = UniqueId.generate();
    const handler = new IssueCreditHoldHandler(dispatcher);

    await handler.execute(new IssueCreditHoldCommand(orderId.value));

    expect(dispatcher.dispatch).toHaveBeenCalledWith(orderId, 'credit.hold');
  });

  it('IssueStockReleaseHandler dispatches stock.release (compensation path B)', async () => {
    const dispatcher = fakeDispatcher();
    const orderId = UniqueId.generate();
    const handler = new IssueStockReleaseHandler(dispatcher);

    await handler.execute(new IssueStockReleaseCommand(orderId.value));

    expect(dispatcher.dispatch).toHaveBeenCalledWith(orderId, 'stock.release');
  });

  it('IssueDespatchCreateHandler dispatches despatch.create', async () => {
    const dispatcher = fakeDispatcher();
    const orderId = UniqueId.generate();
    const handler = new IssueDespatchCreateHandler(dispatcher);

    await handler.execute(new IssueDespatchCreateCommand(orderId.value));

    expect(dispatcher.dispatch).toHaveBeenCalledWith(orderId, 'despatch.create');
  });

  it('IssueInvoiceIssueHandler dispatches invoice.issue', async () => {
    const dispatcher = fakeDispatcher();
    const orderId = UniqueId.generate();
    const handler = new IssueInvoiceIssueHandler(dispatcher);

    await handler.execute(new IssueInvoiceIssueCommand(orderId.value));

    expect(dispatcher.dispatch).toHaveBeenCalledWith(orderId, 'invoice.issue');
  });

  it('a stale/absent row (dispatcher reports noop) is a silent no-op from the handler’s point of view', async () => {
    const dispatcher = fakeDispatcher();
    dispatcher.dispatch.mockResolvedValue('noop');
    const orderId = UniqueId.generate();
    const handler = new IssueStockReserveHandler(dispatcher);

    await expect(handler.execute(new IssueStockReserveCommand(orderId.value))).resolves.toBeUndefined();
  });
});
