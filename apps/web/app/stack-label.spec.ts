// @vitest-environment nuxt
//
// Backlog id 99: #7's web app names its stack — '#7 · NestJS / Nuxt' — in
// the signed-in header, on the login page and in the browser-tab title, all
// from the one definition in `lib/stack-label.ts`. Each test below fails if
// its place loses the label.
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, waitFor } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import App from './app.vue';
import DefaultLayout from './layouts/default.vue';
import LoginPage from './pages/login.vue';
import { DOCUMENT_TITLE, STACK_LABEL } from './lib/stack-label';

describe('stack label (id 99)', () => {
  it('is the literal #7 label', () => {
    expect(STACK_LABEL).toBe('#7 · NestJS / Nuxt');
    expect(DOCUMENT_TITLE).toContain('#7 · NestJS / Nuxt');
  });

  it('is shown in the header of a signed-in page', async () => {
    registerEndpoint('/api/auth/session', () => ({ authenticated: true, username: 'operator' }));
    await renderSuspended(DefaultLayout, {
      route: '/orders',
      global: { plugins: [VueQueryPlugin] },
    });
    expect(screen.getByRole('banner')).toHaveTextContent('#7 · NestJS / Nuxt');
    expect(screen.getByTestId('stack-label')).toHaveTextContent('#7 · NestJS / Nuxt');
  });

  it('is shown on the login page', async () => {
    await renderSuspended(LoginPage, { global: { plugins: [VueQueryPlugin] } });
    expect(screen.getByTestId('stack-label')).toHaveTextContent('#7 · NestJS / Nuxt');
  });

  it('names the stack in the browser-tab title', async () => {
    registerEndpoint('/api/auth/session', () => ({ authenticated: false }));
    document.title = '';
    await renderSuspended(App, { global: { plugins: [VueQueryPlugin] } });
    await waitFor(() => expect(document.title).toBe('Order-To-Cash · #7 · NestJS / Nuxt'));
  });
});
