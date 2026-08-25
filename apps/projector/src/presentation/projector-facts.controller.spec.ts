// PR3 › logs and acknowledges a malformed envelope without writing to the
// read model or publishing a signal. PR4 › logs and acknowledges an unknown
// eventType instead of discarding it silently. Both assert on a recording
// fake that the writer was NEVER CALLED (the attempt, not the residue —
// tasks.md's binding N10 rule).
import { CommandBus } from '@nestjs/cqrs';
import { describe, expect, it, vi } from 'vitest';
import { UnknownFactTypeError } from '../domain/fact-projection';
import { orderPlacedEnvelope } from '../test-support/envelope-fixtures';
import { ProjectorFactsController } from './projector-facts.controller';

function fakeCommandBus(behaviour: 'succeed' | 'throw-unknown-type' | 'throw-other'): { commandBus: CommandBus; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => {
    if (behaviour === 'throw-unknown-type') {
      throw new UnknownFactTypeError('bogus.fact.v1');
    }
    if (behaviour === 'throw-other') {
      throw new Error('mongo unreachable');
    }
    return 'processed';
  });
  return { commandBus: { execute } as unknown as CommandBus, execute };
}

describe('ProjectorFactsController', () => {
  it('PR3 › logs and acknowledges a malformed envelope without writing to the read model (CommandBus never called)', async () => {
    const { commandBus, execute } = fakeCommandBus('succeed');
    const logger = { error: vi.fn() };
    const controller = new ProjectorFactsController(commandBus, logger);

    // Missing required fields -> malformed.
    await expect(controller.onOrdersFact({ eventType: 'order.placed.v1' })).resolves.toBeUndefined();

    expect(execute).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toContain('malformed fact envelope');
  });

  it('PR4 › logs and acknowledges an unknown eventType instead of discarding it silently (CommandBus called once, no rethrow)', async () => {
    const { commandBus, execute } = fakeCommandBus('throw-unknown-type');
    const logger = { error: vi.fn() };
    const controller = new ProjectorFactsController(commandBus, logger);

    const envelope = orderPlacedEnvelope({ eventType: 'stock.teleported.v1' });
    await expect(controller.onFulfillmentFact(envelope)).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toContain('unknown eventType');
  });

  it('rethrows any OTHER command-bus failure so Kafka redelivers the fact', async () => {
    const { commandBus } = fakeCommandBus('throw-other');
    const logger = { error: vi.fn() };
    const controller = new ProjectorFactsController(commandBus, logger);

    await expect(controller.onBillingFact(orderPlacedEnvelope())).rejects.toThrow('mongo unreachable');
  });

  it('dispatches a well-formed, known fact to the CommandBus exactly once', async () => {
    const { commandBus, execute } = fakeCommandBus('succeed');
    const controller = new ProjectorFactsController(commandBus, { error: vi.fn() });

    await controller.onOrdersFact(orderPlacedEnvelope());

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
