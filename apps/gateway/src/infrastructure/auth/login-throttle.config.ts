// Rate-limit policy for `POST /auth/login` ONLY (openapi.yaml
// `components.responses.TooManyRequests` on that one route — see
// progress/impl_auth_rate_limit.md). Brute-force protection on the single
// unauthenticated write route this API exposes; every other route is
// unaffected (`ThrottlerGuard` is applied route-scoped in
// `auth.controller.ts`, never as a global `APP_GUARD`).
//
// Review finding F1 (progress/review_auth_rate_limit.md): a bare
// `Number(env.X ?? default)` only defends against the variable being
// ABSENT — a PRESENT-but-malformed value slips straight through, and the
// two failure modes measured against the real guard are opposite and both
// silent: a non-numeric value (`"abc"`, a stray thousands separator, a
// trailing comment) produces `NaN`, under which the real `ThrottlerGuard`
// never throttles at all (25/25 requests observed to return 200 — a
// security control that enforces nothing and reports nothing); a
// zero/negative/blank value (`"0"`, `" "`, `"-5"`, `""`) makes the very
// first request 429, permanently bricking the only login route. Every
// value read here is therefore validated to a finite integer `>= 1`; on
// anything else this loader falls back to the DOCUMENTED default AND logs
// a structured warning naming the rejected raw value — the same
// `console.<level>(JSON.stringify({...}))` shape
// `problem-json.filter.ts` already establishes for this app's own
// structured logging — rather than failing the whole Gateway's boot over
// one malformed rate-limit knob (a wrong SSE buffer or RPC timeout
// degrades a feature; refusing to boot over this one specific knob would
// make a `.env` typo take down every route, not just login).
export interface LoginThrottleConfig {
  readonly limit: number;
  readonly ttlMs: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_TTL_MS = 60000;

function parsePositiveInteger(raw: string | undefined, fallback: number, variableName: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        code: 'INVALID_LOGIN_THROTTLE_CONFIG',
        message: `${variableName}=${JSON.stringify(raw)} is not a finite integer >= 1 — falling back to the documented default (${fallback})`,
        variable: variableName,
        rawValue: raw,
        fallback,
      }),
    );
    return fallback;
  }
  return parsed;
}

export function loadLoginThrottleConfig(env: NodeJS.ProcessEnv = process.env): LoginThrottleConfig {
  return {
    // 10 attempts/minute by default — tight enough to blunt a
    // credential-stuffing loop, loose enough that no test in this repo's
    // own suites (max 3 `POST /auth/login` calls in a single integration
    // spec file, each file booting its own fresh `AppModule`/throttler
    // storage instance) ever brushes it. Tracked by `req.ip`
    // (`ThrottlerGuard`'s own default tracker) — genuinely per CALLER IP,
    // which is per end user for a direct caller but a single SHARED budget
    // for every caller behind one IP (`apps/web`'s BFF, every n8n
    // workflow) — see `.env.example`'s own comment on this variable for
    // the full account (review finding F2).
    limit: parsePositiveInteger(env.GATEWAY_LOGIN_RATE_LIMIT, DEFAULT_LIMIT, 'GATEWAY_LOGIN_RATE_LIMIT'),
    ttlMs: parsePositiveInteger(env.GATEWAY_LOGIN_RATE_WINDOW_MS, DEFAULT_TTL_MS, 'GATEWAY_LOGIN_RATE_WINDOW_MS'),
  };
}
