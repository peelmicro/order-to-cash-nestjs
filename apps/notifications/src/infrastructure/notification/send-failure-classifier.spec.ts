// Pure unit — no I/O, no framework. Proves the classification rule this
// file's implementation documents: SMTP `5xx` (or `EAUTH` with no
// response at all) is `'permanent'`; SMTP `4xx`, nodemailer's own
// connection-level error codes, and anything unrecognised are
// `'transient'`.
import { describe, expect, it } from 'vitest';
import { classifySendFailure } from './send-failure-classifier';

/** Shapes a fake error exactly the way nodemailer's `_formatError` does — `Error` plus `.code`/`.responseCode`/`.command`/`.response` (see this file's header). */
function nodemailerError(message: string, extra: { code?: string; responseCode?: number } = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe('classifySendFailure', () => {
  it('R-degrade — a real Mailtrap quota-exhausted rejection (535, EAUTH) classifies as permanent', () => {
    const error = nodemailerError(
      'Invalid login: 535 5.7.0 The email limit is reached. Please upgrade your plan https://mailtrap.io/billing/plans/testing',
      { code: 'EAUTH', responseCode: 535 },
    );

    expect(classifySendFailure(error)).toBe('permanent');
  });

  it('R-degrade — invalid credentials (535, EAUTH) classifies as permanent', () => {
    const error = nodemailerError('Invalid login: 535 5.7.8 Authentication failed', { code: 'EAUTH', responseCode: 535 });

    expect(classifySendFailure(error)).toBe('permanent');
  });

  it('R-degrade — EAUTH with no SMTP response at all (e.g. missing credentials) classifies as permanent', () => {
    const error = nodemailerError('Missing credentials for "PLAIN"', { code: 'EAUTH' });

    expect(classifySendFailure(error)).toBe('permanent');
  });

  it('R-degrade — a malformed/rejected recipient (550, EENVELOPE) classifies as permanent — any 5xx does, regardless of code', () => {
    const error = nodemailerError('Invalid recipient "not-an-email"', { code: 'EENVELOPE', responseCode: 550 });

    expect(classifySendFailure(error)).toBe('permanent');
  });

  it('R-degrade — an SMTP 4xx (mailbox temporarily unavailable) classifies as transient', () => {
    const error = nodemailerError('Mailbox temporarily unavailable', { code: 'EENVELOPE', responseCode: 450 });

    expect(classifySendFailure(error)).toBe('transient');
  });

  it('R-degrade — a socket error (ESOCKET, no response) classifies as transient', () => {
    const error = nodemailerError('socket hang up', { code: 'ESOCKET' });

    expect(classifySendFailure(error)).toBe('transient');
  });

  it('R-degrade — a connection timeout (ETIMEDOUT, no response) classifies as transient', () => {
    const error = nodemailerError('Connection timeout', { code: 'ETIMEDOUT' });

    expect(classifySendFailure(error)).toBe('transient');
  });

  it('R-degrade — a connection-refused error (ECONNECTION, no response) classifies as transient', () => {
    const error = nodemailerError('Connection refused', { code: 'ECONNECTION' });

    expect(classifySendFailure(error)).toBe('transient');
  });

  it('R-degrade — an unrecognised error (no code, no responseCode) defaults to transient, never permanent', () => {
    expect(classifySendFailure(new Error('something odd happened'))).toBe('transient');
  });

  it('R-degrade — a non-Error thrown value defaults to transient', () => {
    expect(classifySendFailure('a plain string')).toBe('transient');
    expect(classifySendFailure(undefined)).toBe('transient');
    expect(classifySendFailure({ notAnError: true })).toBe('transient');
  });
});
