import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { LoginRequest, SessionInfo } from '#shared/types/gateway';

const SESSION_KEY = ['session'];

/** The browser's only knowledge of "am I logged in" — never the JWT itself (F14). Backed by `GET /api/auth/session`, which reads this Nuxt server's own sealed session cookie. */
export function useSessionQuery() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: () => $fetch<SessionInfo>('/api/auth/session'),
    staleTime: 60_000,
  });
}

export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: LoginRequest) =>
      $fetch<SessionInfo>('/api/auth/login', { method: 'POST', body: credentials }),
    onSuccess: (session) => {
      queryClient.setQueryData(SESSION_KEY, session);
    },
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => $fetch<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.setQueryData<SessionInfo>(SESSION_KEY, { authenticated: false });
      queryClient.clear();
    },
  });
}
