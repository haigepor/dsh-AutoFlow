/** Settings and feedback registrations leave with their plugin fiber. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, onTestFinished } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

it('registers a discoverable settings section and removes its section and feedback on unload', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  ctx.provide('sessions', {} as never)
  ctx.provide('workspaces', {} as never)
  ctx.provide('uiWorkspace', {} as never)
  ctx.provide('layout', {} as never)
  ctx.provide('remote', {} as never)
  ctx.provide('remote.sessionDeletion', {} as never)
  ctx.provide('configForms', { get: () => createSnapshotStore({ value: { favoriteSessionIds: [] }, status: 'ready', writable: true }) } as never)
  ctx.provide('remoteAccess', { whenAccess: (_action: string, register: () => () => void) => register() } as never)
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } }, (_props: PropsRenderSlots<'settings.section' | 'shell.overlay'>) => null)
  const plugin = ctx.plugin({ apply, inject })
  await plugin.await()
  const section = ctx.slots.entries('settings.section')[0]
  expect(section?.options.id).toBe('archived-sessions')
  const label = section?.options.label
  expect(typeof label === 'function' ? label() : label).toBe('Archived sessions')
  expect(ctx.slots.entries('shell.overlay')).toHaveLength(1)
  await plugin.dispose()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
})
