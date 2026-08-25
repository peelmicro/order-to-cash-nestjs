// PR27 › routes every fact through ONE ProjectFactCommand on the CommandBus
// and delegates without branching on eventType.
import { describe, expect, it, vi } from 'vitest';
import { orderCancelledEnvelope, orderPlacedEnvelope, stockReservedEnvelope } from '../../test-support/envelope-fixtures';
import { ProjectFactCommand } from './project-fact.command';
import { ProjectFactCommandHandler } from './project-fact.command-handler';

describe('ProjectFactCommandHandler', () => {
  it('delegates to ProjectionApplyService.apply(envelope) with no branching on eventType', async () => {
    const apply = vi.fn(async () => 'processed' as const);
    const handler = new ProjectFactCommandHandler({ apply } as never);

    for (const envelope of [orderPlacedEnvelope(), stockReservedEnvelope(), orderCancelledEnvelope()]) {
      const outcome = await handler.execute(new ProjectFactCommand(envelope));
      expect(outcome).toBe('processed');
      expect(apply).toHaveBeenLastCalledWith(envelope);
    }

    expect(apply).toHaveBeenCalledTimes(3);
  });
});
