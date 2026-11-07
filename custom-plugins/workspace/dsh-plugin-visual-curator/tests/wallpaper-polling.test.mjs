/** Wallpaper observation follows active tasks, shared batch updates and browser visibility. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { createWallpaperCanvas } from '../src/client/wallpaper-canvas.tsx'
import { wallpaperPlanSchema, wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'
import { createCuratorTransport } from '../src/client/transport.ts'
import { largeWallpaperExperience, largeWallpaperView } from './fixtures/wallpaper-transport.ts'

function hookFixture(batch, invoke, windowSize = 1) {
  const cells = [], effects = [], pending = []
  let cursor = 0, dirty = false, value, refreshKey = 0
  const React = {
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], next => {
        const result = typeof next === 'function' ? next(cells[index]) : next
        if (!Object.is(result, cells[index])) { cells[index] = result; dirty = true }
      }]
    },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial } },
    useEffect(work, dependencies) {
      const index = cursor++, previous = effects[index]
      if (previous && dependencies.every((dependency, at) => Object.is(dependency, previous.dependencies[at]))) return
      pending.push(() => { previous?.cleanup?.(); effects[index] = { dependencies, cleanup: work() } })
    },
  }
  const hook = createWallpaperCanvas(React, {}).useWallpaper
  const render = () => { cursor = 0; value = hook(batch, invoke, 2000, 20, refreshKey, windowSize); for (const work of pending.splice(0)) work() }
  render()
  return {
    get value() { return value },
    async flush() { await setImmediate(); while (dirty) { dirty = false; render(); await setImmediate() } },
    update(next) { batch = next; render() },
    refresh() { refreshKey++; render() },
    dispose() { for (const effect of effects) effect?.cleanup?.() },
  }
}
const view = status => ({ runId: 'wallpaper', sourceRunId: 'search', status, settings: wallpaperSettingsSchema.parse({}), state: { version: 1, sourceRunId: 'search', skillVersion: 'fixture', items: [], budgetStopped: false }, resources: {}, sourceImages: {}, total: 0, offset: 0, counts: {}, warnings: [] })

test('responses for another source or image window fail without exposing an editable image', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), target = new EventTarget()
  Object.defineProperty(target, 'hidden', { value: false })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: target })
  try {
    for (const reply of [{ ...view('completed'), sourceRunId: 'other-search' }, { ...view('completed'), offset: 1 }]) {
      const fixture = hookFixture({ kind: 'search', runId: 'search', status: 'completed', matched: 1 }, async () => reply)
      try {
        await fixture.flush()
        assert.equal(fixture.value.error, true)
        assert.equal(fixture.value.value, null)
        assert.equal(fixture.value.item, undefined)
        fixture.value.editPlan()
        assert.equal(fixture.value.planText, null)
      } finally { fixture.dispose() }
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else delete globalThis.document
  }
})

test('four planning cards share one request and page changes cannot expose a stale editor in a hundred-image batch', async () => {
  const previous = globalThis.document, document = new EventTarget()
  document.hidden = false; globalThis.document = document
  const items = Array.from({ length: 100 }, (_, index) => {
    const imageVersionId = `source-${index}`
    const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId, mode: 'single', subject: imageVersionId, evidence: 'Saved source observation', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Visible subject', role: 'subject', rect: { x: 0.3, y: 0.5, width: 0.3, height: 0.2 } }], placement: { scale: 1, left: 0, top: 0 }, reason: 'Saved plan' })
    return { imageVersionId, originalId: imageVersionId, familyId: imageVersionId, status: 'passed', attempts: [{ revision: 1, plan, checks: [], needsOutpaint: false }] }
  })
  const reply = offset => ({ ...view('completed'), total: 100, offset, itemIndex: items.map(item => ({ imageVersionId: item.imageVersionId, status: item.status, planned: true })), state: { ...view('completed').state, items: items.slice(offset, offset + 4) } })
  const calls = [], pending = new Map()
  const invoke = async (operation, args, signal) => {
    assert.equal(operation, 'wallpaper-read'); calls.push({ offset: args.offset, limit: args.limit, signal })
    if (args.offset === 0) return reply(0)
    const deferred = Promise.withResolvers(); pending.set(args.offset, deferred); return deferred.promise
  }
  const fixture = hookFixture({ kind: 'search', runId: 'search', status: 'completed', matched: 100, wallpaper: { runId: 'wallpaper', status: 'completed' } }, invoke, 4)
  try {
    await fixture.flush()
    assert.equal(fixture.value.value.state.items.length, 4)
    fixture.value.page(3); await fixture.flush()
    assert.equal(fixture.value.item.imageVersionId, 'source-3')
    assert.deepEqual(calls.map(call => [call.offset, call.limit]), [[0, 4]])
    fixture.value.editImagePlan('source-2'); await fixture.flush()
    assert.equal(fixture.value.offset, 2)
    assert.equal(JSON.parse(fixture.value.planText).imageVersionId, 'source-2')
    fixture.value.page(7); await fixture.flush()
    assert.equal(fixture.value.value, null); assert.equal(fixture.value.planText, null)
    fixture.value.editImagePlan('source-2'); await fixture.flush()
    assert.equal(fixture.value.planText, null)
    fixture.value.page(99); await fixture.flush()
    pending.get(96).resolve(reply(96)); await fixture.flush()
    assert.equal(fixture.value.item.imageVersionId, 'source-99')
    pending.get(4).resolve(reply(4)); await fixture.flush()
    assert.equal(fixture.value.item.imageVersionId, 'source-99')
    assert.equal(calls.find(call => call.offset === 4).signal.aborted, true)
    assert.deepEqual(calls.map(call => [call.offset, call.limit]), [[0, 4], [4, 4], [96, 4]])
  } finally { fixture.dispose(); globalThis.document = previous }
})

test('a delayed wallpaper page cannot expose or edit the previous source while a newer offset is selected', async () => {
  const { JSDOM } = await import('jsdom'), require = createRequire(import.meta.url), React = require('react'), { act } = React
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://owner.example/', pretendToBeVisual: true }), win = dom.window
  const globals = { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, Element: win.Element, getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const { createRoot } = require('react-dom/client')
  const passthrough = ({ children }) => React.createElement('span', null, children)
  const Button = React.forwardRef(({ children, onClick, disabled, className, ...props }, ref) => React.createElement('button', { ref, onClick, disabled, className, 'aria-label': props['aria-label'] }, children))
  const ui = new Proxy({ Button, Modal: ({ open, children, title }) => open ? React.createElement('section', { role: 'dialog' }, React.createElement('h2', null, title), children) : null, DisclosureRow: ({ children }) => React.createElement('div', null, children), Tag: passthrough }, { get: (target, key) => target[key] ?? passthrough })
  const pages = new Map(), calls = [], updates = []
  const page = offset => {
    const imageVersionId = offset === 0 ? 'source-truck' : offset === 1 ? 'source-middle' : 'source-winter'
    const placement = offset === 0 ? { left: -1265, top: 1080, scale: 0.66 } : { left: -403, top: 0, scale: 0.686911 }
    const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId, mode: 'single', subject: imageVersionId, evidence: 'Saved page source', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Subject', role: 'subject', rect: { x: 0.4, y: 0.4, width: 0.1, height: 0.2 } }], placement, reason: 'Saved plan' })
    return { ...view('completed'), total: 10, offset, counts: { downloaded: 10, planned: 10 }, sourceImages: { [imageVersionId]: { width: 4000, height: 4000, previewPath: `/api/visual-curator/resource?imageVersionId=${imageVersionId}&preview=thumbnail` } }, state: { version: 1, sourceRunId: 'search', skillVersion: 'fixture', budgetStopped: false, items: [{ imageVersionId, originalId: imageVersionId, familyId: `family-${imageVersionId}`, status: 'needs-review', edits: 0, attempts: [{ revision: 1, plan, checks: [], needsOutpaint: true }] }] } }
  }
  const invoke = async (operation, args, signal) => {
    if (operation === 'wallpaper-plan-update') { updates.push(args); return null }
    if (operation !== 'wallpaper-read') throw new Error(`Unexpected page fixture operation: ${operation}`)
    calls.push({ offset: args.offset, signal })
    if (args.offset === 0) return page(0)
    const deferred = pages.get(args.offset) ?? Promise.withResolvers(); pages.set(args.offset, deferred)
    return deferred.promise
  }
  const { useWallpaper, WallpaperNode, Dialogs } = createWallpaperCanvas(React, ui)
  const batch = { kind: 'search', runId: 'search', status: 'completed', matched: 10, wallpaper: { runId: 'wallpaper', status: 'completed' } }
  let control
  function Fixture() {
    control = useWallpaper(batch, invoke, 2000, 10)
    return React.createElement(React.Fragment, null,
      React.createElement('output', { id: 'offset' }, control.offset),
      React.createElement('button', { id: 'next', onClick: () => control.page(control.offset + 1) }, 'Navigate next page'),
      React.createElement(WallpaperNode, { kind: 'planning', control, t: key => key }),
      React.createElement(Dialogs, { control, t: key => key }))
  }
  const root = createRoot(win.document.getElementById('root'))
  const edit = () => [...win.document.querySelectorAll('button')].find(button => button.textContent === 'wallpaperEditPlan')
  try {
    await act(async () => { root.render(React.createElement(Fixture)); await setImmediate() })
    assert.equal(control.item.imageVersionId, 'source-truck')
    await act(async () => { win.document.getElementById('next').click() })
    await act(async () => { win.document.getElementById('next').click() })
    assert.equal(win.document.getElementById('offset').textContent, '2')
    assert.equal(control.value, null, 'A response for offset zero cannot represent selected offset two')
    assert.equal(control.item, undefined); assert.equal(control.attempt, undefined)
    assert.equal(edit(), undefined, 'The loading page cannot expose the previous plan editor')
    await act(async () => { control.editPlan() })
    assert.equal(win.document.querySelector('[role="dialog"]'), null)
    assert.equal(calls.find(call => call.offset === 1).signal.aborted, true)
    await act(async () => { pages.get(1).resolve(page(1)); await setImmediate() })
    assert.equal(control.value, null, 'A cancelled middle-page reply cannot revive old page data')
    await act(async () => { pages.get(2).resolve(page(2)); await setImmediate() })
    assert.equal(control.item.imageVersionId, 'source-winter')
    await act(async () => { edit().click() })
    const dialog = win.document.querySelector('[role="dialog"]'), plan = JSON.parse(dialog.querySelector('textarea').value)
    assert.equal(plan.imageVersionId, 'source-winter')
    assert.deepEqual(plan.placement, { left: -403, top: 0, scale: 0.686911 })
    assert.match(dialog.querySelector('svg image').getAttribute('href'), /imageVersionId=source-winter/)
    await act(async () => { control.page(0); await setImmediate() })
    assert.equal(win.document.querySelector('[role="dialog"]'), null, 'Changing page closes the previous source plan draft')
    assert.equal(control.item.imageVersionId, 'source-truck')
    assert.equal(updates.length, 0)
  } finally {
    await act(async () => { root.unmount() }); win.close()
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

function planDialog(control) {
  const React = {
    Fragment: Symbol('fixture-fragment'), createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect() {}, useId: () => 'plan-dialog-fixture',
  }
  const tree = createWallpaperCanvas(React, { Button: 'button', Modal: 'modal' }).Dialogs({ control, t: key => key })
  const elements = value => Array.isArray(value) ? value.flatMap(elements) : value && typeof value === 'object' ? [value, ...elements(value.props?.children)] : []
  const nodes = elements(tree)
  return {
    apply: nodes.find(node => node.type === 'button' && node.props.children.includes('wallpaperApplyPlan')),
    messages: nodes.filter(node => ['alert', 'status'].includes(node.props?.role)).flatMap(node => node.props.children),
  }
}

test('manual plan validation blocks unsafe geometry before Apply and guards direct JSON submissions', async () => {
  const previous = globalThis.document, document = new EventTarget()
  document.hidden = false; document.baseURI = 'https://fixture.invalid/'; globalThis.document = document
  const valid = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'original', mode: 'single', subject: 'Visible subject', evidence: 'Source pixels', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [
    { name: 'Subject', role: 'subject', rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.5 } },
    { name: 'Critical', role: 'critical', rect: { x: 0.3, y: 0.25, width: 0.2, height: 0.4 } },
  ], placement: { left: 400, top: 900, scale: 0.5 }, reason: 'Protect the actual subject' })
  const cases = [
    { name: 'clock', plan: { ...valid, placement: { ...valid.placement, top: 0 } }, message: 'wallpaperGeometryFailed' },
    { name: 'upper buffer', plan: { ...valid, placement: { ...valid.placement, top: 863 } }, message: 'wallpaperGeometryFailed' },
    { name: 'critical outside', plan: { ...valid, placement: { ...valid.placement, left: 1100 }, regions: [valid.regions[0], { ...valid.regions[1], rect: { x: 0.9, y: 0.25, width: 0.1, height: 0.4 } }] }, message: 'wallpaperGeometryFailed' },
    { name: 'off canvas', plan: { ...valid, placement: { ...valid.placement, left: 1846 } }, message: 'wallpaperGeometryFailed' },
    { name: 'uncertain protection', plan: { ...valid, mode: 'uncertain', uncertainties: ['Protected source is uncertain'] }, message: 'wallpaperUncertainReason' },
    { name: 'wrong original', plan: { ...valid, imageVersionId: 'another-image' }, message: 'wallpaperInvalidPlan' },
    { name: 'valid', plan: valid },
    { name: 'exact buffer edge', plan: { ...valid, placement: { ...valid.placement, top: 864 } } },
    { name: 'missing dimensions', plan: valid, missingSource: true, message: 'wallpaperPlanUnchecked', allowed: true },
  ]
  try {
    for (const sample of cases) {
      const response = view('paused'), updates = []
      response.state.items = [{ imageVersionId: 'candidate', originalId: 'original', familyId: 'source-family', status: 'needs-review', edits: 0, attempts: [{ revision: 1, plan: valid, checks: [], needsOutpaint: true }] }]
      response.total = 1
      response.sourceImages = sample.missingSource ? {} : { original: { width: 1000, height: 2000, previewPath: '/api/visual-curator/resource?imageVersionId=original' } }
      const fixture = hookFixture({ kind: 'search', runId: 'search', status: 'completed', matched: 1 }, async (operation, args) => {
        if (operation === 'wallpaper-read') return response
        if (operation === 'wallpaper-plan-update') { updates.push(args); return null }
        throw new Error(`Unexpected fixture operation: ${operation}`)
      })
      try {
        await fixture.flush(); fixture.value.setPlanText(JSON.stringify(sample.plan)); await fixture.flush()
        const dialog = planDialog(fixture.value), blocked = !!sample.message && !sample.allowed
        assert.equal(dialog.apply.props.disabled, blocked, `${sample.name}: Apply follows validation`)
        if (sample.message) assert(dialog.messages.includes(sample.message), `${sample.name}: show localized guidance before submission`)
        fixture.value.applyPlan(); await fixture.flush()
        assert.equal(updates.length, blocked ? 0 : 1, `${sample.name}: direct JSON action uses the same checks`)
        if (!blocked) assert.deepEqual(updates[0].plan, sample.plan)
        else assert.notEqual(fixture.value.planText, null, 'invalid edits remain available for correction')
      } finally { fixture.dispose() }
    }
  } finally { globalThis.document = previous }
})

test('settled and hidden wallpaper views stay idle while batch changes, visibility and owner actions refresh them', async context => {
  const previous = globalThis.document, document = new EventTarget()
  document.hidden = false; globalThis.document = document
  const calls = [], batch = { kind: 'search', runId: 'search', status: 'completed', matched: 2 }
  let response = null
  const fixture = hookFixture(batch, async (operation, args, signal) => {
    calls.push({ operation, args, signal })
    return operation === 'wallpaper-read' ? response : null
  })
  const reads = () => calls.filter(call => call.operation === 'wallpaper-read')
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await fixture.flush()
    assert.equal(reads().length, 1)
    assert.deepEqual(reads()[0].args, { sourceRunId: 'search', offset: 0, limit: 1 })
    context.mock.timers.tick(20000); await fixture.flush()
    assert.equal(reads().length, 1, 'a batch without a wallpaper task has no fast detail polling')

    response = view('running')
    fixture.update({ ...batch, wallpaper: { runId: 'wallpaper', status: 'running' } }); await fixture.flush()
    assert.equal(reads().length, 2, 'the shared batch observer admits a newly started wallpaper task')
    context.mock.timers.tick(2000); await fixture.flush()
    assert.equal(reads().length, 3)
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange'))
    context.mock.timers.tick(20000); await fixture.flush()
    assert.equal(reads().length, 3, 'hidden views stop detail polling')

    response = view('completed')
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); await fixture.flush()
    assert.equal(reads().length, 4, 'returning to the page refreshes immediately')
    assert.equal(fixture.value.value.status, 'completed')
    context.mock.timers.tick(20000); await fixture.flush()
    assert.equal(reads().length, 4, 'a completed task follows shared updates instead of its own polling loop')

    fixture.refresh(); await fixture.flush()
    assert.equal(reads().length, 5, 'manual refresh revalidates a settled view with an unchanged batch summary')
    fixture.value.control('resume'); await fixture.flush()
    assert.equal(calls.filter(call => call.operation === 'wallpaper-control').length, 1)
    assert.equal(reads().length, 6, 'an explicit owner action refreshes even a settled view')
    const current = reads().at(-1).signal
    fixture.dispose()
    assert.equal(current.aborted, true)
    document.dispatchEvent(new Event('visibilitychange'))
    context.mock.timers.tick(20000); await fixture.flush()
    assert.equal(reads().length, 6, 'unmount removes visibility observation and queued reads')
  } finally { fixture.dispose(); context.mock.timers.reset(); globalThis.document = previous }
})

test('the canvas loads large wallpaper artifacts and experience through the HTTP transport without a generic failure', async () => {
  const previous = globalThis.document, document = new EventTarget()
  document.hidden = false; globalThis.document = document
  const saved = largeWallpaperView(), experience = largeWallpaperExperience(), operations = []
  const transport = createCuratorTransport({ baseUrl: 'https://owner.example/dsh/', signal: new AbortController().signal,
    action: async () => { throw new Error('The bounded action route would reject this view') },
    fetch: async (_url, options) => {
      const input = JSON.parse(options.body); operations.push(input.operation)
      return Response.json({ ok: true, value: input.operation === 'wallpaper-read' ? saved : input.operation === 'wallpaper-experience' ? experience : { settings: saved.settings, models: [] } })
    },
  })
  const fixture = hookFixture({ kind: 'search', runId: 'search', status: 'completed', matched: 1, wallpaper: { runId: 'wallpaper', status: 'completed' } }, transport.invoke)
  try {
    await fixture.flush()
    assert.equal(fixture.value.error, false)
    assert.deepEqual(fixture.value.value, saved)
    assert.equal(fixture.value.item.imageVersionId, 'source')
    assert.equal(fixture.value.attempt.outputId, 'output-2')
    assert.equal(fixture.value.value.previewResources[fixture.value.attempt.outputId], '/api/visual-curator/resource?imageVersionId=output-2&preview=thumbnail')
    fixture.value.setRevision({ image: 'source', revision: 1 }); await fixture.flush()
    assert.equal(fixture.value.attempt.outputId, 'output-0')
    fixture.value.editPlan(); await fixture.flush()
    assert.deepEqual(JSON.parse(fixture.value.planText), saved.state.items[0].attempts[0].plan)
    fixture.value.showExperience(); await fixture.flush()
    assert.equal(fixture.value.error, false)
    assert.equal(fixture.value.experienceOpen, true)
    assert.deepEqual(fixture.value.experience, experience)
    assert.deepEqual(operations, ['wallpaper-read', 'wallpaper-experience', 'wallpaper-options', 'wallpaper-read'])
  } finally { fixture.dispose(); globalThis.document = previous }
})

test('terminal Session wallpaper views renew once at expiry, update an open preview and suspend renewal while hidden', async context => {
  const previous = globalThis.document, document = new EventTarget()
  document.hidden = false; document.baseURI = 'https://owner.example/dsh/'; globalThis.document = document
  let now = 1_000_000, expiry = now + 100, generation = 0
  context.mock.method(Date, 'now', () => now)
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = [], batch = { kind: 'search', runId: 'search', status: 'completed', matched: 1, wallpaper: { runId: 'wallpaper', status: 'completed' } }
  const fixture = hookFixture(batch, async (operation, args, signal) => {
    calls.push({ operation, args, signal })
    if (now > expiry) { expiry = now + 100; generation++ }
    return { ...view('completed'), sourceRunId: args.sourceRunId, resourceExpiresAt: expiry, resources: { image: `/api/visual-curator/resource?imageVersionId=image&sessionToken=grant-${generation}` } }
  })
  const advance = async milliseconds => { now += milliseconds; context.mock.timers.tick(milliseconds); await fixture.flush() }
  try {
    await fixture.flush(); assert.equal(calls.length, 1)
    fixture.value.setPreview('https://owner.example/dsh/api/visual-curator/resource?imageVersionId=image&sessionToken=grant-0'); await fixture.flush()
    await advance(99); assert.equal(calls.length, 1, 'Unexpired grants cause no terminal polling')
    await advance(2); assert.equal(calls.length, 2)
    assert.equal(fixture.value.value.resourceExpiresAt, expiry)
    assert.match(fixture.value.preview, /sessionToken=grant-1/)
    await advance(50); assert.equal(calls.length, 2)
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange'))
    await advance(1000); assert.equal(calls.length, 2, 'Hidden views cancel their resource-expiry timer')
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); await fixture.flush()
    assert.equal(calls.length, 3); assert.match(fixture.value.preview, /sessionToken=grant-2/)
    fixture.update({ ...batch, runId: 'another-source' }); await fixture.flush()
    assert.equal(fixture.value.preview, null, 'Changing source closes the earlier resource preview')
    assert(calls.every(call => call.args.limit === 1), 'Expiry and visibility renewals retain the single-item read window')
    const total = calls.length
    fixture.dispose(); await advance(1000)
    assert.equal(calls.length, total)
    assert.equal(calls.at(-1).signal.aborted, true)
  } finally { fixture.dispose(); context.mock.timers.reset(); globalThis.document = previous }
})

test('an unchanged expired wallpaper receipt triggers one renewal attempt without a busy loop', async context => {
  const previous = globalThis.document, document = new EventTarget()
  document.hidden = false; globalThis.document = document
  context.mock.method(Date, 'now', () => 1000)
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  const fixture = hookFixture({ kind: 'search', runId: 'search', status: 'completed', matched: 1 }, async () => { reads++; return { ...view('completed'), resourceExpiresAt: 999 } })
  try {
    await fixture.flush(); assert.equal(reads, 1)
    context.mock.timers.tick(1); await fixture.flush(); assert.equal(reads, 2)
    context.mock.timers.tick(20000); await fixture.flush(); assert.equal(reads, 2)
  } finally { fixture.dispose(); context.mock.timers.reset(); globalThis.document = previous }
})
