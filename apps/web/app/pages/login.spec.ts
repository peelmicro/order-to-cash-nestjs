// @vitest-environment nuxt
import { describe, expect, it, vi } from 'vitest';
import { renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';

/**
 * Bug 1 regression: the login `<form>` carries no `action`/`method`
 * attribute, so before Vue finishes client hydration, `@submit.prevent`
 * is not yet a live DOM listener — a click/Enter-key submit in that window
 * falls through to the browser's *native* form submission, defaulting to a
 * `GET` against the current URL. That encodes the password into the URL
 * query string (browser history, server access logs, `Referer` headers) —
 * a real security defect, not only "nothing visibly happens".
 *
 * The fix is the standard SSR-safe disabled-until-hydrated pattern: a
 * `mounted` ref that starts `false` and flips to `true` only inside
 * `onMounted` (which never runs during SSR), gating the submit button's
 * `:disabled`. Because `onMounted`'s callback is scheduled as a Vue
 * post-render-flush microtask, and `renderSuspended` itself only resolves
 * *after* that same flush has already run (proven directly against this
 * harness — a plain probe component's `onMounted` console.log fires before
 * `renderSuspended`'s own await resolves), a jsdom/happy-dom component test
 * cannot observe the true pre-hydration instant merely by rendering and
 * inspecting synchronously. Instead, this test proves the actual wiring
 * deterministically by preventing `onMounted`'s callback from ever running
 * (simulating "hydration never completes", which is what a browser looks
 * like for the whole window between first paint and hydration finishing) —
 * proving the button is driven by the `mounted` ref, not merely by its own
 * pending/form-validity state, exactly the security property the fix adds.
 * The genuinely time-sensitive, real-browser half of this proof (the raw
 * SSR HTML already carrying `disabled`, and a real fast-double-submit not
 * navigating) is documented with live evidence in
 * `progress/impl_web_app.md`, Pass 4.
 */
describe('login.vue — submit button is gated on hydration, not only on isPending', () => {
  it('stays disabled even with valid credentials filled in, for as long as onMounted has not fired (pre-hydration window)', async () => {
    vi.doMock('vue', async (importOriginal) => {
      const actual = await importOriginal<typeof import('vue')>();
      return { ...actual, onMounted: vi.fn() };
    });
    vi.resetModules();
    const { default: LoginPage } = await import('./login.vue');

    await renderSuspended(LoginPage, {
      global: { plugins: [VueQueryPlugin] },
    });

    await fireEvent.update(screen.getByLabelText('Username'), 'operator');
    await fireEvent.update(screen.getByLabelText('Password'), 'correct-horse-battery-staple');

    const button = screen.getByRole('button', { name: /sign in|signing in/i });
    expect(button).toBeDisabled();

    vi.doUnmock('vue');
    vi.resetModules();
  });

  it('becomes enabled once mounted (the real, hydrated state) with valid credentials filled in', async () => {
    const { default: LoginPage } = await import('./login.vue');

    await renderSuspended(LoginPage, {
      global: { plugins: [VueQueryPlugin] },
    });

    await fireEvent.update(screen.getByLabelText('Username'), 'operator');
    await fireEvent.update(screen.getByLabelText('Password'), 'correct-horse-battery-staple');

    const button = screen.getByRole('button', { name: /sign in|signing in/i });
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('Sign in');
  });
});
