import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLoginThrottleConfig } from './login-throttle.config';

describe('loadLoginThrottleConfig — POST /auth/login rate limit policy (openapi.yaml TooManyRequests)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to 10 attempts per 60s window when no env vars are set', () => {
    const config = loadLoginThrottleConfig({});

    expect(config.limit).toBe(10);
    expect(config.ttlMs).toBe(60000);
  });

  it('reads GATEWAY_LOGIN_RATE_LIMIT and GATEWAY_LOGIN_RATE_WINDOW_MS when set to valid positive integers', () => {
    const config = loadLoginThrottleConfig({ GATEWAY_LOGIN_RATE_LIMIT: '3', GATEWAY_LOGIN_RATE_WINDOW_MS: '5000' });

    expect(config.limit).toBe(3);
    expect(config.ttlMs).toBe(5000);
  });

  // Review finding F1 (progress/review_auth_rate_limit.md) — a bare
  // `Number(env.X ?? default)` let a non-numeric value through as `NaN`,
  // under which the real `ThrottlerGuard` never throttles at all (measured
  // by the reviewer: 25/25 requests returned 200). Every case below proves
  // the loader now rejects the malformed value, falls back to the
  // documented default, AND logs a structured warning naming the rejected
  // raw value — never a silent acceptance of `NaN`/zero/negative.
  describe('malformed GATEWAY_LOGIN_RATE_LIMIT — falls back to the default AND logs why (F1)', () => {
    it.each([
      ['"abc" — non-numeric', 'abc'],
      ['"0" — zero would brick login on the very first request', '0'],
      ['"" — empty string', ''],
      ['" " — a stray space', ' '],
      ['"-5" — negative would brick login on the very first request', '-5'],
      ['"3.5" — not an integer', '3.5'],
    ])('%s', (_label, rawValue) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const config = loadLoginThrottleConfig({ GATEWAY_LOGIN_RATE_LIMIT: rawValue });

      expect(config.limit).toBe(10);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged.level).toBe('warn');
      expect(logged.code).toBe('INVALID_LOGIN_THROTTLE_CONFIG');
      expect(logged.variable).toBe('GATEWAY_LOGIN_RATE_LIMIT');
      expect(logged.rawValue).toBe(rawValue);
      expect(logged.fallback).toBe(10);
      expect(String(logged.message)).toContain('GATEWAY_LOGIN_RATE_LIMIT');
    });
  });

  it('malformed GATEWAY_LOGIN_RATE_WINDOW_MS falls back to the default AND logs why (F1)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const config = loadLoginThrottleConfig({ GATEWAY_LOGIN_RATE_WINDOW_MS: 'abc' });

    expect(config.ttlMs).toBe(60000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged.variable).toBe('GATEWAY_LOGIN_RATE_WINDOW_MS');
    expect(logged.fallback).toBe(60000);
  });

  it('an empty string for BOTH variables falls back to BOTH documented defaults, never a zero limit masked by a zero ttl (F1)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const config = loadLoginThrottleConfig({ GATEWAY_LOGIN_RATE_LIMIT: '', GATEWAY_LOGIN_RATE_WINDOW_MS: '' });

    expect(config.limit).toBe(10);
    expect(config.ttlMs).toBe(60000);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('never logs a warning for a valid, present value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    loadLoginThrottleConfig({ GATEWAY_LOGIN_RATE_LIMIT: '7', GATEWAY_LOGIN_RATE_WINDOW_MS: '30000' });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
