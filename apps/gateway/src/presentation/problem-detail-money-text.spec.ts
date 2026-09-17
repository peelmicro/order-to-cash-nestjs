import type { ArgumentsHost } from '@nestjs/common';
import { RpcError } from '@otc/contracts';
import { formatMoney } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import { ProblemJsonExceptionFilter } from './problem-json.filter';
import { RpcBusinessError } from '../application/ports/rpc-client.port';

function fakeHost() {
  const json = vi.fn();
  const type = vi.fn().mockReturnValue({ json });
  const status = vi.fn().mockReturnValue({ type });
  const response = { status };
  const request = { correlationId: undefined };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

const clock = { now: () => new Date('2026-09-17T08:00:00.000Z') };

/**
 * Backlog id 102 (`problem_detail_money_reads_as_minor_units`) — a problem
 * document's `detail` can carry money, and `ProblemJsonExceptionFilter`
 * forwards an upstream RPC error's `message` to `detail` VERBATIM (see
 * `problem-json.filter.ts`'s `RpcBusinessError`/`RpcCallError` branches —
 * `detail: exception.message`, never rewritten).
 *
 * Fix round 1 correction (review defect E1): this file proves ONLY the
 * Gateway pass-through step (RPC error -> problem document `detail`), NOT
 * "the whole path" — that overstated claim is what let the reviewer's Q4
 * arm (a service mapper rebuilding a raw message) survive with this suite
 * fully green, because this file never calls the real `rpc-error-mapper.ts`.
 * The mapper hop itself is now proven separately, by the
 * `rpc-error-mapper — money text reaches the wire message` describe
 * blocks added to `apps/billing/src/presentation/rpc-error-mapper.spec.ts`
 * and `apps/orders/src/presentation/rpc-error-mapper.spec.ts`, each of
 * which constructs a real domain error and calls the real `toRpcError`.
 * The full chain is therefore: domain message
 * (`domain-error-money-text.spec.ts`, both services) -> service mapper
 * (`rpc-error-mapper.spec.ts`, both services) -> Gateway pass-through
 * (this file) — three separate proofs, no single one of which spans the
 * whole path alone.
 */
describe('ProblemJsonExceptionFilter — backlog id 102: detail renders money with the shared money-text formatter', () => {
  it('renders both amounts of an INVOICE_PAYMENT_AMOUNT_MISMATCH detail scaled by the currency exponent, never raw minor units', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status, json } = fakeHost();
    const message = `payment amount (${formatMoney(9245, 'EUR')}) does not match the invoice's totalAmount (${formatMoney(12000, 'EUR')}) (invariant B10)`;
    const rpcError: RpcError = { code: 'PRECONDITION_FAILED', message, details: { code: 'INVOICE_PAYMENT_AMOUNT_MISMATCH' } };

    filter.catch(new RpcBusinessError('billing.payment.register', rpcError), host);

    expect(status).toHaveBeenCalledWith(422);
    const body = json.mock.calls[0][0];
    expect(body.code).toBe('PAYMENT_MISMATCH');
    expect(body.detail).toBe("payment amount (92.45 EUR) does not match the invoice's totalAmount (120.00 EUR) (invariant B10)");
    expect(body.detail).not.toContain('9245');
    expect(body.detail).not.toContain('12000');
  });

  it('renders an ORDER_TOTAL_NEGATIVE detail scaled by the currency exponent, for a zero-exponent currency (JPY)', () => {
    const filter = new ProblemJsonExceptionFilter(clock);
    const { host, status, json } = fakeHost();
    const message = `total amount would be negative: ${formatMoney(-500000, 'JPY')}`;
    const rpcError: RpcError = { code: 'VALIDATION_FAILED', message, details: { code: 'ORDER_TOTAL_NEGATIVE' } };

    filter.catch(new RpcBusinessError('orders.create', rpcError), host);

    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0][0];
    expect(body.detail).toBe('total amount would be negative: -500 000 JPY');
    expect(body.detail).not.toContain('-500000');
  });
});
