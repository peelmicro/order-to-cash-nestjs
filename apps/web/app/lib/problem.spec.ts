import { describe, expect, it } from 'vitest';
import { describeFetchError, problemFromFetchError } from './problem';

/**
 * The real, live-confirmed shape a proxied route's error takes once it
 * passes through Nitro's own default error handler — see `problem.ts`'s own
 * header comment for the full derivation and the verbatim `curl` proof.
 */
function nitroWrappedFetchError(problem: Record<string, unknown>): { data: unknown } {
  return {
    data: {
      error: true,
      url: 'http://localhost:3010/api/orders/not-a-uuid',
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Bad Request',
      data: problem,
    },
  };
}

describe('problemFromFetchError', () => {
  it('extracts the real Problem document from the Nitro-double-wrapped FetchError shape (the actual shape this app produces)', () => {
    const error = nitroWrappedFetchError({
      type: 'about:blank',
      title: 'The request was malformed or failed schema validation',
      status: 400,
      detail: '"not-a-uuid" is not a valid order id',
      code: 'VALIDATION_FAILED',
    });

    const problem = problemFromFetchError(error);
    expect(problem?.detail).toBe('"not-a-uuid" is not a valid order id');
    expect(problem?.code).toBe('VALIDATION_FAILED');
  });

  it('falls back to a flat (non-double-wrapped) Problem if a caller is ever given one', () => {
    const error = { data: { title: 'No such invoice', detail: 'No invoice with that id', code: 'NOT_FOUND' } };
    const problem = problemFromFetchError(error);
    expect(problem?.detail).toBe('No invoice with that id');
  });

  it('returns undefined for a shape that is not a Problem at all', () => {
    expect(problemFromFetchError({ data: { some: 'unrelated shape' } })).toBeUndefined();
    expect(problemFromFetchError(null)).toBeUndefined();
    expect(problemFromFetchError(undefined)).toBeUndefined();
    expect(problemFromFetchError('not even an object')).toBeUndefined();
  });
});

describe('describeFetchError', () => {
  it('prefers detail over title, and the fallback only when neither is present — proving the server\'s own reason reaches the caller instead of a generic fallback', () => {
    expect(describeFetchError(nitroWrappedFetchError({ detail: 'Insufficient stock at acceptance for PRD-0001', title: 'Insufficient stock' }), 'fallback')).toBe(
      'Insufficient stock at acceptance for PRD-0001',
    );
    expect(describeFetchError(nitroWrappedFetchError({ title: 'Insufficient stock' }), 'fallback')).toBe('Insufficient stock');
    expect(describeFetchError(nitroWrappedFetchError({}), 'fallback')).toBe('fallback');
    expect(describeFetchError(new Error('network down'), 'fallback')).toBe('fallback');
  });
});
