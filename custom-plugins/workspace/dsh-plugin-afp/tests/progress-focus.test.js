import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createAfpProgressDock } from '../src/client/afp-conversation-progress.js'

// 独立插件副本没有宿主的 React 测试运行时；仓库内使用真实 DOM 和 React 状态更新。
const uiManifest = new URL('../../../../packages/client/ui-primitives/package.json', import.meta.url)
test('closing the progress panel after expanding its trace returns focus to the capsule',
  { skip: !existsSync(uiManifest) }, async t => {
    const requireUi = createRequire(uiManifest)
    const React = requireUi('react'), { createRoot } = requireUi('react-dom/client')
    const { act } = React
    const requireRepo = createRequire(new URL('../../../../package.json', import.meta.url))
    const { JSDOM } = requireRepo('jsdom')
    const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://app.test' })
    const original = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
    const root = createRoot(document.querySelector('main'))
    t.after(async () => {
      await act(async () => root.unmount())
      dom.window.close()
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
    })
    const h = React.createElement
    const UI = {
      Pill: ({ active, ...props }) => h('button', { ...props, type: 'button' }),
      Button: ({ variant, size, ...props }) => h('button', { ...props, type: 'button' }),
      Tag: ({ tone, children }) => h('span', null, children),
      CloseIcon: () => h('span', null, '×'), ChevronIcon: () => h('span', null, '›'),
      AnimatedCollapse: ({ open, children, ...props }) => h('div', { ...props, hidden: !open, 'aria-hidden': !open }, children),
      useDismissOnOutsidePointer() {},
    }
    const turn = { turn: 1, status: 'closed', start: { time: 0 }, end: { time: 1000, data: { reason: { kind: 'completed' } } } }
    const rows = [{ root: { kind: 'tool-result', callId: 'selected', call: { name: 'afp_photo_selection' }, content: [{ type: 'text', text: '{"items":[]}' }] } }]
    const snapshot = { timeline: { turnOrder: [1], turns: new Map([[1, turn]]) }, nodes: { turnDataSource: () => ({ getSnapshot: () => rows }) } }
    const Dock = createAfpProgressDock(React, UI, key => key, { getSnapshot: () => ({ status: {} }) })
    await act(async () => root.render(h(Dock, { sessionId: 'session-focus', useChat: selector => selector(snapshot) })))
    const click = async element => { await act(async () => element.click()) }
    const capsule = document.querySelector('.afp-progress-pill')
    for (const method of ['close-button', 'Escape']) {
      await click(capsule)
      assert.equal(capsule.getAttribute('aria-expanded'), 'true')
      const trace = document.querySelector('.afp-task-trace-toggle')
      if (trace.getAttribute('aria-expanded') !== 'true') await click(trace)
      trace.focus()
      assert.equal(document.activeElement, trace)
      const close = document.querySelector('button[aria-label="close"]')
      close.focus()
      if (method === 'close-button') await click(close)
      else await act(async () => close.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      assert.equal(capsule.getAttribute('aria-expanded'), 'false', method)
      assert.equal(document.activeElement, capsule, method)
      assert.equal(document.getElementById(capsule.getAttribute('aria-controls')).getAttribute('aria-hidden'), 'true')
    }
  })
