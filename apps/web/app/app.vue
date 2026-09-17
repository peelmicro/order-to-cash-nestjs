<script setup lang="ts">
import { DOCUMENT_TITLE } from '@/lib/stack-label';

// The browser-tab title names the stack (backlog id 99) — see `lib/stack-label.ts`.
useHead({ title: DOCUMENT_TITLE });
</script>

<template>
  <div>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>
