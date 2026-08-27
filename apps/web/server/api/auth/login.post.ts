import type { LoginRequest, LoginResponse, CurrentUser, SessionInfo } from '#shared/types/gateway';
import { gatewayFetchPublic } from '../../utils/gateway';
import { otcSession } from '../../utils/session';

/**
 * Exchanges operator credentials for a Gateway JWT and seals it into this
 * Nuxt server's own session cookie — the JWT never reaches the response
 * body the browser receives (F14). Only `SessionInfo` (username/roles) does.
 */
export default defineEventHandler(async (event): Promise<SessionInfo> => {
  const body = await readBody<LoginRequest>(event);

  const issued = await gatewayFetchPublic<LoginResponse>(event, '/auth/login', {
    method: 'POST',
    body,
  });

  const me = await gatewayFetchPublic<CurrentUser>(event, '/auth/me', {
    headers: { Authorization: `Bearer ${issued.accessToken}` },
  });

  const session = await otcSession(event);
  await session.update({
    accessToken: issued.accessToken,
    expiresAt: Date.now() + issued.expiresIn * 1000,
    username: me.username,
    displayName: me.displayName,
    roles: me.roles,
  });

  return { authenticated: true, username: me.username, displayName: me.displayName, roles: me.roles };
});
