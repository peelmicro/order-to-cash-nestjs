import type { SessionInfo } from '#shared/types/gateway';

/**
 * Every page except `/login` requires a live session. Runs on both the
 * initial SSR request and client-side navigations; on the server it must
 * forward the incoming request's own cookies (`useRequestHeaders`) because
 * `$fetch`'s internal call to `/api/auth/session` is otherwise a brand new,
 * cookie-less request.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') {
    return;
  }

  const session = await $fetch<SessionInfo>('/api/auth/session', {
    headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
  }).catch((): SessionInfo => ({ authenticated: false }));

  if (!session.authenticated) {
    return navigateTo('/login');
  }
});
