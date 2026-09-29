/** Theme settings section registration and Host-backed preference updates. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, SETTINGS_NS } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema } from '../src/theme-settings.ts'
import { ThemeSettingsPage, type ThemeSettingsPageInjected } from '../src/client/ThemeSettingsPage.tsx'
import type { createThemePageStore } from '../src/client/settings-store.ts'

const SLOT = 'settings.section'

async function bench(isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const section: Record<string, unknown> = {
    preference: 'system', fontSize: 14, accent: 'iris', themeSet: 'official', glideDuration: 220, fontFamily: 'system', corners: 'standard',
  }
  const namespace = () => ({
    ns: THEME_SETTINGS_NAMESPACE, schema: ThemeSettingsSchema.toJSON(), value: { ...section },
    autoGenerate: true, applies: 'live' as const, secrets: [], revision: 0,
  })
  const describe = vi.fn(() => Promise.resolve({
    ok: true as const, value: { writable: true, hasDocument: true, namespaces: [namespace()] },
  }))
  const mutate = vi.fn((_ns: string, ops: { path: string[]; value: unknown }[]) => {
    const op = ops[0]!
    section[op.path[0]!] = op.value
    return Promise.resolve({ ok: true as const, value: namespace() })
  })
  const events = new TestRemote(ctx, { settings: { describe, mutate } })
  events.$host = { home: undefined, isLoopback }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, describe, mutate, events,
    setHostSection: (next: Record<string, unknown>) => { Object.assign(section, next) } }
}

function declareSection(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { [SLOT]: { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

function faceOf(slots: SlotRegistry) {
  const entry = slots.entries(SLOT).find(row => row.component === ThemeSettingsPage)!
  const instance = (entry.store as ReturnType<typeof createThemePageStore>).create()
  const injectPage = entry.inject as NonNullable<typeof entry.inject>
    & ((actions: typeof instance.actions) => ThemeSettingsPageInjected)
  const face = injectPage(instance.actions)
  return { entry, instance, face }
}

describe('ui-theme settings section', () => {
  it('registers after or before the shell declaration, with localized navigation copy', async () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'configForms'])
    const before = await bench()
    declareSection(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries(SLOT)).toHaveLength(1)
    expect(faceOf(before.slots).entry.options).toMatchObject({ id: 'appearance-theme', order: 5 })
    expect(before.locale.bind(SETTINGS_NS)('page.title')).toBe('外观主题')
    before.locale.setLocale('en')
    expect(before.locale.bind(SETTINGS_NS)('page.title')).toBe('Appearance theme')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries(SLOT)).toHaveLength(0)
    declareSection(after.slots)
    await Promise.resolve()
    expect(after.slots.entries(SLOT)).toHaveLength(1)
  })

  it('mirrors snapshots and sends every page choice through the theme service', async () => {
    const b = await bench()
    declareSection(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    const { instance, face } = faceOf(b.slots)
    expect(instance.getSnapshot().preference).toBe('dark')
    face.setAccent('ocean')
    face.setThemeSet('current')
    face.setFontFamily('inter')
    face.setCorners('soft')
    face.setFontSize(16)
    expect(theme.getTheme()).toMatchObject({ accent: 'ocean', themeSet: 'current', fontFamily: 'inter', corners: 'soft', fontSize: 16 })
    expect(instance.getSnapshot()).toMatchObject({ accent: 'ocean', themeSet: 'current', fontFamily: 'inter', corners: 'soft', fontSize: 16 })
    await vi.waitFor(() => { expect(b.mutate).toHaveBeenCalledTimes(6) })
  })

  it('adopts Host updates and keeps non-loopback changes process-local', async () => {
    const b = await bench()
    b.setHostSection({ preference: 'dark', accent: 'forest', fontFamily: 'noto-sans-sc' })
    b.events.emit('settings/document-updated', [THEME_SETTINGS_NAMESPACE, 0])
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    await vi.waitFor(() => { expect(theme.getTheme().accent).toBe('forest') })
    expect(theme.getTheme().fontFamily).toBe('noto-sans-sc')
    const remote = await bench(false)
    await remote.ctx.plugin({ inject: [...inject], apply }).await()
    const remoteTheme = remote.ctx.get('theme') as ThemeRuntime
    remoteTheme.setAccent('coral')
    await Promise.resolve()
    expect(remote.describe).not.toHaveBeenCalled()
    expect(remote.mutate).not.toHaveBeenCalled()
  })

  it('recovers after section collapse and removes its entry and copy on disposal', async () => {
    const b = await bench()
    const host = declareSection(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(SLOT)).toHaveLength(1)
    host()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
    declareSection(b.slots)
    await Promise.resolve()
    expect(b.slots.entries(SLOT)).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
    expect(b.locale.bind(SETTINGS_NS)('page.title')).toBe('page.title')
  })
})
