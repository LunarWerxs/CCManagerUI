<script setup lang="ts">
// One quota window inside the usage flyout: a switch that says whether the window is measured at
// all, and — only once it is — the line it is measured against.
//
// A component rather than two copies in InstanceFilterMenu.vue because the weekly cap and the 5-hour
// session are the SAME control twice over. They are also the two halves of one comparison, so any
// drift between them (a preset row on one, a differently-sized readout on the other) reads as the
// two windows working differently rather than as a styling slip.
//
// Three ways to set one number, deliberately, because they answer different questions: the presets
// are the one-click common case, the slider is "somewhere around here" without typing, and the box
// is the exact figure. All three write through the same clamped setter, so none of them can persist
// a value the others could not reach.
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { USAGE_THRESHOLD_PRESETS } from '@/lib/usage-filter'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import InfoHint from '@/shell/InfoHint.vue'

// Every string arrives as a PROP — there is not a t() or $t() left in here. The quick-instances
// window (QuickInstanceFilter.vue) renders these same two windows and deliberately runs without
// vue-i18n installed, so a translate call anywhere in this subtree would throw there. Taking the
// last two literals ("Set aside at" / the preset captions) as props is what lets both surfaces
// share one slider, one preset row and one clamped setter instead of growing a second copy of the
// control that the filter's whole correctness story is written around.
const props = defineProps<{
  /** Row label, e.g. "Weekly usage". */
  label: string
  /** The InfoHint body: what this window is and why you would measure it. */
  hint: string
  /** Spoken name for the number box, which has no visible label of its own. */
  thresholdLabel: string
  /** Caption above the number box, e.g. "Set aside at". */
  thresholdCaption: string
  /** Renders one preset button's caption, e.g. (80) => "80%". A function rather than a formatted
   *  list so a translated surface can keep its own number formatting. */
  presetLabel: (pct: number) => string
  threshold: number
}>()

const emit = defineEmits<{ 'update:threshold': [value: unknown] }>()

/** The window's on/off. `defineModel` so the parent keeps owning the persisted ref. */
const enabled = defineModel<boolean>({ required: true })

/** The slider's filled portion, painted with a gradient rather than a second element: a range input
 *  has no "track before the thumb" pseudo-element to colour, and the fill is what makes the control
 *  read as a level rather than as a dot on a line. */
const fill = computed(() => `${props.threshold}%`)
</script>

<template>
  <section
    class="overflow-hidden rounded-md border transition-colors"
    :class="enabled ? 'border-border bg-background/60' : 'border-border/60 bg-transparent'"
  >
    <div class="flex items-center gap-3 px-2.5 py-1.5">
      <span class="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground">
        {{ label }}
        <InfoHint :text="hint" />
      </span>
      <Switch v-model="enabled" />
    </div>

    <ExpandTransition :open="enabled">
      <div class="space-y-2 border-t border-border/60 px-2.5 py-2">
        <div class="flex items-center justify-between gap-3">
          <span class="text-[12px] text-muted-foreground">{{ thresholdCaption }}</span>
          <div class="flex items-baseline gap-1">
            <!-- `md:text-[13px]` as well as the unprefixed size: the Input's own base class list
                 carries a `md:text-xs/relaxed`, and twMerge treats a responsive variant as its own
                 group — so the unprefixed size alone loses above the md breakpoint. Spinners off
                 because this reads as a value, and they cost a third of the box's width. -->
            <Input
              class="h-6 w-11 rounded px-1.5 text-right text-[13px] font-medium tabular-nums md:text-[13px] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              type="number"
              min="0"
              max="100"
              :aria-label="thresholdLabel"
              :model-value="threshold"
              @change="(e: Event) => emit('update:threshold', (e.target as HTMLInputElement).value)"
            />
            <span class="text-[12px] text-muted-foreground">%</span>
          </div>
        </div>

        <input
          class="usage-range"
          type="range"
          min="0"
          max="100"
          step="1"
          :aria-label="thresholdLabel"
          :value="threshold"
          :style="{ '--usage-fill': fill }"
          @input="(e: Event) => emit('update:threshold', (e.target as HTMLInputElement).value)"
        />

        <div class="grid grid-cols-4 gap-1">
          <Button
            v-for="preset in USAGE_THRESHOLD_PRESETS"
            :key="preset"
            :variant="threshold === preset ? 'default' : 'outline'"
            size="xs"
            :aria-pressed="threshold === preset"
            @click="emit('update:threshold', preset)"
          >
            {{ presetLabel(preset) }}
          </Button>
        </div>
      </div>
    </ExpandTransition>
  </section>
</template>

<style scoped>
/* A bare range input, styled here rather than vendored as a ui/ component: the kit owns
   components/ui and shell/ (check:kit fails on a single byte of drift), and this is the only
   slider in the app. Both vendor prefixes because the track/thumb pseudo-elements cannot be
   combined into one rule — a selector list containing an unknown pseudo-element is dropped whole. */
.usage-range {
  width: 100%;
  height: 0.75rem;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
}
.usage-range:focus-visible {
  outline: none;
}

.usage-range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 9999px;
  background: linear-gradient(
    to right,
    var(--primary) var(--usage-fill),
    var(--border) var(--usage-fill)
  );
}
.usage-range::-moz-range-track {
  height: 4px;
  border-radius: 9999px;
  background: linear-gradient(
    to right,
    var(--primary) var(--usage-fill),
    var(--border) var(--usage-fill)
  );
}

.usage-range::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4px;
  border-radius: 9999px;
  background: var(--primary);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
  transition: box-shadow 0.15s ease;
}
.usage-range::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: none;
  border-radius: 9999px;
  background: var(--primary);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
}

.usage-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 40%, transparent);
}
.usage-range:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 40%, transparent);
}
</style>
