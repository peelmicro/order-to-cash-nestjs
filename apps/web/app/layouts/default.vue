<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { useLogoutMutation, useSessionQuery } from '@/composables/useSession';

const route = useRoute();
const { data: session } = useSessionQuery();
const logout = useLogoutMutation();

async function handleLogout() {
  await logout.mutateAsync();
  await navigateTo('/login');
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <header v-if="route.path !== '/login'" class="border-b border-border">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <nav class="flex items-center gap-4">
          <NuxtLink to="/orders" class="text-sm font-semibold">
            Order-To-Cash
          </NuxtLink>
          <NuxtLink
            to="/orders"
            class="text-sm text-muted-foreground hover:text-foreground"
            active-class="text-foreground font-medium"
          >
            Orders
          </NuxtLink>
          <NuxtLink
            to="/orders/place"
            class="text-sm text-muted-foreground hover:text-foreground"
            active-class="text-foreground font-medium"
          >
            Place order
          </NuxtLink>
        </nav>
        <div class="flex items-center gap-3">
          <span v-if="session?.authenticated" class="text-sm text-muted-foreground">
            {{ session.displayName ?? session.username }}
          </span>
          <Button v-if="session?.authenticated" variant="outline" size="sm" @click="handleLogout">
            Log out
          </Button>
        </div>
      </div>
    </header>
    <main class="mx-auto max-w-5xl px-6 py-8">
      <slot />
    </main>
  </div>
</template>
