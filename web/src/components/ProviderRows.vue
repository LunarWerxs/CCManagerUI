<script setup lang="ts">
// Provider surfaces: which installed tools AgentHydra exposes, and the one optional handoff.
//
// Extracted from SettingsView for the same reason as UsageRefreshRows: four of these five switches
// decide which TABLES the Instances tab draws, so they belong on that tab's toolbar as much as they
// belong in Settings. Shared markup over the shared useAppSettings singleton means both surfaces
// are the same control, not two that have to be kept in step.
//
// `showHandoff` is off in the toolbar flyout: the ChatGPT handoff is a button in the session
// composer, not a section of the instances tab, and listing it beside four table toggles would say
// it hides a table too.
import { AppWindow, Gauge, MessageCircleQuestion, Monitor, Terminal, Timer } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAppSettings } from '@/composables/useAppSettings'
import type { ProviderSettings, UsageSettings } from '@/lib/api'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

withDefaults(defineProps<{ showHandoff?: boolean }>(), { showHandoff: true })

const { t } = useI18n()
const {
  showDesktopInstances,
  showCliInstances,
  codexDesktopEnabled,
  codexCliEnabled,
  chatGptHandoffEnabled,
  keepaliveEnabled,
  keepaliveWeeklyFloorPct,
  update: updateAppSettings,
} = useAppSettings()

// Two patch helpers because the two halves live in different server-side settings blocks
// (UsageSettings vs ProviderSettings) and report their own failure copy — see SettingsView.
async function patchUsage(value: Partial<UsageSettings>) {
  if (!(await updateAppSettings(value))) toast.error(t('settings.usageToastFailed'))
}
async function patchProvider(value: Partial<ProviderSettings>) {
  if (!(await updateAppSettings(value))) toast.error(t('settings.providerToastFailed'))
}
</script>

<template>
  <SettingsRow :icon="Monitor" :label="$t('settings.claudeDesktopProviderLabel')">
    <template #info>
      <InfoHint :text="$t('settings.claudeDesktopProviderHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="showDesktopInstances"
        @update:model-value="(v: boolean) => patchUsage({ showDesktopInstances: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow :icon="Terminal" :label="$t('settings.claudeCliProviderLabel')">
    <template #info>
      <InfoHint :text="$t('settings.claudeCliProviderHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="showCliInstances"
        @update:model-value="(v: boolean) => patchUsage({ showCliInstances: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow :icon="AppWindow" :label="$t('settings.codexDesktopProviderLabel')">
    <template #info>
      <InfoHint :text="$t('settings.codexDesktopProviderHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="codexDesktopEnabled"
        @update:model-value="(v: boolean) => patchProvider({ codexDesktopEnabled: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow :icon="Terminal" :label="$t('settings.codexCliProviderLabel')">
    <template #info>
      <InfoHint :text="$t('settings.codexCliProviderHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="codexCliEnabled"
        @update:model-value="(v: boolean) => patchProvider({ codexCliEnabled: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow
    v-if="showHandoff"
    :icon="MessageCircleQuestion"
    :label="$t('settings.chatGptHandoffLabel')"
  >
    <template #info>
      <InfoHint :text="$t('settings.chatGptHandoffHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="chatGptHandoffEnabled"
        @update:model-value="(v: boolean) => patchProvider({ chatGptHandoffEnabled: v })"
      />
    </template>
  </SettingsRow>

  <!-- ⛔ THE ONE SWITCH ON THIS SCREEN THAT SPENDS MONEY. Everything else here shows or hides
       something; this sends a real turn to an idle account to get its 5-hour clock running. The
       hint says so in as many words, because a toggle that quietly costs quota is the kind of
       thing you should never discover from a bill. -->
  <SettingsRow :icon="Timer" :label="$t('settings.keepaliveLabel')">
    <template #info>
      <InfoHint :text="$t('settings.keepaliveHint')" />
    </template>
    <template #control>
      <Switch
        :model-value="keepaliveEnabled"
        @update:model-value="(v: boolean) => patchProvider({ keepaliveEnabled: v })"
      />
    </template>
  </SettingsRow>
  <SettingsRow
    v-if="keepaliveEnabled"
    :icon="Gauge"
    :label="$t('settings.keepaliveFloorLabel')"
  >
    <template #info>
      <InfoHint :text="$t('settings.keepaliveFloorHint')" />
    </template>
    <template #control>
      <Input
        class="w-20"
        type="number"
        min="0"
        max="100"
        :model-value="keepaliveWeeklyFloorPct"
        @update:model-value="
          (v: string | number) => patchProvider({ keepaliveWeeklyFloorPct: Number(v) })
        "
      />
    </template>
  </SettingsRow>
</template>
