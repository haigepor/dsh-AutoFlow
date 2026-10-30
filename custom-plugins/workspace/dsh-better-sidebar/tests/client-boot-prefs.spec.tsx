// @vitest-environment jsdom
import { fromAny } from '@total-typescript/shoehorn'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { api } from '../src/client/api.ts'
import { apply } from '../src/client/index.tsx'
import type { SidebarStore } from '../src/client/state.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

type SettingsView = Awaited<ReturnType<typeof api.settingsGet>>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

const cleanups: Array<() => void> = []

/** 只运行挂载及其资源释放 effect；偏好读取、store 和 Sidebar 样式注入均使用真实实现。 */
function activate() {
  const effects: Array<() => void> = []
  const updates = new Set<() => void>()
  const services = new Map<string, unknown>()
  const locale = { active: 'en' }
  const sessions = { byId: {} }
  let store: SidebarStore | undefined
  let active = true
  const remote = {
    $on: (_event: string, listener: () => void) => {
      updates.add(listener)
      return () => { updates.delete(listener) }
    },
  }
  const owned = new Set([
    'dsh-better-sidebar: sidebar mount',
    'dsh-better-sidebar: native right-Sidebar surface',
    'dsh-better-sidebar: context diagnostics controller',
  ])
  const ctx = fromAny<Context, unknown>({
    locale: { subscribe: () => () => {}, getSnapshot: () => locale, lookup: () => undefined },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessions } },
    get: (name: string) => name === 'remote' ? remote : services.get(name),
    provide: (name: string, value: unknown) => { services.set(name, value) },
    inject: () => ({ dispose() {} }),
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: { inject?: () => { store: SidebarStore } }) => {
        store = options.inject?.().store
        return () => {}
      },
    },
    effect: (effect: () => (() => void) | void, name: string) => {
      if (!owned.has(name)) return
      const dispose = effect()
      if (dispose) effects.push(dispose)
    },
  })
  const dispose = (): void => {
    if (!active) return
    active = false
    act(() => { for (const effect of effects.reverse()) effect() })
  }
  cleanups.push(dispose)
  act(() => { apply(ctx) })
  expect(store).toBeDefined()
  return {
    store: store!,
    updates,
    update: () => { act(() => { for (const listener of updates) listener() }) },
    dispose,
  }
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

beforeEach(() => {
  vi.useFakeTimers()
  const nativeRect = HTMLElement.prototype.getBoundingClientRect
  // jsdom 没有视口布局，避免与偏好加载无关的降级几何同步循环。
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-dsh-panel-host')
      ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
      : nativeRect.call(this)
  })
})

afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) dispose()
  await settle()
  const timers = vi.getTimerCount()
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
  expect(timers, 'unloading must release the mount deadline and every mounted shell timer').toBe(0)
  expect(document.querySelector('[data-dsh-better-sidebar]')).toBeNull()
  expect(document.querySelector('style[data-dsh-custom-css]')).toBeNull()
})

describe('client boot preferences', () => {
  it('mounts on the deadline and later applies the actual stored custom CSS', async () => {
    const settings = deferred<SettingsView>()
    vi.spyOn(api, 'settingsGet').mockReturnValue(settings.promise)
    const boot = activate()
    expect(document.querySelector('[data-dsh-better-sidebar]')).toBeNull()
    await advance(2000)
    expect(document.querySelector('[data-dsh-better-sidebar]')).not.toBeNull()
    expect(document.querySelector('style[data-dsh-custom-css]')).toBeNull()
    settings.resolve({ value: { customCss: ':root { --autoflow-boot: 1; }' } })
    await settle()
    expect(boot.store.getPrefs().customCss).toBe(':root { --autoflow-boot: 1; }')
    expect(document.querySelector('style[data-dsh-custom-css]')?.textContent).toBe(':root { --autoflow-boot: 1; }')
  })

  it('keeps the latest settings when an older request completes afterward', async () => {
    const older = deferred<SettingsView>()
    const latest = deferred<SettingsView>()
    vi.spyOn(api, 'settingsGet').mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)
    const boot = activate()
    boot.update()
    latest.resolve({ value: { customCss: ':root { --latest: 1; }' } })
    await settle()
    older.resolve({ value: { customCss: ':root { --stale: 1; }' }, externalDisable: true })
    await settle()
    expect(boot.store.getPrefs().customCss).toBe(':root { --latest: 1; }')
    expect(boot.store.getSuspended()).toBe(false)
    expect(document.querySelector('style[data-dsh-custom-css]')?.textContent).toBe(':root { --latest: 1; }')
  })

  it('does not postpone the first mount deadline when settings refresh again', async () => {
    const older = deferred<SettingsView>()
    const latest = deferred<SettingsView>()
    vi.spyOn(api, 'settingsGet').mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)
    const boot = activate()
    await advance(1000)
    boot.update()
    await advance(1000)
    expect(document.querySelector('[data-dsh-better-sidebar]')).not.toBeNull()
    older.resolve({ value: {} })
    latest.resolve({ value: { customCss: ':root { --latest: 1; }' } })
    await settle()
    expect(boot.store.getPrefs().customCss).toBe(':root { --latest: 1; }')
  })

  it('does not apply a response or retain a deadline after unload', async () => {
    const settings = deferred<SettingsView>()
    vi.spyOn(api, 'settingsGet').mockReturnValue(settings.promise)
    const boot = activate()
    const setPrefs = vi.spyOn(boot.store, 'setPrefs')
    const setSuspended = vi.spyOn(boot.store, 'setSuspended')
    boot.dispose()
    expect(boot.updates.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    settings.resolve({ value: { customCss: ':root { --disposed: 1; }' } })
    await settle()
    expect(setPrefs).not.toHaveBeenCalled()
    expect(setSuspended).not.toHaveBeenCalled()
    expect(document.querySelector('[data-dsh-better-sidebar]')).toBeNull()
  })

  it('applies a late suspension and keeps it while a later refresh is pending', async () => {
    const settings = deferred<SettingsView>()
    const refresh = deferred<SettingsView>()
    vi.spyOn(api, 'settingsGet').mockReturnValueOnce(settings.promise).mockReturnValueOnce(refresh.promise)
    const boot = activate()
    await advance(2000)
    expect(document.querySelector('[data-dsh-better-sidebar]')).not.toBeNull()
    settings.resolve({ value: {}, externalDisable: true })
    await settle()
    expect(boot.store.getSuspended()).toBe(true)
    expect(document.querySelector('[data-dsh-better-sidebar]')).toBeNull()
    boot.update()
    await advance(2000)
    expect(document.querySelector('[data-dsh-better-sidebar]')).toBeNull()
    refresh.resolve({ value: { customCss: ':root { --resumed: 1; }' }, externalDisable: false })
    await settle()
    expect(document.querySelector('style[data-dsh-custom-css]')?.textContent).toBe(':root { --resumed: 1; }')
  })
})
