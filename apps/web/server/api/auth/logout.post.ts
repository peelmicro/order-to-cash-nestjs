import { otcSession } from '../../utils/session';

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const session = await otcSession(event);
  await session.clear();
  return { ok: true };
});
