import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createWorkbench } from '../src/client/workbench.js'

const requireUi = createRequire(new URL('../../../../packages/client/ui-primitives/package.json', import.meta.url))
const React = requireUi('react'), { act } = React
const requireRepo = createRequire(new URL('../../../../package.json', import.meta.url)), { JSDOM } = requireRepo('jsdom')
const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })

async function mount(options = {}, initialState = {}) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://workbench.test/' })
  const original = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = requireUi('react-dom/client')
  dom.window.HTMLElement.prototype.scrollIntoView = function () {}
  const root = createRoot(document.querySelector('main')), h = React.createElement
  const Button = ({ children, onClick, disabled, className, icon, ...props }) => h('button', { onClick, disabled, className, type: 'button', ...(props['aria-label'] ? { 'aria-label': props['aria-label'] } : {}) }, icon, children)
  const UI = new Proxy({
    Button,
    Input: ({ value, onChange, placeholder, className, disabled, ...props }) => h('input', { value, onChange, placeholder, className, disabled, 'aria-label': props['aria-label'] }),
    Tag: ({ children }) => h('span', null, children),
    Checkbox: ({ checked, onChange, label }) => h('label', null, h('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }), label),
    SegmentedControl: ({ options, value, onChange }) => h('nav', null, ...options.map(item => h('button', { key: item.value, 'aria-pressed': value === item.value, onClick: () => onChange(item.value) }, item.label))),
    Tooltip: ({ children }) => children,
    Modal: ({ open, children, footer, title }) => open ? h('section', { role: 'dialog' }, title, children, footer) : null,
    Menu: ({ anchor }) => anchor,
    AnimatedCollapse: ({ open, children }) => h('div', { hidden: !open }, children),
    ImageLightbox: ({ src, alt, onClose }) => h('div', { role: 'dialog' }, h('img', { src, alt }), h('button', { onClick: onClose }, 'close')),
  }, { get: (target, name) => target[name] ?? (() => h('span', null)) })
  const shot = { purpose: 'cover', paragraphs: [1], rationale: 'Article evidence', subject: 'River', action: 'Flowing', environment: 'Forest', composition: 'Wide view', lighting: 'Daylight', colors: 'Natural', style: 'Editorial', details: 'Water', avoid: 'Text', prompt: 'A river flowing through a forest', ratio: '16:9', sceneHash: 'same', promptSceneHash: 'same' }
  const detail = { id: 'a'.repeat(32), url: 'https://example.com/article', category: 'Travel', state: 'review', revision: 1, article: { title: 'Article', paragraphs: [{ id: 1, text: 'Original body' }], language: 'en' }, plan: { brief: { theme: 'River', facts: ['Water flows'], subjects: ['River'], scenes: ['Forest'] }, shots: [shot] }, approval: null, ...options }
  let state = { status: { source: { url: '', mapping: { link: 'Links', category: 'Category', language: '', notes: '' } }, features: ['tools', 'ui-panel'] }, page: { items: [detail], categories: [], total: 1, nextOffset: null }, detail, selected: detail.id, offset: 0, category: '', busy: false, ...initialState }
  const listeners = new Set(), calls = [], drafts = new Map(), reload = vi.fn()
  const store = { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => state, mutate: async (operation, args) => { calls.push({ operation, args }); return {} }, reload, select() {}, filter() {}, page() {}, getEditorDraft: id => drafts.has(id) ? structuredClone(drafts.get(id)) : null, setEditorDraft: (id, value) => drafts.set(id, structuredClone(value)), clearEditorDraft: id => drafts.delete(id) }
  const Workbench = createWorkbench(React, UI, store, key => key, () => {})
  await act(async () => root.render(h(Workbench)))
  cleanups.push(async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } })
  const button = label => [...document.querySelectorAll('button')].find(element => element.textContent === label)
  const click = async element => { expect(element).toBeTruthy(); await act(async () => element.click()) }
  const change = async (element, value) => { await act(async () => { const prototype = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }) }
  const field = label => [...document.querySelectorAll('label')].find(element => element.querySelector('span')?.textContent === label)?.querySelector('input,textarea')
  return { calls, detail, reload, button, click, change, field, async remount() { await act(async () => root.render(null)); await act(async () => root.render(h(Workbench))) }, async publish(patch) { state = { ...state, ...patch }; await act(async () => { for (const listener of listeners) listener() }) } }
}

describe('article workflow workbench', () => {
  it('keeps loaded articles and refresh available without a full-width error after polling fails', async () => {
    const ui = await mount()
    await ui.publish({ error: 'network' })
    expect(document.querySelector('.ai-list').textContent).toContain('Article')
    expect(document.querySelector('.ai-body').textContent).toContain('Original body')
    expect(document.body.textContent).not.toContain('loadFailed')
    expect(ui.button('retry')).toBeUndefined()
    expect(ui.button('refresh').disabled).toBe(false)
    await ui.click(ui.button('refresh'))
    expect(ui.reload).toHaveBeenCalledOnce()
  })

  it('keeps a retry action when the initial load fails without any status data', async () => {
    const ui = await mount({}, { status: null, page: null, detail: null, selected: null, error: 'network' })
    expect(document.querySelector('.ai-loading [role="alert"]').textContent).toContain('loadFailed')
    expect(ui.button('retry').disabled).toBe(false)
    await ui.click(ui.button('retry'))
    expect(ui.reload).toHaveBeenCalledOnce()
  })

  it('keeps polling error codes in Debug while excluding arbitrary error text', async () => {
    const ui = await mount({ run: { id: 'run-1', attemptId: 'attempt-1', stage: 'capturing', status: 'failed', counts: {} } })
    await ui.publish({ error: 'article-network' })
    await ui.click(ui.button('tab_diagnostics'))
    await ui.click(ui.button('diagnosticsTab_debug'))
    expect(JSON.parse(document.querySelector('.ai-debug-data pre').textContent).clientReadError).toBe('article-network')
    await ui.publish({ error: 'https://private.test/?token=secret-value' })
    expect(document.querySelector('.ai-debug-data pre').textContent).not.toContain('secret-value')
    expect(JSON.parse(document.querySelector('.ai-debug-data pre').textContent).clientReadError).toBe('workbench-read-failed')
  })

  it('preserves a local scene draft during polling and refuses to save over a newer revision', async () => {
    const ui = await mount()
    await ui.click(ui.button('tab_prompts'))
    await ui.click(ui.button('sceneDetails'))
    await ui.change(ui.field('subject'), 'Forest canopy')
    expect(ui.field('subject').value).toBe('Forest canopy')
    await ui.publish({ detail: { ...ui.detail, revision: 2, plan: { ...ui.detail.plan, brief: { ...ui.detail.plan.brief, theme: 'New remote theme' } } } })
    expect(ui.field('subject').value).toBe('Forest canopy')
    expect(document.body.textContent).toContain('staleDraft')
    expect(ui.button('savePlan').disabled).toBe(true)
    expect(ui.calls).toHaveLength(0)
    await ui.click(ui.button('loadLatest'))
    expect(document.querySelector('[role="dialog"]').textContent).toContain('unsavedTitle')
    await ui.click(ui.button('keepEditing'))
    expect(ui.field('subject').value).toBe('Forest canopy')
    await ui.click(ui.button('loadLatest'))
    await ui.click(ui.button('discard'))
    expect(ui.field('theme').value).toBe('New remote theme')
    expect(ui.field('subject').value).toBe('River')
  })

  it('marks scene edits unsynchronized and submits only explicit synchronization confirmations', async () => {
    const ui = await mount()
    await ui.click(ui.button('tab_prompts'))
    await ui.click(ui.button('sceneDetails'))
    await ui.change(ui.field('subject'), 'Forest canopy')
    expect(document.body.textContent).toContain('promptNeedsSync')
    expect(ui.button('approve').disabled).toBe(true)
    await ui.click(ui.button('confirmPromptSync'))
    await ui.click(ui.button('savePlan'))
    expect(ui.calls.at(-1)).toMatchObject({ operation: 'save-plan', args: { revision: 1, syncPromptShots: [0], plan: { shots: [{ subject: 'Forest canopy' }] } } })
  })

  it('cannot approve known source omissions through the source verification action', async () => {
    const ui = await mount({ state: 'needs-source-review', snapshot: { id: 'c'.repeat(32), blocks: [{ id: 'b1', type: 'paragraph', inline: [{ text: 'Captured content' }] }], assets: [], quality: { status: 'partial', reasons: ['unhandled-pagination'] } } })
    expect(document.body.textContent).toContain('knownMissingHint')
    expect(ui.button('reviewAndAnalyze')).toBeUndefined()
    expect(ui.calls).toHaveLength(0)
  })

  it('requires verification evidence and a separate explicit action before source review starts analysis', async () => {
    const ui = await mount({ state: 'needs-source-review', snapshot: { id: 'c'.repeat(32), blocks: [{ id: 'b1', type: 'paragraph', inline: [{ text: 'Captured content' }] }], assets: [], quality: { status: 'needs-review', reasons: ['unknown-article-scope'] } } })
    expect(ui.button('reviewAndAnalyze').disabled).toBe(true)
    await ui.change(ui.field('sourceReviewEvidence'), 'Compared article ending and all original figures with the public source')
    expect(ui.calls).toHaveLength(0)
    await ui.click(ui.button('reviewAndAnalyze'))
    expect(ui.calls).toEqual([{ operation: 'review-source', args: { id: ui.detail.id, revision: 1, evidence: 'Compared article ending and all original figures with the public source' } }])
  })

  it('clears prompt synchronization after another edit to the confirmed scene', async () => {
    const ui = await mount()
    await ui.click(ui.button('tab_prompts'))
    await ui.click(ui.button('sceneDetails'))
    await ui.change(ui.field('subject'), 'Forest canopy')
    await ui.click(ui.button('confirmPromptSync'))
    await ui.change(ui.field('subject'), 'Mountain peak')
    expect(document.body.textContent).toContain('promptNeedsSync')
    await ui.click(ui.button('savePlan'))
    expect(ui.calls.at(-1).args.syncPromptShots).toEqual([])
  })

  it('shows persisted model activity without a percentage and only stops on an explicit action', async () => {
    const ui = await mount({ state: 'understanding', run: { id: 'run-1', stage: 'understanding', status: 'running', counts: { blocksCompleted: 5, blocksTotal: 10 } } })
    expect(document.querySelector('.ai-workflow-progress')).toBeNull()
    expect(ui.calls).toHaveLength(0)
    await ui.click(ui.button('stop'))
    expect(ui.calls).toEqual([{ operation: 'stop', args: { id: 'run-1' } }])
  })

  it('ticks locally between polls, freezes terminal elapsed time and exposes persisted diagnostics', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      vi.setSystemTime(new Date('2026-10-17T00:00:00Z'))
      const run = { id: 'run-1', attemptId: 'attempt-1', stage: 'capturing', status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), counts: {}, events: [{ seq: 1, at: new Date().toISOString(), stage: 'capturing', event: 'document-loaded', details: { statusCode: 200, chars: 0 } }] }
      const ui = await mount({ run, state: 'capturing' })
      expect(document.querySelector('.ai-run-diagnostics')).toBeNull()
      await ui.click(ui.button('tab_diagnostics'))
      expect(document.querySelector('.ai-elapsed time').textContent).toBe('00:00')
      await act(async () => { vi.advanceTimersByTime(2000) })
      expect(document.querySelector('.ai-elapsed time').textContent).toBe('00:02')
      expect(ui.calls).toHaveLength(0)
      expect(document.querySelector('.ai-debug-data').hidden).toBe(true)
      await ui.click(ui.button('diagnosticsTab_debug'))
      expect(document.querySelector('.ai-debug-data').hidden).toBe(false)
      await ui.publish({ detail: { ...ui.detail, state: 'failed', run: { ...run, status: 'failed', updatedAt: new Date().toISOString(), error: 'article-short' } } })
      await act(async () => { vi.advanceTimersByTime(5000) })
      expect(document.querySelector('.ai-elapsed time').textContent).toBe('00:02')
      expect(document.querySelector('.ai-debug-data').hidden).toBe(false)
      expect(document.querySelector('.ai-run-events').textContent).toContain('200')
      expect(JSON.parse(document.querySelector('.ai-debug-data pre').textContent)).toMatchObject({ error: 'article-short', events: [{ details: { statusCode: 200 } }] })
      await ui.click(ui.button('diagnosticsTab_logs'))
      expect(document.querySelector('.ai-debug-data').hidden).toBe(true)
      expect(document.querySelector('[role="progressbar"]')).toBeNull()
    } finally { while (cleanups.length) await cleanups.pop()(); vi.useRealTimers() }
  })

  it('uses the original article illustration while capture is pending', async () => {
    const ui = await mount({ state: 'capturing', article: null, plan: null, run: { id: 'run-1', attemptId: 'attempt-1', stage: 'capturing', status: 'running', counts: {} } })
    expect(document.querySelector('.ai-retrieving .ai-illustration')).not.toBeNull()
    expect(document.querySelector('.ai-workflow-progress,.ai-processing-workspace,.ai-document-placeholder')).toBeNull()
    expect(document.querySelector('.ai-retrieving h3').textContent).toBe('retrieving')
    await ui.click(ui.button('tab_diagnostics'))
    expect(document.querySelector('.ai-diagnostics-page')).not.toBeNull()
    await ui.click(ui.button('tab_article'))
    expect(document.querySelector('.ai-retrieving .ai-illustration')).not.toBeNull()
    expect(ui.calls).toHaveLength(0)
  })

  it.each(['failed', 'cancelled', 'interrupted'])('retains explicit recovery without a task card after %s', async status => {
    const ui = await mount({ state: status, error: 'article-restricted', run: { id: 'run-1', stage: 'capturing', status, error: 'article-restricted', counts: {} } })
    expect(document.querySelector('.ai-workflow-progress,.ai-processing-workspace')).toBeNull()
    expect(document.querySelector('.ai-fetch-notice[role="alert"]').textContent).toBe('error_article-restricted')
    expect(ui.calls).toHaveLength(0)
    await ui.click(ui.button('resume'))
    expect(ui.calls).toEqual([{ operation: 'resume', args: { id: 'run-1' } }])
  })

  it('ends approved work at a reviewed plan without a generation control', async () => {
    const ui = await mount({ state: 'approved', approval: { revision: 1 } })
    await ui.publish({ detail: { ...ui.detail, plan: { ...ui.detail.plan, inputHash: 'current-input' } } })
    await ui.click(ui.button('tab_results'))
    expect(document.body.textContent).toContain('reviewCompleteHint')
    expect(ui.button('generate')).toBeUndefined()
    expect(ui.calls).toHaveLength(0)
  })

  it('locks editors during a remote mutation before its new revision is loaded', async () => {
    const ui = await mount()
    await ui.click(ui.button('tab_prompts'))
    await ui.click(ui.button('sceneDetails'))
    await ui.publish({ busy: true })
    expect(ui.field('subject').disabled).toBe(true)
    expect(ui.field('prompt').disabled).toBe(true)
    await ui.publish({ busy: false })
    expect(ui.field('subject').disabled).toBe(false)
  })

  it('keeps historical legacy approval separate from completion of the new workflow', async () => {
    const ui = await mount({ state: 'approved', legacy: true, approval: { revision: 1 } })
    await ui.click(ui.button('tab_results'))
    expect(document.body.textContent).toContain('reviewPendingHint')
    expect(document.body.textContent).not.toContain('reviewCompleteHint')
  })

  it('restores an unsaved plan after switching away from and remounting the panel', async () => {
    const ui = await mount()
    await ui.click(ui.button('tab_prompts'))
    await ui.click(ui.button('sceneDetails'))
    await ui.change(ui.field('subject'), 'Unsaved forest scene')
    await ui.remount()
    expect(ui.field('subject').value).toBe('Unsaved forest scene')
    expect(document.body.textContent).toContain('unsaved')
    expect(ui.calls).toHaveLength(0)
  })

  it('restores an unsaved manual article when its panel remounts', async () => {
    const ui = await mount()
    await ui.click(ui.button('manual'))
    await ui.change(ui.field('manualBody'), 'Unsaved complete article text')
    await ui.remount()
    expect(ui.field('manualBody').value).toBe('Unsaved complete article text')
    expect(ui.calls).toHaveLength(0)
  })
})
