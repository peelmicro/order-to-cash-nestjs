// TanStack Query's own recommended Nuxt SSR wiring: one QueryClient per
// request, dehydrated on the server and rehydrated on the client so a page
// that fetched data during SSR does not refetch it on hydration.
// https://tanstack.com/query/latest/docs/framework/vue/guides/ssr#nuxt-3
import type { DehydratedState, VueQueryPluginOptions } from '@tanstack/vue-query';
import { VueQueryPlugin, QueryClient, hydrate, dehydrate } from '@tanstack/vue-query';

export default defineNuxtPlugin((nuxtApp) => {
  const vueQueryState = useState<DehydratedState | null>('vue-query');

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: 1,
      },
    },
  });
  const options: VueQueryPluginOptions = { queryClient };

  nuxtApp.vueApp.use(VueQueryPlugin, options);

  if (import.meta.server) {
    nuxtApp.hooks.hook('app:rendered', () => {
      vueQueryState.value = dehydrate(queryClient);
    });
  }

  if (import.meta.client) {
    nuxtApp.hooks.hook('app:created', () => {
      hydrate(queryClient, vueQueryState.value ?? {});
    });
  }
});
