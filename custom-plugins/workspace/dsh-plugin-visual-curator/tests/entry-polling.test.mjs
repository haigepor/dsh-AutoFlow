/** Registered entries remain idle until a workbench consumes the production store. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { runInThisContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { serviceFixture } from './helpers/service-fixture.ts'

let bundledEntry
async function entrySource() {
  bundledEntry ??= build({ entryPoints: [fileURLToPath(new URL('../src/client/index.ts', import.meta.url))], bundle: true, write: false, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], plugins: [{ name: 'unrendered-entry-views', setup(api) {
    api.onLoad({ filter: /src[\\/]client[\\/](workbench|task-tool-view|conversation-task-dock)\.tsx$/ }, args => {
      const name = args.path.includes('conversation-task-dock') ? 'createConversationTaskDock' : args.path.includes('task-tool-view') ? 'createTaskToolView' : 'createWorkbench'
      return { contents: `export function ${name}(){return function UnrenderedFixtureView(){return null}}`, loader: 'js' }
    })
    api.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default ""', loader: 'js' }))
    api.onLoad({ filter: /assets[\\/].*\.(webp|png)$/ }, () => ({ contents: 'export default "fixture-art"', loader: 'js' }))
  } }] }).then(result => `window.__ModuleLoader__.load({id:'dsh-plugin-visual-curator',factory(require){const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});`)
  return bundledEntry
}

test('only mounted workbenches read and poll, and reopening or reconnecting refreshes their scope', async context => {
  const fixture = await serviceFixture()
  await fixture.service.initialize()
  await fixture.action('style-create', { operationId: 'entry-poll-style', name: 'Polling fixture collection' })
  const source = await entrySource(), previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }
  const counts = {}, pending = new Set(), registered = [], effects = [], events = new Map(), observers = new Set()
  let definition
  globalThis.window = { __ModuleLoader__: { load(module) { definition = module } } }
  globalThis.document = { baseURI: 'http://fixture.invalid/', createElement: () => ({ textContent: '', remove() {} }), head: { append() {} } }
  globalThis.fetch = async (_url, init) => {
    const { operation, args } = JSON.parse(init.body)
    counts[operation] = (counts[operation] ?? 0) + 1
    const work = fixture.action(operation, args)
    pending.add(work)
    try { return new Response(JSON.stringify({ ok: true, value: await work }), { status: 200, headers: { 'content-type': 'application/json' } }) }
    finally { pending.delete(work) }
  }
  const flush = async () => { await setImmediate(); while (pending.size) { await Promise.all([...pending]); await setImmediate() } }
  const advance = async seconds => { for (let tick = 0; tick < seconds * 2; tick++) { context.mock.timers.tick(500); await flush() } }
  const scope = disposers => ({
    effect(work) { const dispose = work(); if (dispose) disposers.push(dispose) },
    on(name, callback) { events.set(name, callback); return () => events.delete(name) },
    get: () => ({ openSession() {} }),
    plugin(item) { const children = []; item.apply(scope(children)); return { async dispose() { for (const dispose of children.reverse()) await dispose() } } },
    slots: { inject(_name, register) { disposers.push(register()) }, register(options) { registered.push(options); return () => { const index = registered.indexOf(options); if (index >= 0) registered.splice(index, 1) } } },
    locale: { register: () => () => {}, bind: () => key => key },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) }, selectPanel() {} },
    uiConversation: { views: { register: () => () => {} } },
    remote: { $on: () => () => {}, credentials: { async set() { throw new Error('The polling fixture cannot write credentials') } }, pluginManager: {
      async listBundles() { return { ok: true, value: [{ name: 'dsh-plugin-visual-curator', enabled: true, rows: [{ rowId: 'panel-row', entryId: 'fixture-entry' }], features: [{ id: 'ui-panel', rowId: 'panel-row', enabled: true }] }] } },
      async listPlugins() { return { ok: true, value: [{ entryId: 'fixture-entry', enabled: true, fiberPhase: 'active' }] } },
      async invokeAction() { throw new Error('Expected production reads to use the HTTP transport') },
    } },
  })
  const observe = hook => { const stop = hook.subscribe(() => {}); observers.add(stop); return () => { observers.delete(stop); stop() } }
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    runInThisContext(source)
    definition.factory(() => ({})).apply(scope(effects))
    await flush()
    assert.equal(registered.filter(item => item.name === 'main').length, 1)
    await advance(60)
    assert.deepEqual(counts, {}, 'registering an unopened entry must not read owner data')

    const face = registered.find(item => item.name === 'main').inject()
    const first = observe(face.hooks.workbench), second = observe(face.hooks.workbench)
    await flush()
    assert.equal(counts.snapshot, 1, 'multiple workbench hooks share the initial read')
    const closeLaunches = observe(face.hooks.launches)
    await flush()
    assert.equal(counts['search-launch-list'], 1)
    await advance(6)
    assert.equal(counts['gallery-reference-tasks'], 3)
    assert.equal(counts['search-launch-list'], 1, 'an empty visible launch list stays idle')
    first(); await advance(2)
    assert.equal(counts['gallery-reference-tasks'], 4, 'one remaining workbench keeps observation alive')
    second(); closeLaunches()
    const closed = { ...counts }
    await advance(60)
    assert.deepEqual(counts, closed, 'the last consumer stops every directory polling loop')

    const reopened = observe(face.hooks.workbench), reopenedLaunches = observe(face.hooks.launches)
    await flush()
    assert.equal(counts.snapshot, closed.snapshot + 1)
    assert.equal(counts['search-launch-list'], closed['search-launch-list'] + 1)
    await fixture.action('style-create', { operationId: 'entry-poll-external-style', name: 'External fixture collection' })
    const beforeExternal = counts['search-launch-list']
    await advance(2)
    assert.equal(counts['search-launch-list'], beforeExternal + 1, 'a changed workspace checks an idle launch directory')
    const beforeReset = counts.snapshot
    events.get('connection/reset')(); await flush()
    assert.equal(counts.snapshot, beforeReset + 1)
    assert.equal(registered.filter(item => item.name === 'main').length, 1)
    reopened(); reopenedLaunches()
  } finally {
    for (const stop of observers) stop()
    for (const dispose of effects.reverse()) await dispose()
    context.mock.timers.reset()
    Object.assign(globalThis, previous)
    await fixture.cleanup()
  }
})
