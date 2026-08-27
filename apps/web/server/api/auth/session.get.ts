import type { SessionInfo } from '#shared/types/gateway';
import { otcSession } from '../../utils/session';

/** What the browser is allowed to know about its own session — never the token itself (F14). */
export default defineEventHandler(async (event): Promise<SessionInfo> => {
  const session = await otcSession(event);
  const { accessToken, expiresAt, username, displayName, roles } = session.data;

  if (!accessToken || !expiresAt || expiresAt <= Date.now()) {
    return { authenticated: false };
  }

  return { authenticated: true, username, displayName, roles };
});
