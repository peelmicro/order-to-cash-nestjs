<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLoginMutation } from '@/composables/useSession';
import { describeFetchError } from '@/lib/problem';
import { STACK_LABEL } from '@/lib/stack-label';

definePageMeta({ layout: 'default' });

const form = reactive({ username: 'operator', password: '' });
const login = useLoginMutation();

/**
 * SSR-safe disabled-until-hydrated guard. Before Vue finishes client
 * hydration, `@submit.prevent="submit"` is not yet a live DOM listener — a
 * click or Enter-key submit in that window falls through to the browser's
 * *native* form submission, which (this `<form>` carries no `action`/
 * `method`) defaults to a `GET` against the current URL, encoding the
 * password into the URL query string (browser history, server access logs,
 * `Referer` headers) — a real security defect, not only "nothing visibly
 * happens". `onMounted` never runs during SSR, so the server-rendered HTML
 * already has `disabled` baked into the button; the native, JS-free
 * pre-hydration submit path is blocked at the HTML level, not only by a
 * listener that isn't attached yet.
 */
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});

async function submit() {
  try {
    await login.mutateAsync({ username: form.username, password: form.password });
    await navigateTo('/orders');
  } catch {
    // `login.isError`/`.error` (read by `errorDetail`) already drives the
    // error UI — this only prevents an unhandled promise rejection from
    // `mutateAsync`'s own re-throw, and correctly skips the navigation.
  }
}

// Reads the server's own reason via `describeFetchError` — see
// `app/lib/problem.ts` for why a naive `error.data?.detail` silently misses
// it (this app's error-handling sweep's own headline finding).
const errorDetail = computed(() => (login.isError.value ? describeFetchError(login.error.value, 'Login failed.') : undefined));
</script>

<template>
  <div class="flex min-h-[70vh] items-center justify-center">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Order-To-Cash</CardTitle>
        <p class="text-xs text-muted-foreground" data-testid="stack-label">
          {{ STACK_LABEL }}
        </p>
        <CardDescription>Sign in with the operator credentials from `.env` (GATEWAY_OPERATOR_USERNAME / GATEWAY_OPERATOR_PASSWORD).</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-4" @submit.prevent="submit">
          <div class="flex flex-col gap-1.5">
            <Label for="username">Username</Label>
            <Input id="username" v-model="form.username" autocomplete="username" required />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="password">Password</Label>
            <Input id="password" v-model="form.password" type="password" autocomplete="current-password" required />
          </div>
          <p v-if="errorDetail" class="text-sm text-destructive" data-testid="login-error">
            {{ errorDetail }}
          </p>
          <Button type="submit" :disabled="login.isPending.value || !mounted" class="w-full">
            {{ login.isPending.value ? 'Signing in…' : 'Sign in' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
