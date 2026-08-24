import { describe, expect, it } from 'vitest';
import { resolveNotificationSenderBinding } from './mailtrap.config';

const VALID_MAILTRAP_ENV = {
  MAILTRAP_HOST: 'sandbox.smtp.mailtrap.io',
  MAILTRAP_PORT: '2525',
  MAILTRAP_USER: 'real-user',
  MAILTRAP_PASSWORD: 'real-password',
  MAILTRAP_FROM_EMAIL: 'no-reply@order-to-cash.example',
};

describe('resolveNotificationSenderBinding', () => {
  it('binds console when MAILTRAP_USER/MAILTRAP_PASSWORD are both unset', () => {
    expect(resolveNotificationSenderBinding({})).toEqual({ kind: 'console' });
  });

  it('binds console when MAILTRAP_USER/MAILTRAP_PASSWORD are both the .env.example placeholder', () => {
    expect(
      resolveNotificationSenderBinding({ MAILTRAP_USER: 'replace_me', MAILTRAP_PASSWORD: 'replace_me' }),
    ).toEqual({ kind: 'console' });
  });

  it('binds Mailtrap when a complete, valid-looking credential pair is configured', () => {
    const binding = resolveNotificationSenderBinding(VALID_MAILTRAP_ENV);

    expect(binding.kind).toBe('mailtrap');
    if (binding.kind === 'mailtrap') {
      expect(binding.config).toEqual({
        host: 'sandbox.smtp.mailtrap.io',
        port: 2525,
        user: 'real-user',
        password: 'real-password',
        fromEmail: 'no-reply@order-to-cash.example',
      });
    }
  });

  it('fails fast (throws) on a PARTIAL credential pair — user set, password missing', () => {
    expect(() => resolveNotificationSenderBinding({ MAILTRAP_USER: 'real-user' })).toThrow(
      /must both be set/,
    );
  });

  it('fails fast (throws) on a PARTIAL credential pair — password set, user still the placeholder', () => {
    expect(() =>
      resolveNotificationSenderBinding({ MAILTRAP_USER: 'replace_me', MAILTRAP_PASSWORD: 'real-password' }),
    ).toThrow(/must both be set/);
  });

  it('fails fast (throws) when credentials are configured but MAILTRAP_HOST is missing', () => {
    const { MAILTRAP_HOST, ...rest } = VALID_MAILTRAP_ENV;
    void MAILTRAP_HOST;
    expect(() => resolveNotificationSenderBinding(rest)).toThrow(/MAILTRAP_HOST/);
  });

  it('fails fast (throws) when MAILTRAP_PORT is not a positive integer', () => {
    expect(() => resolveNotificationSenderBinding({ ...VALID_MAILTRAP_ENV, MAILTRAP_PORT: 'not-a-number' })).toThrow(
      /MAILTRAP_PORT/,
    );
  });
});
