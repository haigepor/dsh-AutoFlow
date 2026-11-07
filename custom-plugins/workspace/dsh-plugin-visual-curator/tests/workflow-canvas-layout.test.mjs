/** Device-local geometry preserves manual positions while automatic siblings avoid resized cards. */
import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiled = await build({ entryPoints: [resolve(root, 'src/client/workflow-canvas-layout.ts')], bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'silent' })
const filename = resolve(root, 'tests/workflow-layout-memory.cjs'), capsule = new Module(filename)
capsule.filename = filename; capsule.paths = Module._nodeModulePaths(dirname(filename)); capsule._compile(compiled.outputFiles[0].text, filename)
const { createWorkflowCanvasLayout, workflowPositions } = capsule.exports
const kinds = ['references', 'dataset', 'results', 'downloading', 'planning', 'rendering', 'reviewing']
const dimensions = kind => ({ width: kind === 'results' ? 560 : kinds.indexOf(kind) > 2 ? 380 : 340, height: kind === 'results' ? 420 : 260 })

function environment(style = 'fixture', storage = new Map()) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  globalThis.window = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }
  function open() {
    const cells = []; let cursor = 0
    const React = {
      useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }] },
      useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial } },
    }
    const useLayout = createWorkflowCanvasLayout(React)
    return () => { cursor = 0; return useLayout(style) }
  }
  const render = open()
  return { storage, render, reopen: open, read() { return JSON.parse(storage.get(`visual-curator:workflow-canvas:v7:${style}`)) }, restore() { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window } }
}
function addLane(layout, lane, row = 0) {
  return kinds.map(kind => {
    const id = `${lane}:${kind}`
    layout.position(id, kind, lane); layout.measure(id, dimensions(kind))
    return { id, kind, row }
  })
}

test('resizing fixed image slots pushes later presentation steps forward even when they share a processing stage', () => {
  const env = environment('fixed-slots')
  try {
    const layout = env.render(), steps = [['original', 'downloading'], ['planning', 'planning'], ['geometry', 'planning'], ['rendering', 'rendering'], ['reviewing', 'reviewing'], ['final', 'reviewing']]
    const ids = steps.map(([stage, kind], index) => {
      const id = `batch:image-step:${stage}:${kind}`
      layout.position(id, kind, 'batch', { x: index * 480, y: 0 }); layout.measure(id, { width: 380, height: 410 })
      return id
    })
    layout.resize(ids[1], { width: 480, height: 410 }); layout.save()
    const saved = env.read()
    assert.equal(saved.sizes[ids[1]].width, 480)
    assert(saved.positions[ids[2]].x >= saved.positions[ids[1]].x + 580)
    assert(saved.positions[ids[3]].x >= saved.positions[ids[2]].x + 480)
    assert.deepEqual(saved.positions[ids[0]], { x: 0, y: 0 })
  } finally { env.restore() }
})
function rectangles(saved) {
  return Object.entries(saved.positions).map(([id, at]) => ({ id, ...at, ...dimensions(id.split(':').at(-1)), ...saved.sizes[id] }))
}
function overlaps(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y }
function assertNoOverlap(saved) {
  const nodes = rectangles(saved)
  for (let left = 0; left < nodes.length; left++) for (let right = left + 1; right < nodes.length; right++) assert.equal(overlaps(nodes[left], nodes[right]), false, `${nodes[left].id} overlaps ${nodes[right].id}`)
}
function assertPortsSeparated(saved, lane) {
  const nodes = rectangles(saved)
  for (let index = 1; index < kinds.length; index++) {
    const source = nodes.find(node => node.id === `${lane}:${kinds[index - 1]}`), target = nodes.find(node => node.id === `${lane}:${kinds[index]}`)
    assert(target.x - (source.x + source.width) >= 100, `${source.id} output and ${target.id} input need a clear connection gap`)
  }
}

test('resizing pushes only automatic siblings and retains narrow-card and saved connection geometry', () => {
  const env = environment()
  try {
    const layout = env.render(); addLane(layout, 'current-batch'); addLane(layout, 'other-batch', 1); layout.save()
    const before = env.read(), other = Object.fromEntries(Object.entries(before.positions).filter(([id]) => id.startsWith('other-batch:')))
    layout.resize('current-batch:results', { width: 1200, height: 420 }); layout.reconcile()
    const wide = env.read()
    assert.equal(wide.sizes['current-batch:results'].width, 1200)
    assert.equal(wide.positions['current-batch:downloading'].x, 2180)
    assert.deepEqual(Object.fromEntries(Object.entries(wide.positions).filter(([id]) => id.startsWith('other-batch:'))), other)
    assertNoOverlap(wide); assertPortsSeparated(wide, 'current-batch')
    layout.resize('current-batch:results', { width: 360, height: 420 }); layout.save()
    assertNoOverlap(env.read()); assertPortsSeparated(env.read(), 'current-batch')
    const reopened = env.reopen()(); reopened.save()
    assert.deepEqual(env.read().positions, wide.positions)
    assert.equal(env.read().sizes['current-batch:results'].width, 360)
  } finally { env.restore() }
})

test('manual siblings clamp resize and explicit arrangement releases their positions for automatic avoidance', () => {
  const env = environment()
  try {
    const layout = env.render(), nodes = addLane(layout, 'batch')
    layout.move('batch:planning', { x: 2020, y: 10 }); layout.save()
    const pinned = env.read().positions['batch:planning']
    layout.resize('batch:results', { width: 1200, height: 420 }); layout.reconcile()
    assert.equal(env.read().sizes['batch:results'].width, 560)
    assert.deepEqual(env.read().positions['batch:planning'], pinned)
    assert.deepEqual(env.read().manual, ['batch:planning'])
    const reopened = env.reopen()(); reopened.arrange(nodes)
    assert.deepEqual(env.read().manual, [])
    reopened.resize('batch:results', { width: 1200, height: 420 }); reopened.reconcile()
    assert.equal(env.read().sizes['batch:results'].width, 1200)
    assert(env.read().positions['batch:planning'].x > pinned.x)
    assertNoOverlap(env.read()); assertPortsSeparated(env.read(), 'batch')
  } finally { env.restore() }
})

test('left and top resize keep the opposite corner anchored and reject later unconstrained resize changes', () => {
  const env = environment()
  try {
    const layout = env.render(); addLane(layout, 'batch')
    layout.move('batch:dataset', { x: 440, y: 10 })
    layout.resize('batch:results', { x: 240, y: 0, width: 1200, height: 420 })
    layout.move('batch:results', { x: 240, y: 0 }); layout.measure('batch:results', { width: 1200, height: 420 }); layout.reconcile()
    assert.deepEqual(env.read().positions['batch:results'], { x: 880, y: 0 })
    assert.equal(env.read().sizes['batch:results'].width, 560); assertNoOverlap(env.read())
    layout.resize('batch:results', { x: 1080, y: -200, width: 360, height: 620 })
    layout.move('batch:results', { x: 1080, y: -200 }); layout.measure('batch:results', { width: 360, height: 620 }); layout.reconcile()
    assert.deepEqual(env.read().positions['batch:results'], { x: 1080, y: -200 })
    assert.deepEqual(env.read().sizes['batch:results'], { width: 360, height: 620 }); assertNoOverlap(env.read())
    assert.equal(env.read().positions['batch:results'].x + env.read().sizes['batch:results'].width, 1440)
    assert.equal(env.read().positions['batch:results'].y + env.read().sizes['batch:results'].height, 420)
  } finally { env.restore() }
})

test('all legacy layout generations retain their original keys and migrate positions as manual', () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const style = `legacy-${version}`, storage = new Map(), viewport = { x: 37, y: -21, zoom: 0.7 }
    const positions = Object.fromEntries(kinds.map(kind => [version < 3 ? kind : `batch:${kind}`, { ...workflowPositions[kind] }]))
    const old = { version, positions, viewport, ...(version >= 4 ? { sizes: {} } : {}), ...(version === 6 ? { owners: { launch: 'run' } } : {}) }
    const key = `visual-curator:workflow-canvas:v${version}:${style}`, bytes = JSON.stringify(old)
    storage.set(key, bytes)
    const env = environment(style, storage)
    try {
      const layout = env.render()
      for (const kind of kinds) layout.position(`batch:${kind}`, kind, 'batch')
      layout.reconcile()
      const saved = env.read()
      assert.equal(saved.version, 7); assert.equal(storage.get(key), bytes)
      assert.deepEqual(saved.viewport, viewport)
      assert.deepEqual(saved.owners, version === 6 ? old.owners : {})
      assert.deepEqual(new Set(saved.manual), new Set(kinds.map(kind => `batch:${kind}`)))
      for (const kind of kinds) assert.deepEqual(saved.positions[`batch:${kind}`], { x: workflowPositions[kind].x + (version === 3 || version === 4 ? kinds.indexOf(kind) > 3 ? 480 : 0 : 0), y: 0 })
      layout.resize('batch:results', { width: 1200, height: 420 }); layout.save()
      assert.deepEqual(env.read().positions, saved.positions)
      assert(env.read().sizes['batch:results'].width <= 560)
    } finally { env.restore() }
  }
})

test('10 and 20 batch lanes remain separate through wide and narrow resize, persistence and arrangement', () => {
  for (const count of [10, 20]) {
    const env = environment(`lanes-${count}`)
    try {
      const layout = env.render(), nodes = []
      for (let row = 0; row < count; row++) nodes.push(...addLane(layout, `batch-${row}`, row))
      layout.arrange(nodes)
      for (let row = 0; row < count; row++) layout.resize(`batch-${row}:results`, { width: row % 2 ? 360 : 1200, height: 420 })
      layout.reconcile()
      const saved = env.read()
      assert.equal(Object.keys(saved.positions).length, count * 7); assertNoOverlap(saved)
      for (let row = 0; row < count; row++) assertPortsSeparated(saved, `batch-${row}`)
      layout.resize('batch-0:results', { width: 1200, height: 1000 }); layout.reconcile()
      assert.equal(env.read().sizes['batch-0:results'].height, 420)
      assert.deepEqual(env.read().positions, saved.positions)
      const reopened = env.reopen()(); reopened.save()
      assert.deepEqual(env.read().positions, saved.positions); assert.deepEqual(env.read().sizes, saved.sizes)
      reopened.arrange(nodes); assertNoOverlap(env.read())
    } finally { env.restore() }
  }
})

test('legacy manual groups keep their coordinates even when they already overlap', () => {
  const storage = new Map(), positions = Object.fromEntries(['visible', 'history'].flatMap(lane => kinds.map(kind => [`${lane}:${kind}`, { ...workflowPositions[kind] }])))
  const old = JSON.stringify({ version: 6, positions, sizes: {}, owners: {}, viewport: { x: 0, y: 0, zoom: 1 } })
  storage.set('visual-curator:workflow-canvas:v6:fixture', old)
  const env = environment('fixture', storage)
  try {
    const layout = env.render(); layout.reconcile()
    assert.deepEqual(env.read().positions, positions)
    layout.arrange(kinds.map(kind => ({ id: `visible:${kind}`, kind, row: 0 })))
    for (const kind of kinds) assert.deepEqual(env.read().positions[`history:${kind}`], positions[`history:${kind}`])
    assertNoOverlap(env.read()); assert.equal(storage.get('visual-curator:workflow-canvas:v6:fixture'), old)
  } finally { env.restore() }
})

test('forget removes manual ownership and collapsed resize preserves expanded height', () => {
  const env = environment()
  try {
    const layout = env.render(); addLane(layout, 'batch')
    layout.resize('batch:results', { width: 560, height: 500 })
    layout.resize('batch:results', { width: 400, height: 62 }, true)
    layout.move('batch:planning', { x: 2020, y: 10 }); layout.save()
    assert.deepEqual(env.read().sizes['batch:results'], { width: 400, height: 500 })
    layout.forget(['batch'])
    assert.deepEqual(env.read().manual, []); assert.deepEqual(env.read().positions, {}); assert.deepEqual(env.read().sizes, {})
  } finally { env.restore() }
})

test('only observed in-memory dimensions are returned and forgetting a lane removes them', () => {
  const env = environment()
  try {
    let layout = env.render()
    layout.position('batch:references', 'references', 'batch')
    assert.equal(layout.measuredDimensions('batch:references'), undefined)
    layout.measure('batch:references', { width: 340, height: 62 })
    layout = env.render()
    assert.deepEqual(layout.measuredDimensions('batch:references'), { width: 340, height: 62 })
    layout.save()
    assert.equal(Object.hasOwn(env.read(), 'measured'), false)
    assert.equal(env.reopen()().measuredDimensions('batch:references'), undefined)
    layout.forget(['batch'])
    assert.equal(layout.measuredDimensions('batch:references'), undefined)
  } finally { env.restore() }
})

test('planning image cards stay in their batch, preserve manual positions and arrange without overlapping another lane', async () => {
  const { planningImageNodeId } = await import('../src/client/workflow-image-branches.ts')
  const env = environment()
  try {
    const layout = env.render(), nodes = [...addLane(layout, 'batch'), ...addLane(layout, 'other', 1)]
    layout.save(); const prior = env.read()
    const cards = Array.from({ length: 4 }, (_, imageSlot) => {
      const id = planningImageNodeId('batch', `source-${imageSlot}`)
      layout.position(id, 'planning', 'batch', { x: 2020, y: 380 + imageSlot * 480 })
      layout.measure(id, { width: 380, height: 420 })
      return { id, kind: 'planning', row: 0, imageSlot }
    })
    layout.save()
    for (const [id, point] of Object.entries(prior.positions)) assert.deepEqual(env.read().positions[id], point)
    layout.move(cards[1].id, { x: 2100, y: 1500 }); layout.save()
    assert.deepEqual(layout.position(cards[1].id, 'planning', 'batch', { x: 2020, y: 860 }), { x: 2100, y: 1500 })
    const reopened = env.reopen()()
    assert.deepEqual(reopened.position(cards[1].id, 'planning', 'batch', { x: 2020, y: 860 }), { x: 2100, y: 1500 })
    reopened.arrange([...nodes, ...cards])
    const saved = env.read(), visible = [...nodes, ...cards].map(node => ({ id: node.id, ...saved.positions[node.id], ...(node.imageSlot === undefined ? dimensions(node.kind) : { width: 380, height: 420 }) }))
    for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) assert.equal(overlaps(visible[i], visible[j]), false, `${visible[i].id} overlaps ${visible[j].id}`)
    reopened.forget(['batch'])
    assert(cards.every(card => !Object.hasOwn(env.read().positions, card.id)))
    assert(Object.keys(env.read().positions).every(id => id.startsWith('other:')))
  } finally { env.restore() }
})
