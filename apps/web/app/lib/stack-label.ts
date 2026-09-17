/**
 * Which assessment this web app belongs to. #7 (NestJS + Nuxt) and #8
 * (.NET + Next.js) implement the same specification with near-identical
 * pages and both default to port 3010, so a browser alone cannot tell them
 * apart. This is the ONE definition of the label: the signed-in header
 * (`layouts/default.vue`), the login page (`pages/login.vue`) and the
 * browser-tab title (`app.vue`) all read it from here, so it cannot drift
 * within the app. `app/stack-label.spec.ts` fails if any of the three loses it.
 */
export const STACK_LABEL = '#7 · NestJS / Nuxt';

/** The browser-tab title — the product name plus the stack label. */
export const DOCUMENT_TITLE = `Order-To-Cash · ${STACK_LABEL}`;
