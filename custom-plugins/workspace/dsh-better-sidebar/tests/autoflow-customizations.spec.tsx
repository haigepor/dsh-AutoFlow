// @vitest-environment jsdom
import { fromAny } from '@total-typescript/shoehorn'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { api } from '../src/client/api.ts'
import { ChangesTab } from '../src/client/changes/ChangesTab.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

// 伴随包发布 JavaScript；测试直接加载其实现，保留主包的严格类型检查。
const { installChangesMotion } = fromAny<{ installChangesMotion(doc: Document): () => void }, unknown>(
  createRequire(import.meta.url)('../updater/src/client/changes-motion.js'),
)
const testDirectory = dirname(fileURLToPath(import.meta.url))
const customCss = readFileSync(resolve(testDirectory, '../customizations/file-changes.css'), 'utf8')
const companionCss = readFileSync(resolve(testDirectory, '../updater/src/client/styles.css'), 'utf8')
const motionProperties = ['--dsh-changes-x', '--dsh-changes-y', '--dsh-changes-width', '--dsh-changes-height']

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

it('keeps measured local lens and filter selections with keyboard navigation and releases their observers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const restoreGeometry: Array<() => void> = []
  const resizeObservers: TrackedResizeObserver[] = []
  const mutationObservers: TrackedMutationObserver[] = []
  const resizeDescriptor = Object.getOwnPropertyDescriptor(window, 'ResizeObserver')
  const mutationDescriptor = Object.getOwnPropertyDescriptor(window, 'MutationObserver')
  const NativeMutationObserver = window.MutationObserver

  class TrackedResizeObserver implements ResizeObserver {
    readonly observed = new Set<Element>()
    disconnected = false
    constructor(private readonly callback: ResizeObserverCallback) { resizeObservers.push(this) }
    observe(target: Element): void { this.observed.add(target) }
    unobserve(target: Element): void { this.observed.delete(target) }
    disconnect(): void { this.disconnected = true; this.observed.clear() }
    resize(): void { if (!this.disconnected) this.callback([], this) }
  }
  class TrackedMutationObserver extends NativeMutationObserver {
    disconnected = false
    constructor(callback: MutationCallback) { super(callback); mutationObservers.push(this) }
    override disconnect(): void { this.disconnected = true; super.disconnect() }
  }
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: TrackedResizeObserver })
  Object.defineProperty(window, 'MutationObserver', { configurable: true, value: TrackedMutationObserver })
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  const computedStyle = window.getComputedStyle.bind(window)
  // jsdom 不计算伪元素；元素本身仍使用实际 CSS，伪元素读取仅用于触发样式刷新。
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  const frame = async (): Promise<void> => {
    await settle()
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
    await settle()
  }
  const geometry = (element: HTMLElement, left: number, width: number, height: number): void => {
    for (const [property, value] of Object.entries({ offsetLeft: left, offsetTop: 0, offsetWidth: width, offsetHeight: height })) {
      const original = Object.getOwnPropertyDescriptor(element, property)
      restoreGeometry.push(() => {
        if (original) Object.defineProperty(element, property, original)
        else Reflect.deleteProperty(element, property)
      })
      Object.defineProperty(element, property, { configurable: true, get: () => value })
    }
  }
  const style = document.createElement('style')
  style.textContent = `${customCss}\n${companionCss}`
  document.head.append(style)
  const container = document.createElement('div')
  container.setAttribute('data-dsh-native-tab-host', '')
  document.body.append(container)
  const root = createRoot(container)
  let stopMotion: (() => void) | undefined

  try {
    vi.spyOn(api, 'gitStatus').mockResolvedValue({ isRepo: false, entries: [] })
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: '', names: [] })
    vi.spyOn(api, 'changesOps').mockResolvedValue({ events: [], lastSeq: -1 })
    act(() => {
      root.render(createElement(ChangesTab, {
        ctx: fromAny<Context, unknown>({ get: () => undefined }), store: createSidebarStore(),
        scope: { sessionId: 'autoflow-customizations', cwd: 'C:/repo' },
        tab: { id: 'git', type: 'git', title: 'Git' }, visible: true,
      }))
    })
    await frame()
    const tabs = container.querySelector<HTMLElement>('[role="tablist"]')!
    const [gitTab, sessionTab] = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const filters = container.querySelector<HTMLElement>('[role="group"]')!
    const filterButtons = [...filters.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
    expect(gitTab).toBeDefined()
    expect(sessionTab).toBeDefined()
    expect(filterButtons).toHaveLength(4)
    geometry(gitTab!, 4, 40, 40)
    geometry(sessionTab!, 64, 84, 40)
    for (const [index, button] of filterButtons.entries()) geometry(button, index * 44, 36, 24)
    tabs.style.setProperty('--dsh-changes-x', '7px')
    stopMotion = installChangesMotion(document)
    await frame()
    expect(tabs.getAttribute('data-dsh-changes-motion')).toBe('tabs')
    expect(computedStyle(tabs).getPropertyValue('--dsh-changes-motion-enabled').trim()).toBe('1')
    expect(tabs.style.getPropertyValue('--dsh-changes-x')).toBe('4px')
    expect(tabs.style.getPropertyValue('--dsh-changes-width')).toBe('40px')

    act(() => {
      gitTab!.focus()
      gitTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await frame()
    expect(document.activeElement).toBe(sessionTab)
    expect(sessionTab!.getAttribute('aria-selected')).toBe('true')
    const sessionPanel = document.getElementById(sessionTab!.getAttribute('aria-controls')!)!
    expect(sessionPanel.hidden).toBe(false)
    expect(sessionPanel.getAttribute('aria-labelledby')).toBe(sessionTab!.id)
    expect(tabs.style.getPropertyValue('--dsh-changes-x')).toBe('64px')
    expect(tabs.style.getPropertyValue('--dsh-changes-width')).toBe('84px')
    expect(filters.getAttribute('data-dsh-changes-motion')).toBe('filters')
    expect(computedStyle(filters).getPropertyValue('--dsh-changes-motion-enabled').trim()).toBe('1')

    act(() => { filterButtons[1]!.click() })
    await frame()
    expect(filterButtons[1]!.getAttribute('aria-pressed')).toBe('true')
    expect(filters.style.getPropertyValue('--dsh-changes-x')).toBe('44px')
    geometry(filterButtons[1]!, 44, 78, 24)
    const filterObserver = resizeObservers.find(observer => observer.observed.has(filters))!
    expect(filterObserver).toBeDefined()
    filterObserver.resize()
    await frame()
    expect(filters.style.getPropertyValue('--dsh-changes-width')).toBe('78px')

    window.dispatchEvent(new Event('resize'))
    expect(frames.size).toBeGreaterThan(0)
    const dispose = stopMotion
    stopMotion = undefined
    dispose()
    expect(frames.size).toBe(0)
    expect(mutationObservers.every(observer => observer.disconnected)).toBe(true)
    expect(resizeObservers.every(observer => observer.disconnected && observer.observed.size === 0)).toBe(true)
    for (const element of [tabs, filters]) {
      expect(element.hasAttribute('data-dsh-changes-motion')).toBe(false)
      expect(element.hasAttribute('data-dsh-changes-motion-ready')).toBe(false)
      for (const property of motionProperties) expect(element.style.getPropertyValue(property)).toBe(element === tabs && property === '--dsh-changes-x' ? '7px' : '')
    }
    const requests = requestFrame.mock.calls.length
    filterButtons[0]!.setAttribute('aria-pressed', 'true')
    window.dispatchEvent(new Event('resize'))
    await settle()
    expect(requestFrame.mock.calls).toHaveLength(requests)
  } finally {
    stopMotion?.()
    await act(async () => { root.unmount(); await Promise.resolve() })
    container.remove()
    style.remove()
    for (const restore of restoreGeometry.reverse()) restore()
    if (resizeDescriptor) Object.defineProperty(window, 'ResizeObserver', resizeDescriptor)
    else Reflect.deleteProperty(window, 'ResizeObserver')
    if (mutationDescriptor) Object.defineProperty(window, 'MutationObserver', mutationDescriptor)
    else Reflect.deleteProperty(window, 'MutationObserver')
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})
