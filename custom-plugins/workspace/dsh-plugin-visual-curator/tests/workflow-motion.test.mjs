/** Production canvas callbacks and edge effects retain motion and navigation ownership. */
import assert from 'node:assert/strict'
import test from 'node:test'
import Module, { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiled = await build({ stdin: { contents: "export { createWorkflowEdge } from './src/client/workflow-edge.tsx'; export { createAutomaticWorkflowCanvas } from './src/client/workflow-canvas.tsx';", resolveDir: root, loader: 'ts' }, bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'unrendered-motion-artwork', setup(api) {
  api.onLoad({ filter: /\.(webp|png)$/ }, () => ({ contents: 'export default "fixture-art"', loader: 'js' }))
  api.onLoad({ filter: /src[\\/]client[\\/]wallpaper-canvas\.tsx$/ }, () => ({ contents: 'export function createWallpaperCanvas(){return {useWallpaper(batch){return {value:null,sourceId:batch?.runId??"",enabled:false,error:false,busy:false}},WallpaperNode(){return null},Dialogs(){return null}}}', loader: 'js' }))
} }] })
const filename = resolve(root, 'tests/workflow-motion-memory.cjs'), capsule = new Module(filename)
capsule.filename = filename; capsule.paths = Module._nodeModulePaths(dirname(filename)); capsule._compile(compiled.outputFiles[0].text, filename)
const { createWorkflowEdge, createAutomaticWorkflowCanvas } = capsule.exports
const xyflowRequire = createRequire(createRequire(import.meta.url).resolve('@xyflow/react'))
const { adoptUserNodes, nodeHasDimensions } = xyflowRequire('@xyflow/system')

class ObservedTarget extends EventTarget {
  listeners = new Map()
  addEventListener(name, listener, options) { const values = this.listeners.get(name) ?? new Set(); values.add(listener); this.listeners.set(name, values); super.addEventListener(name, listener, options) }
  removeEventListener(name, listener, options) { this.listeners.get(name)?.delete(listener); super.removeEventListener(name, listener, options) }
  get count() { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0) }
}
function environment() {
  const previous = Object.fromEntries(['window', 'document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const preference = new ObservedTarget(), document = new ObservedTarget(), frames = new Map(), storage = new Map()
  let nextFrame = 0, styleReads = 0
  preference.matches = false; document.hidden = false; document.baseURI = 'https://fixture.invalid/'
  Object.assign(globalThis, { document, window: { matchMedia: () => preference, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }, getComputedStyle: () => { styleReads++; return { getPropertyValue: () => '0.3s' } }, requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id }, cancelAnimationFrame: id => frames.delete(id) })
  return { document, preference, get styleReads() { return styleReads }, frame() { const current = [...frames.values()]; frames.clear(); for (const callback of current) callback(0) }, restore() { for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } } }
}
function componentFixture(create, initialProps, React = {
  memo: component => component, Fragment: Symbol('fixture-fragment'),
  createElement(type, attributes, ...children) { if (attributes?.ref && typeof attributes.ref === 'object') attributes.ref.current ??= { focus() {} }; return { type, props: { ...attributes, children } } },
}) {
  const cells = [], effects = [], pending = []
  let cursor = 0, dirty = false, value, props = initialProps
  const effect = (work, dependencies) => {
    const index = cursor++, previous = effects[index]
    if (previous && dependencies.every((dependency, at) => Object.is(dependency, previous.dependencies[at]))) return
    pending.push(() => { previous?.cleanup?.(); effects[index] = { dependencies, cleanup: work() } })
  }
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; return [cells[index], next => { const result = typeof next === 'function' ? next(cells[index]) : next; if (!Object.is(result, cells[index])) { cells[index] = result; dirty = true } }] },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial } },
    useId() { return `motion-fixture-${cursor++}` }, useEffect: effect, useLayoutEffect: effect,
  }
  const Component = create(React)
  const render = () => {
    const previous = Object.fromEntries(Object.keys(hooks).map(key => [key, React[key]]))
    Object.assign(React, hooks)
    try { cursor = 0; value = Component(props); for (const work of pending.splice(0)) work() }
    finally { Object.assign(React, previous) }
  }
  const flush = () => { for (let attempts = 0; attempts < 30; attempts++) { if (!dirty) return; dirty = false; render() } throw new Error('The motion fixture did not settle') }
  render(); flush()
  return { React, get value() { return value }, flush, update(next = props) { props = next; render(); flush() }, dispose() { for (const item of effects) item?.cleanup?.() } }
}
function elements(value, predicate) {
  if (Array.isArray(value)) return value.flatMap(item => elements(item, predicate))
  if (!value || typeof value !== 'object') return []
  return [...predicate(value) ? [value] : [], ...elements(value.props?.children, predicate)]
}
const particleCount = fixture => elements(fixture.value, element => element.type === 'animateMotion').length

test('static edges avoid motion listeners; active motion pauses for interaction, hidden pages and reduced motion', () => {
  const env = environment(), props = { id: 'edge', sourceX: 0, sourceY: 0, targetX: 300, targetY: 100, sourcePosition: 'right', targetPosition: 'left', markerEnd: 'saved-arrow', data: { phase: 'completed', flowing: false } }
  const fixture = componentFixture(React => createWorkflowEdge(React), props)
  try {
    assert.equal(particleCount(fixture), 0); assert.equal(env.document.count + env.preference.count, 0); assert.equal(env.styleReads, 0)
    fixture.update({ ...props, data: { phase: 'running', flowing: true } })
    assert.equal(particleCount(fixture), 3); assert.equal(env.document.count + env.preference.count, 2)
    fixture.update({ ...props, data: { phase: 'running', flowing: true, motionPaused: true } })
    assert.equal(particleCount(fixture), 0); assert.equal(env.document.count + env.preference.count, 0)
    assert.equal(fixture.value.props['data-flowing'], true)
    assert.equal(elements(fixture.value, element => element.props?.markerEnd === 'saved-arrow').length, 1)
    fixture.update({ ...props, data: { phase: 'running', flowing: true } })
    env.document.hidden = true; env.document.dispatchEvent(new Event('visibilitychange')); fixture.flush(); assert.equal(particleCount(fixture), 0)
    env.document.hidden = false; env.document.dispatchEvent(new Event('visibilitychange')); fixture.flush(); assert.equal(particleCount(fixture), 3)
    env.preference.matches = true; env.preference.dispatchEvent(new Event('change')); fixture.flush(); assert.equal(particleCount(fixture), 0)
    env.preference.matches = false; env.preference.dispatchEvent(new Event('change')); fixture.flush(); assert.equal(particleCount(fixture), 3)
    for (const phase of ['idle', 'failed', 'blocked', 'paused', 'cancelled', 'completed']) {
      fixture.update({ ...props, data: { phase, flowing: false } })
      assert.equal(particleCount(fixture), 0); assert.equal(env.document.count + env.preference.count, 0)
    }
  } finally { fixture.dispose(); assert.equal(env.document.count + env.preference.count, 0); env.restore() }
})

function canvasFixture({ React, ui = {}, env = environment() } = {}) {
  const launch = { id: 'launch', input: { operationId: 'launch', modelProfileId: 'profile', taskBrief: 'Fixture scene', targetCount: 2 }, stage: 'attaching', status: 'working', createdAt: '2026-11-07T00:00:00Z', runIds: [] }
  const batches = { styleId: 'style', page: { batches: [] }, batchId: '', deleting: [], loading: false }, launches = { entries: [launch] }
  const actions = { watch: () => () => {}, refresh: async () => {}, select() {} }, workflow = { style: { styleId: 'style', name: 'Fixture', referenceIds: [] }, referenceImages: [], useDatasets: select => select({ entries: [], submissions: [] }), useLaunches: select => select(launches), launches: { refresh: async () => {} }, profileActions: {}, busy: false, canSearch: false }
  const props = { styleId: 'style', pageSize: 20, t: key => key, workflow, useBatches: select => select(batches), actions, onOpen: async () => {} }
  const fixture = componentFixture(React => { const Outer = createAutomaticWorkflowCanvas(React, ui); return Outer(props).type }, props, React)
  const flow = () => elements(fixture.value, element => !!element.props?.nodeTypes)[0]
  const fits = [], viewport = { x: 0, y: 0, zoom: 1 }
  flow().props.onInit({ fitView: async options => { fits.push(options.nodes.map(node => node.id)); return true }, getViewport: () => viewport }); fixture.flush()
  return { env, fixture, flow, fits, viewport, launch, batches, launches, frames() { env.frame(); fixture.flush(); env.frame(); fixture.flush() }, stage(kind) {
    launches.entries = []
    const counts = kind === 'completed' ? { downloaded: 2, planned: 2, rendered: 2, reviewed: 2, passed: 2 } : kind === 'downloading' ? { downloading: 2 } : { downloaded: 2, planning: 2 }
    batches.page = { batches: [{ runId: 'search', launchId: 'launch', kind: 'search', status: 'completed', createdAt: launch.createdAt, taskBrief: 'Fixture scene', matched: 2, targetCount: 2, images: [], wallpaperRequested: true, wallpaper: { runId: 'wallpaper', status: kind === 'completed' ? 'completed' : 'running', total: 2, planned: counts.planned ?? 0, rendered: counts.rendered ?? 0, reviewed: counts.reviewed ?? 0, passed: counts.passed ?? 0, attention: 0, budgetStopped: false, counts } }] }
    fixture.update()
  }, dispose() { fixture.dispose(); env.restore() } }
}

test('controlled task nodes retain measured dimensions and handles through polling and collapse changes', () => {
  const f = canvasFixture(), lookup = new Map(), parents = new Map()
  try {
    f.stage('completed')
    f.batches.page.batches[0].workflowSource = { modelProfileId: 'profile', references: 5, revision: 1 }
    f.fixture.update()
    const initial = f.flow().props.nodes
    assert.equal(initial.length, 6)
    assert(initial.filter(node => ['references', 'dataset'].includes(node.data.kind)).every(node => node.data.collapsed))
    adoptUserNodes(initial, lookup, parents)
    const measurements = initial.map(node => ({ type: 'dimensions', id: node.id, dimensions: { width: node.style.width, height: node.data.collapsed ? 62 : 260 } }))
    f.flow().props.onNodesChange(measurements); f.fixture.flush()
    for (let update = 0; update < 4; update++) {
      const nodes = f.flow().props.nodes
      for (const node of nodes) {
        const internal = lookup.get(node.id)
        internal.internals.handleBounds = { source: [{ id: null, x: node.style.width, y: 31, width: 8, height: 8 }], target: [{ id: null, x: 0, y: 31, width: 8, height: 8 }] }
      }
      adoptUserNodes(nodes, lookup, parents)
      for (const node of nodes) {
        assert(nodeHasDimensions(lookup.get(node.id)), `${node.data.kind} must remain visible after the controlled nodes array is rebuilt`)
        assert(lookup.get(node.id).internals.handleBounds, `${node.data.kind} must retain its measured ports`)
      }
      f.fixture.update()
    }
    const references = f.flow().props.nodes.find(node => node.data.kind === 'references')
    references.data.collapse(); f.fixture.flush()
    f.flow().props.onNodesChange([{ type: 'dimensions', id: references.id, dimensions: { width: 340, height: 260 } }]); f.fixture.flush()
    adoptUserNodes(f.flow().props.nodes, lookup, parents)
    assert.equal(lookup.get(references.id).measured.height, 260)
    assert.equal(f.flow().props.nodes.find(node => node.id === references.id).data.collapsed, false)
  } finally { f.dispose() }
})

test('ReactFlow keeps folded reference and dataset headers and ports visible after measurement, polling, expansion and zoom', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://fixture.invalid/', pretendToBeVisual: true })
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'SVGElement', 'Node', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const observers = new Set(), win = dom.window
  class ResizeObserver {
    observed = new Map()
    constructor(callback) { this.callback = callback; observers.add(this) }
    observe(target) { this.observed.set(target, '') }
    unobserve(target) { this.observed.delete(target) }
    disconnect() { this.observed.clear(); observers.delete(this) }
    flush() {
      const entries = []
      for (const [target, previous] of this.observed) {
        const size = `${target.offsetWidth}:${target.offsetHeight}`
        if (size !== previous) { this.observed.set(target, size); entries.push({ target, contentRect: target.getBoundingClientRect() }) }
      }
      if (entries.length) this.callback(entries)
    }
  }
  const dimensions = element => {
    if (element.classList.contains('react-flow__node')) return { width: Number.parseFloat(element.style.width) || 340, height: element.querySelector('.vc-flow-node')?.dataset.collapsed === 'true' ? 62 : 260 }
    if (element.classList.contains('react-flow__handle')) return { width: 8, height: 8 }
    return { width: 1280, height: 720 }
  }
  // jsdom has no layout engine; only its geometry and ResizeObserver are supplied. ReactFlow owns visibility and handle measurement.
  Object.defineProperties(win.HTMLElement.prototype, {
    offsetWidth: { get() { return dimensions(this).width } }, offsetHeight: { get() { return dimensions(this).height } },
    clientWidth: { get() { return dimensions(this).width } }, clientHeight: { get() { return dimensions(this).height } },
  })
  win.HTMLElement.prototype.getBoundingClientRect = function () { const { width, height } = dimensions(this); return new win.DOMRect(0, 0, width, height) }
  win.DOMMatrixReadOnly = class { constructor() { this.m22 = 1 } }
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, Element: win.Element, SVGElement: win.SVGElement, Node: win.Node, ResizeObserver, getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const require = createRequire(import.meta.url), React = { ...require('react'), memo: component => component }, { act } = React
  const { createRoot } = require('react-dom/client'), { ReactFlow } = require('@xyflow/react')
  const passthrough = ({ children }) => React.createElement('span', null, children)
  const ui = new Proxy({ Button: ({ children, onClick, className, disabled, ...props }) => React.createElement('button', { onClick, className, disabled, 'aria-expanded': props['aria-expanded'], 'aria-label': props['aria-label'] }, children), Tooltip: ({ children }) => children, AnimatedCollapse: ({ open, children }) => React.createElement('div', { hidden: !open }, open ? children : null), Tag: passthrough, StateDot: () => React.createElement('span') }, { get: (target, key) => target[key] ?? passthrough })
  const f = canvasFixture({ React, ui, env: { frame() {}, restore() {} } }), root = createRoot(win.document.getElementById('root'))
  let instance
  const paint = async () => { await act(async () => { root.render(React.createElement(ReactFlow, { ...f.flow().props, onlyRenderVisibleElements: false, children: null, onInit: value => { instance = value }, onNodesChange: changes => { f.flow().props.onNodesChange(changes); f.fixture.flush() } })); await new Promise(resolve => win.requestAnimationFrame(resolve)) }) }
  const observe = async () => { await act(async () => { for (const observer of observers) observer.flush(); f.fixture.flush() }); await paint() }
  const check = folded => {
    for (const kind of ['references', 'dataset']) {
      const card = win.document.querySelector(`.vc-flow-node[data-kind="${kind}"]`), wrapper = card.closest('.react-flow__node')
      assert.equal(win.getComputedStyle(wrapper).visibility, 'visible', `${kind} header must stay painted`)
      assert(card.querySelector('.vc-flow-node-titlebar strong').textContent)
      assert.equal(card.dataset.collapsed, String(folded))
      assert.equal(card.querySelectorAll('.react-flow__handle').length, kind === 'references' ? 1 : 2)
      const internal = instance.getInternalNode(wrapper.dataset.id)
      assert(internal.internals.handleBounds.source?.length, `${kind} output port must be measured`)
      if (kind === 'dataset') assert(internal.internals.handleBounds.target?.length, 'dataset input port must be measured')
    }
  }
  try {
    f.stage('completed'); f.batches.page.batches[0].workflowSource = { modelProfileId: 'profile', references: 5, revision: 1 }; f.fixture.update()
    await paint(); await observe(); check(true)
    for (let poll = 0; poll < 3; poll++) { f.fixture.update(); await paint(); check(true) }
    for (const kind of ['references', 'dataset']) {
      await act(async () => { win.document.querySelector(`.vc-flow-node[data-kind="${kind}"] .vc-flow-collapse`).click(); f.fixture.flush() }); await paint()
    }
    await observe(); check(false)
    for (let poll = 0; poll < 3; poll++) { f.fixture.update(); await paint(); check(false) }
    await act(async () => { await instance.zoomTo(0.75) }); f.fixture.update(); await paint(); check(false)
    for (const kind of ['references', 'dataset']) {
      await act(async () => { win.document.querySelector(`.vc-flow-node[data-kind="${kind}"] .vc-flow-collapse`).click(); f.fixture.flush() }); await paint()
    }
    await observe(); check(true)
  } finally {
    await act(async () => { root.unmount() }); f.dispose(); win.close()
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

test('automatic focus keeps following stages until user navigation and every viewport movement pauses particles', () => {
  const f = canvasFixture()
  try {
    f.frames(); assert.equal(f.fits.length, 1, 'The first launch has one automatic fit')
    const first = f.fits[0]
    f.flow().props.onMoveStart(null); f.fixture.flush()
    assert.ok(f.flow().props.edges.every(edge => edge.data.motionPaused))
    f.flow().props.onMoveEnd(null, f.viewport); f.fixture.flush()
    assert.ok(f.flow().props.edges.every(edge => !edge.data.motionPaused))
    f.stage('downloading'); f.frames(); assert.equal(f.fits.length, 2); assert.notDeepEqual(f.fits[1], first)
    f.flow().props.onMoveStart({ type: 'pointerdown' }); f.fixture.flush()
    f.flow().props.onMoveEnd({ type: 'pointerup' }, f.viewport); f.fixture.flush()
    f.stage('planning'); f.frames(); assert.equal(f.fits.length, 2, 'Progress updates retain a manually positioned viewport')
  } finally { f.dispose() }
})

test('completed wallpaper focuses delivery while completed search keeps its results', () => {
  const f = canvasFixture()
  try {
    f.frames()
    f.stage('completed'); f.frames()
    assert.deepEqual(f.fits.at(-1), ['launch:planning', 'launch:reviewing'])
    delete f.batches.page.batches[0].wallpaper
    f.batches.page.batches[0].wallpaperRequested = false
    f.fixture.update(); f.frames()
    assert.equal(f.fits.at(-1).at(-1), 'launch:results')
  } finally { f.dispose() }
})

test('a delayed automatic fit yields when the user takes over between animation frames', () => {
  const f = canvasFixture()
  try {
    f.env.frame(); f.fixture.flush()
    f.flow().props.onMoveStart({ type: 'pointerdown' }); f.fixture.flush()
    f.env.frame(); f.fixture.flush()
    assert.equal(f.fits.length, 0)
  } finally { f.dispose() }
})

test('only the node entrance animation clears its marker and virtualization does not replay it', () => {
  const f = canvasFixture()
  let node, replay
  try {
    const flow = f.flow(), data = flow.props.nodes[0].data, Component = flow.props.nodeTypes.workflow
    node = componentFixture(() => Component, { data, selected: false }, f.fixture.React)
    assert.equal(node.value.props['data-entering'], true)
    const target = {}
    node.value.props.onAnimationEnd({ target: {}, currentTarget: target, animationName: 'vc-workflow-enter' }); node.flush(); assert.equal(node.value.props['data-entering'], true)
    node.value.props.onAnimationEnd({ target, currentTarget: target, animationName: 'another-animation' }); node.flush(); assert.equal(node.value.props['data-entering'], true)
    node.value.props.onAnimationEnd({ target, currentTarget: target, animationName: 'vc-workflow-enter' }); node.flush(); assert.equal(node.value.props['data-entering'], undefined)
    node.dispose(); node = undefined
    replay = componentFixture(() => Component, { data, selected: false }, f.fixture.React); assert.equal(replay.value.props['data-entering'], undefined)
  } finally { node?.dispose(); replay?.dispose(); f.dispose() }
})
