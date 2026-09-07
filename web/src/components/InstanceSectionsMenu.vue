<script setup lang="ts">
// The Instances toolbar's "which tables does this tab show" flyout.
//
// These four switches are Settings → Providers, rendered where they take effect. In Settings they
// are a group you have to already suspect exists; on this toolbar they are one click from the empty
// space where the table you turned off used to be — which is the moment anyone actually wants them.
//
// Not a copy: ProviderRows.vue is the same component Settings renders, over the same useAppSettings
// singleton, so a switch flipped here is already flipped there. The ChatGPT handoff row is left out
// (`:show-handoff="false"`) because it toggles a button in the session composer, not a table here.
import { Layers } from '@lucide/vue'
import ProviderRows from '@/components/ProviderRows.vue'
import { buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import IconTooltip from '@/shell/IconTooltip.vue'
</script>

<template>
  <!-- Popover root INSIDE the tooltip slot, wrapped in a span — see InstanceFilterMenu.vue and
       scripts/checks/reka-popper-root-inside-tooltip.mjs for why the other nesting breaks. -->
  <IconTooltip :label="$t('instances.sectionsTitle')" :description="$t('instances.sectionsHint')">
    <span class="inline-flex">
      <Popover>
        <PopoverTrigger as-child>
          <button
            type="button"
            :class="cn(buttonVariants({ variant: 'outline', size: 'icon' }))"
            :aria-label="$t('instances.sectionsTitle')"
          >
            <Layers />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-80 p-0">
          <p
            class="px-3.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {{ $t('instances.sectionsTitle') }}
          </p>
          <div class="divide-y divide-border/60">
            <ProviderRows :show-handoff="false" />
          </div>
        </PopoverContent>
      </Popover>
    </span>
  </IconTooltip>
</template>
