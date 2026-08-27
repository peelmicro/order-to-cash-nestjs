import type { H3Event } from 'h3';
import { useSession } from 'h3';

/**
 * The session this Nuxt server holds on behalf of the browser — never the
 * browser itself (progress/current.md, "F14 resolved"). `accessToken` is
 * the real Gateway-issued JWT; `expiresAt` lets server routes refuse to
 * proxy with an obviously stale token instead of forwarding one the
 * Gateway will reject anyway.
 *
 * `useSession` (from `h3`, auto-available in every Nitro server route) seals
 * this object into an AES-GCM encrypted, signed cookie under `password` —
 * so even the raw cookie value never contains the JWT in the clear, on top
 * of the httpOnly/secure/sameSite flags declared below that keep it out of
 * reach of any client-side JavaScript in the first place.
 */
export interface OtcSessionData {
  accessToken?: string;
  expiresAt?: number;
  username?: string;
  displayName?: string;
  roles?: string[];
}

const SESSION_COOKIE_NAME = 'otc_session';

export function otcSession(event: H3Event) {
  const config = useRuntimeConfig(event);
  return useSession<OtcSessionData>(event, {
    name: SESSION_COOKIE_NAME,
    password: config.sessionPassword,
    maxAge: 60 * 60 * 12, // 12h ceiling on the sealed cookie itself; the real bound is the Gateway JWT's own expiry, checked per-request below.
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    },
  });
}

/** Reads the session and throws 401 if there is no live (unexpired) access token — the shape every proxied route needs before it can call the Gateway. */
export async function requireGatewayToken(event: H3Event): Promise<string> {
  const session = await otcSession(event);
  const { accessToken, expiresAt } = session.data;
  if (!accessToken || !expiresAt || expiresAt <= Date.now()) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated' });
  }
  return accessToken;
}
