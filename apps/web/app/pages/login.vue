<script setup lang="ts">
import { reactive } from 'vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLoginMutation } from '@/composables/useSession';
import type { Problem } from '#shared/types/gateway';

definePageMeta({ layout: 'default' });

const form = reactive({ username: 'operator', password: '' });
const login = useLoginMutation();

async function submit() {
  await login.mutateAsync({ username: form.username, password: form.password });
  await navigateTo('/orders');
}

const errorDetail = computed(() => {
  const error = login.error.value as { data?: Problem } | null;
  return error?.data?.detail ?? error?.data?.title ?? (login.isError.value ? 'Login failed.' : undefined);
});
</script>

<template>
  <div class="flex min-h-[70vh] items-center justify-center">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Order-To-Cash</CardTitle>
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
          <Button type="submit" :disabled="login.isPending.value" class="w-full">
            {{ login.isPending.value ? 'Signing in…' : 'Sign in' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
