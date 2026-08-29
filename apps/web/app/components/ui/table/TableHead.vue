<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class']
  /**
   * WCAG 2.2 1.3.1 "going the extra mile" (SonarQube Web:S5256's own
   * `how_to_fix` doc): a `<th>` should be associated with its data cells via
   * `scope`. Every caller in this app uses `TableHead` for a COLUMN header
   * (the first `<tr>` inside `TableHeader`) — `col` is therefore a correct
   * default, overridable for the rare row-header case.
   */
  scope?: 'col' | 'row'
}>(), {
  scope: 'col',
})
</script>

<template>
  <th
    data-slot="table-head"
    :scope="scope"
    :class="cn('text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0', props.class)"
  >
    <slot />
  </th>
</template>
