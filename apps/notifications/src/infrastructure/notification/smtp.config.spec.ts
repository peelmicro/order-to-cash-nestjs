import { describe, expect, it } from 'vitest';
import { resolveNotificationSenderBinding } from './smtp.config';

const VALID_SMTP_ENV = {
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_USER: 'real-user',
  SMTP_PASSWORD: 'real-password',
  SMTP_FROM_EMAIL: 'no-reply@order-to-cash.example',
};

describe('resolveNotificationSenderBinding', () => {
  it('binds console when SMTP_USER/SMTP_PASSWORD are both unset', () => {
    expect(resolveNotificationSenderBinding({})).toEqual({ kind: 'console' });
  });

  it('binds console when SMTP_USER/SMTP_PASSWORD are both the .env.example placeholder', () => {
    expect(
      resolveNotificationSenderBinding({ SMTP_USER: 'replace_me', SMTP_PASSWORD: 'replace_me' }),
    ).toEqual({ kind: 'console' });
  });

  it('binds SMTP when a complete, valid-looking credential pair is configured', () => {
    const binding = resolveNotificationSenderBinding(VALID_SMTP_ENV);

    expect(binding.kind).toBe('smtp');
    if (binding.kind === 'smtp') {
      expect(binding.config).toEqual({
        host: 'localhost',
        port: 1025,
        user: 'real-user',
        password: 'real-password',
        fromEmail: 'no-reply@order-to-cash.example',
      });
    }
  });

  it('fails fast (throws) on a PARTIAL credential pair — user set, password missing', () => {
    expect(() => resolveNotificationSenderBinding({ SMTP_USER: 'real-user' })).toThrow(
      /must both be set/,
    );
  });

  it('fails fast (throws) on a PARTIAL credential pair — password set, user still the placeholder', () => {
    expect(() =>
      resolveNotificationSenderBinding({ SMTP_USER: 'replace_me', SMTP_PASSWORD: 'real-password' }),
    ).toThrow(/must both be set/);
  });

  it('fails fast (throws) when credentials are configured but SMTP_HOST is missing', () => {
    const { SMTP_HOST, ...rest } = VALID_SMTP_ENV;
    void SMTP_HOST;
    expect(() => resolveNotificationSenderBinding(rest)).toThrow(/SMTP_HOST/);
  });

  it('fails fast (throws) when SMTP_PORT is not a positive integer', () => {
    expect(() => resolveNotificationSenderBinding({ ...VALID_SMTP_ENV, SMTP_PORT: 'not-a-number' })).toThrow(
      /SMTP_PORT/,
    );
  });
});
