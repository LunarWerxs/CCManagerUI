<script setup lang="ts">
// Confirmation gate for signing an instance out.
//
// A plain confirm, not a type-to-confirm like Delete, because the two are different sizes: this
// removes a stored login and leaves the profile, its history and its settings exactly where they
// are. What it costs is the sign-in back, which on this app means the "Browser Dance" (quit the
// other instances first), and that is enough to be worth one deliberate click.
//
// The account is named in the body on purpose. The menu that opened this belongs to one row out of
// a table of near-identical ones, and "sign out" is the wrong thing to be unsure about.
import { LogOut } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const open = defineModel<boolean>('open', { default: false })

defineProps<{
  /** The row's display name, so the dialog names what it is about. */
  instanceName: string | null
  /** The account address, when one is resolved. Null while unresolved or already signed out. */
  accountEmail?: string | null
  submitting?: boolean
}>()

const emit = defineEmits<{
  confirm: []
}>()
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <LogOut class="size-4" />
          {{ $t('instances.logoutDialogTitle', { name: instanceName ?? '' }) }}
        </DialogTitle>
        <DialogDescription>
          {{ $t('instances.logoutDialogDescription') }}
        </DialogDescription>
      </DialogHeader>

      <p v-if="accountEmail" class="mono mt-2 truncate text-xs text-muted-foreground">
        {{ accountEmail }}
      </p>

      <DialogFooter class="mt-4">
        <Button type="button" variant="destructive" :disabled="submitting" @click="emit('confirm')">
          {{ submitting ? $t('instances.logoutDialogWorking') : $t('instances.logoutDialogSubmit') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
