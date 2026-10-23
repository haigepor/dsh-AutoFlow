// @vitest-environment jsdom
/** Role typography shortcuts retain independent sizes and settle durable writes together. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ThemeRuntime, type ThemeSnapshot, type ThemeSettings } from '../src/client/index.ts'
import type { Shortcuts, ShortcutContext, ShortcutFixedInput, ShortcutGesture, ShortcutPlatform } from '@deepseek-ai/dsh-client-shortcuts/client'
import { normalizeBinding, presentBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
/** Deliver the keyboard service's arbitrated input while keeping its real catalog and bindings. */
function fontKeyboard(ctx: Context, runtime: Shortcuts['runtime'] = 'desktop', platform: ShortcutPlatform = 'macos') {
  onTestFinished(() => ctx.fiber.dispose())
  const registry = new ShortcutRegistry(runtime, platform)
  const listeners = new Set<(input: ShortcutFixedInput) => void>()
  const shortcuts: Pick<Shortcuts, 'runtime' | 'platform' | 'registerFixed' | 'describeBinding' | 'observeFixedInput'> = {
    runtime, platform,
    registerFixed: command => registry.registerFixed(command),
    describeBinding: (candidate) => {
      const binding = candidate === null ? null : normalizeBinding(candidate, platform)
      return { binding, keys: presentBinding(binding, platform).keys, issue: null, conflicts: [] }
    },
    observeFixedInput: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  ctx.provide('shortcuts', shortcuts)
  return {
    registry,
    press: (gesture: Partial<ShortcutGesture> = {}, context: Partial<ShortcutContext> = {}) => {
      const consume = vi.fn()
      for (const listener of listeners) listener({
        type: 'keydown', consume,
        gesture: { code: 'Equal', meta: platform === 'macos', control: platform !== 'macos', alt: false,
          shift: false, repeat: false, composing: false, defaultPrevented: false, ...gesture },
        context: { region: 'page', modal: null, target: null, ...context },
      })
      return consume
    },
    reset: () => { for (const listener of listeners) listener({ type: 'reset' }) },
  }
}

/** Isolate theme write outcomes behind the same registered keyboard input. */
async function keyboardTheme(host = stubConfigForm<ThemeSettings>()) {
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const keyboard = fontKeyboard(ctx)
  const events: ThemeSnapshot[] = []
  ctx.on('theme/change', (snapshot) => { events.push(snapshot) })
  await ctx.plugin({ apply: (scope) => {
    scope.provide('theme', new ThemeRuntime(scope, host.scope))
  } }).await()
  return { theme: ctx.get('theme') as ThemeRuntime, keyboard, events, host }
}

describe('ui-theme apply', () => {
  it('steps all font sizes in one settings mutation and one snapshot', async () => {
    const { theme, keyboard, events, host } = await keyboardTheme()
    keyboard.press()
    expect(theme.getTheme().fontSizes).toEqual({ text: 15, code: 12, terminal: 14 })
    expect(host.mutate).toHaveBeenCalledExactlyOnceWith([
      { op: 'set', path: ['fontSize'], value: 15 },
      { op: 'set', path: ['codeFontSize'], value: 12 },
      { op: 'set', path: ['terminalFontSize'], value: 14 },
    ])
    expect(host.set).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]?.fontSizes).toEqual({ text: 15, code: 12, terminal: 14 })
  })

  it('continues stepping other font roles when one has reached its own limit', async () => {
    const { theme, keyboard, host } = await keyboardTheme()
    theme.setFontSize('text', 22)
    theme.setFontSize('code', 10)
    theme.setFontSize('terminal', 20)
    keyboard.press()
    expect(theme.getTheme().fontSizes).toEqual({ text: 22, code: 11, terminal: 20 })
    expect(host.mutate).toHaveBeenCalledExactlyOnceWith([
      { op: 'set', path: ['codeFontSize'], value: 11 },
    ])
    keyboard.press({ code: 'Minus' })
    expect(theme.getTheme().fontSizes).toEqual({ text: 21, code: 10, terminal: 19 })
    keyboard.press({ code: 'Minus' })
    expect(theme.getTheme().fontSizes).toEqual({ text: 20, code: 10, terminal: 18 })
    expect(host.mutate).toHaveBeenLastCalledWith([
      { op: 'set', path: ['fontSize'], value: 20 },
      { op: 'set', path: ['terminalFontSize'], value: 18 },
    ])
  })

  it('adopts all durable font sizes together after a refused batch settles', async () => {
    const host = stubConfigForm<ThemeSettings>()
    const section: ThemeSettings = { accent: 'iris', themeSet: 'official', glideDuration: 220, fontFamily: 'system', corners: 'standard', preference: 'system', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
      textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }
    host.publish({ status: 'ready', value: section, revision: 1, writable: true })
    const { theme, keyboard } = await keyboardTheme(host)
    const write = Promise.withResolvers<boolean>()
    host.mutate.mockReturnValue(write.promise)
    keyboard.press()
    host.publish({ value: section, revision: 2 })
    expect(theme.getTheme().fontSizes).toEqual({ text: 15, code: 12, terminal: 14 })
    write.resolve(false)
    await vi.waitFor(() => { expect(theme.getTheme().fontSizes).toEqual({ text: 14, code: 11, terminal: 13 }) })
  })

})
