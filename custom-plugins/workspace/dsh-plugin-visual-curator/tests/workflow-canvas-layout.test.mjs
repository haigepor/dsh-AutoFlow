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
const { createWorkflowCanvasLayout, workflowPositions, workflowConnectionSpacing, workflowStaggeredPositions } = capsule.exports
const kinds = ['references', 'dataset', 'results', 'downloading', 'planning', 'rendering', 'reviewing']
const dimensions = kind => ({ width: kind === 'results' ? 560 : kinds.indexOf(kind) > 2 ? 380 : 340, height: kind === 'results' ? 420 : 260 })

test('image stages share a top edge, leave clear horizontal ranges and preserve unrelated manual positions', () => {
  const nodes = [330, 720, 380, 410, 1200, 360, 500].map((width, index) => ({ id: `batch:image-step:${index}:planning`, width, height: index % 2 ? 1100 : 240 }))
  const positions = workflowStaggeredPositions(nodes)
  assert.equal(new Set(Object.values(positions).map(point => point.y)).size, 1)
  for (let index = 1; index < nodes.length; index++) assert(positions[nodes[index].id].x >= positions[nodes[index - 1].id].x + nodes[index - 1].width + 100)
  const env = environment('staggered')
  try {
    const layout = env.render(); layout.position('other:references', 'references', 'other'); layout.move('other:references', { x: 50, y: 900 })
    layout.position(nodes[0].id, 'planning', 'batch'); layout.move(nodes[0].id, { x: -100, y: -100 })
    layout.place(positions, true)
    assert.deepEqual(env.read().positions['other:references'], { x: 50, y: 900 }); assert.deepEqual(env.read().manual, ['other:references'])
    for (const node of nodes) assert.deepEqual(env.read().positions[node.id], positions[node.id])
  } finally { env.restore() }
})

test('generated images keep review before clarity after measured layout, resizing and saved-position recovery', () => {
  const env = environment('review-before-clarity')
  try {
    const layout = env.render()
    const stages = ['rendering:rendering', 'reviewing:reviewing', 'clarity:rendering', 'final:reviewing']
    const ids = stages.map(stage => `batch:image-step:${stage}`)
    layout.place(Object.fromEntries(ids.map((id, index) => [id, { x: index === 1 ? 1040 : index === 2 ? 520 : index * 520, y: 0 }])))
    for (const id of ids) layout.measure(id, { width: 380, height: 420 })
    layout.reconcile(undefined, ids)
    const positions = env.read().positions
    for (let index = 1; index < ids.length; index++) assert(positions[ids[index]].x >= positions[ids[index - 1]].x + 520)
    layout.resize(ids[1], { width: 540, height: 420 }); layout.reconcile(undefined, ids)
    assert(env.read().positions[ids[2]].x >= env.read().positions[ids[1]].x + 640)
    const reopened = env.reopen()(); reopened.reconcile(undefined, ids)
    assert(env.read().positions[ids[2]].x >= env.read().positions[ids[1]].x + 640)
  } finally { env.restore() }
})

test('visible image steps compact stale automatic gaps while keeping dragged coordinates', () => {
  const env = environment('compact-visible')
  try {
    const layout = env.render(), first = 'batch:image-step:rendering:rendering', second = 'batch:image-step:reviewing:reviewing'
    const visible = [first, second], automatic = workflowStaggeredPositions(visible.map(id => ({ id, width: 380 })))
    layout.place({ [first]: { x: 0, y: 0 }, [second]: { x: 1800, y: 0 } })
    for (const id of visible) layout.measure(id, { width: 380, height: 420 })
    layout.reconcile(undefined, visible, automatic)
    assert.deepEqual(env.read().positions[second], { x: 520, y: 0 })
    layout.move(second, { x: 900, y: 40 }); layout.save()
    layout.reconcile(undefined, visible, automatic)
    assert.deepEqual(env.read().positions[second], { x: 900, y: 40 })
  } finally { env.restore() }
})

test('decision cards participate in measured spacing and push later automatic steps past their full width', () => {
  const env = environment('decision-spacing')
  try {
    const layout = env.render(), stages = [['geometry', 'planning'], ['decision', 'decision'], ['rendering', 'rendering'], ['clarity', 'rendering']]
    const ids = stages.map(([stage, kind], index) => {
      const id = `batch:image-step:${stage}:${kind}`
      layout.position(id, kind === 'decision' ? 'planning' : kind, 'batch', { x: index === 1 ? 570 : index * 480, y: index % 2 ? 96 : 0 }, index)
      layout.measure(id, { width: index === 1 ? 640 : 380, height: index === 1 ? 1100 : 420 })
      return id
    })
    layout.reconcile(undefined, ids)
    const saved = env.read()
    for (let index = 1; index < ids.length; index++) assert(saved.positions[ids[index]].x >= saved.positions[ids[index - 1]].x + (index === 2 ? 640 : 380) + 100)
    const unchanged = structuredClone(saved.positions)
    layout.reconcile(undefined, ids)
    assert.deepEqual(env.read().positions, unchanged)
    layout.resize(ids[1], { width: 720, height: 1100 }); layout.save()
    assert.equal(env.read().sizes[ids[1]].width, 720)
    assert(env.read().positions[ids[2]].x >= env.read().positions[ids[1]].x + 820)
  } finally { env.restore() }
})

test('automatic image spacing avoids a pinned decision without moving manual cards or other batches', () => {
  const env = environment('pinned-decision')
  try {
    const layout = env.render(), geometry = 'batch:image-step:geometry:planning', decision = 'batch:image-step:decision:decision', render = 'batch:image-step:rendering:rendering'
    for (const [id, kind, x] of [[geometry, 'planning', 0], [decision, 'planning', 400], [render, 'rendering', 560]]) {
      layout.position(id, kind, 'batch', { x, y: 0 }); layout.measure(id, { width: 380, height: 600 })
    }
    layout.move(decision, { x: 400, y: 0 })
    // A real drag differs from the preceding automatic location.
    layout.move(decision, { x: 420, y: 0 })
    layout.position('other:references', 'references', 'other', { x: 30, y: 2000 }); layout.move('other:references', { x: 50, y: 2000 })
    layout.reconcile(undefined, [geometry, decision, render])
    const saved = env.read()
    assert.deepEqual(saved.positions[decision], { x: 420, y: 0 })
    assert.deepEqual(saved.positions['other:references'], { x: 50, y: 2000 })
    assert(saved.manual.includes(decision)); assert(saved.manual.includes('other:references'))
    const rectangles = [geometry, decision, render].map(id => ({ ...saved.positions[id], width: 380, height: 600 }))
    for (let index = 0; index < rectangles.length; index++) for (let next = index + 1; next < rectangles.length; next++) assert.equal(overlaps(rectangles[index], rectangles[next]), false)
  } finally { env.restore() }
})

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

test('collapsed nodes survive reopening without changing other batches or their geometry', () => {
  const env = environment('collapse-recovery')
  try {
    const layout = env.render(); addLane(layout, 'batch-a'); addLane(layout, 'batch-b', 1); layout.save({ x: 10, y: 20, zoom: .8 })
    const before = env.read()
    layout.setCollapsed({ 'batch-a:reviewing': true, 'batch-b:reviewing': false })
    const restored = env.reopen()()
    assert.deepEqual(restored.collapsed, { 'batch-a:reviewing': true, 'batch-b:reviewing': false })
    assert.deepEqual(env.read().positions, before.positions)
    assert.deepEqual(restored.initialViewport, before.viewport)
    restored.forget(['batch-a'])
    assert.deepEqual(env.reopen()().collapsed, { 'batch-b:reviewing': false })
    const saved = env.read(); delete saved.collapsed; env.storage.set('visual-curator:workflow-canvas:v7:collapse-recovery', JSON.stringify(saved))
    const legacy = env.reopen()()
    assert.deepEqual(legacy.collapsed, {})
    assert.deepEqual(legacy.initialViewport, before.viewport)
  } finally { env.restore() }
})

test('two-card slots move automatic review placement when switching from completed to failed images', () => {
  const env = environment('pair-window')
  try {
    const layout = env.render(), lane = 'batch', review = lane + ':image-step:reviewing:reviewing', final = lane + ':image-step:final:reviewing', render = lane + ':image-step:rendering:rendering'
    layout.position(review, 'reviewing', lane, { x: 0, y: 0 }, 0)
    layout.position(final, 'reviewing', lane, { x: 540, y: 0 }, 1)
    assert.deepEqual(layout.position(render, 'rendering', lane, { x: 0, y: 0 }, 0), { x: 0, y: 0 })
    assert.deepEqual(layout.position(review, 'reviewing', lane, { x: 540, y: 0 }, 1), { x: 540, y: 0 })
    layout.place({ [review]: { x: 640, y: 0 } })
    assert.deepEqual(env.render().position(review, 'reviewing', lane, { x: 540, y: 0 }, 1), { x: 640, y: 0 })
    layout.save({ x: 12, y: 24, zoom: .8 })
    const recovered = env.reopen()()
    assert.deepEqual(recovered.position(render, 'rendering', lane, { x: 0, y: 0 }, 0), { x: 0, y: 0 })
    assert.deepEqual(recovered.position(review, 'reviewing', lane, { x: 540, y: 0 }, 1), { x: 540, y: 0 })
    assert.deepEqual(recovered.initialViewport, { x: 12, y: 24, zoom: .8 })
    recovered.move(review, { x: 720, y: 30 })
    assert.deepEqual(recovered.position(review, 'reviewing', lane, { x: 0, y: 0 }, 0), { x: 720, y: 30 })
  } finally { env.restore() }
})

test('adding the clarity step preserves historical positions, collapse state and viewport', () => {
  const env = environment('clarity-history')
  try {
    const initial = env.render(), stages = [['original', 'downloading'], ['planning', 'planning'], ['geometry', 'planning'], ['rendering', 'rendering'], ['reviewing', 'reviewing'], ['final', 'reviewing']]
    for (const [index, [stage, kind]] of stages.entries()) {
      const id = 'batch:image-step:' + stage + ':' + kind
      initial.position(id, kind, 'batch', { x: index * 480, y: 20 }); initial.measure(id, { width: 380, height: 420 })
    }
    initial.setCollapsed({ 'batch:image-step:reviewing:reviewing': true }); initial.save({ x: -42, y: 110, zoom: .7 })
    const before = env.read(), reopened = env.reopen()(), id = 'batch:image-step:clarity:rendering'
    const at = reopened.position(id, 'rendering', 'batch', { x: 1920, y: 20 }); reopened.save()
    const after = env.read()
    for (const [key, position] of Object.entries(before.positions)) assert.deepEqual(after.positions[key], position)
    assert.deepEqual(after.collapsed, before.collapsed); assert.deepEqual(after.viewport, before.viewport)
    assert(at.y >= 540, 'the new step occupies a separate row below the saved cards')
    assert.deepEqual(env.reopen()().position(id, 'rendering', 'batch'), at)
  } finally { env.restore() }
})

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
    const positions = Object.fromEntries(kinds.map(kind => [version < 3 ? kind : `batch:${kind}`, { ...workflowPositions[kind], y: 0 }]))
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

test('new layouts stagger ports while existing automatic image positions remain stable', () => {
  const env=environment('stable-stagger')
  try {
    const layout=env.render()
    assert.equal(layout.position('b:references','references','b').y,0)
    assert.equal(layout.position('b:dataset','dataset','b').y,48)
    const id='b:image-step:planning:planning'
    layout.position(id,'planning','b',{x:440,y:48})
    layout.save()
    assert.deepEqual(layout.position(id,'planning','b',{x:880,y:96}),{x:440,y:48})
    assert.deepEqual(env.reopen()().position(id,'planning','b',{x:880,y:96}),{x:440,y:48})
  } finally { env.restore() }
})

test('rework labels open only the crowded image gap and shift its right neighbors together', () => {
  const nodes = [
    { id: 'original', position: { x: 0, y: 0 }, width: 330, height: 400 },
    { id: 'render', position: { x: 1500, y: 48 }, width: 380, height: 400 },
    { id: 'review', position: { x: 1980, y: 0 }, width: 330, height: 400 },
    { id: 'final', position: { x: 2480, y: 48 }, width: 330, height: 400 },
  ]
  const shifted = workflowConnectionSpacing(nodes, 'review', 'render', 240)
  assert.deepEqual(shifted, { review: { x: 2120, y: 0 }, final: { x: 2620, y: 48 } })
  assert.equal(shifted.review.x - nodes[1].position.x - nodes[1].width, 240)
  assert.equal(shifted.final.x - shifted.review.x, 500)
  const spaced = nodes.map(node => ({ ...node, position: shifted[node.id] ?? node.position }))
  assert.deepEqual(workflowConnectionSpacing(spaced, 'review', 'render', 240), {})
  assert.deepEqual(workflowConnectionSpacing(nodes, 'render', 'review', 240), shifted)
  assert.deepEqual(workflowConnectionSpacing(nodes.map(node => node.id === 'review' ? { ...node, position: { x: 1980, y: 1000 } } : node), 'review', 'render', 240), {})
})
