import tailwindcss from '@tailwindcss/vite';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  devServer: {
    port: Number(process.env.WEB_PORT ?? 3000),
  },
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
  },
  // shadcn-vue's `components/ui/**` pairs each `Thing.vue` with a barrel
  // `index.ts` re-exporting it under the same conceptual name (`Button` /
  // `UiButton`) — Nuxt's auto-component-scanner sees both as candidates for
  // the same tag and warns. shadcn-vue's own convention is explicit named
  // imports from the barrel (`import { Button } from '@/components/ui/button'`),
  // never the auto-registered `<UiButton>` tag, so `ui/**` is excluded from
  // the scan rather than worked around per-component.
  components: {
    dirs: [{ path: '~/components', ignore: ['ui/**'] }],
  },
  // Runtime config resolved server-side only (`GATEWAY_BASE_URL` never
  // ships to the client — see server/utils/gateway.ts). `public` stays
  // empty on purpose: the browser never needs a Gateway URL because it
  // never talks to the Gateway directly (progress/current.md, "F14
  // resolved").
  runtimeConfig: {
    gatewayBaseUrl: process.env.GATEWAY_BASE_URL ?? `http://localhost:${process.env.GATEWAY_PORT ?? 3001}`,
    sessionPassword: process.env.NUXT_SESSION_PASSWORD ?? 'otc_web_dev_session_password_change_me_32ch',
    public: {},
  },
})
