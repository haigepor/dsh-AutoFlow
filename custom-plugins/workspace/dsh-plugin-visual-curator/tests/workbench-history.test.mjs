/** Archived collection state must not hide saved task results. */
import test from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { createCuratorStore } from '../src/client/store.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'

const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url)
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client')
const compiled = await build({ stdin: { contents: "export {createWorkbench} from './src/client/workbench.tsx'; export {zh} from './src/client/workbench-locale.ts'", resolveDir: root, loader: 'ts' }, bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', loader: { '.webp': 'dataurl' }, logLevel: 'silent' })
const filename = resolve(root, 'tests/workbench-history-memory.cjs'), capsule = new Module(filename)
capsule.filename = filename; capsule.paths = Module._nodeModulePaths(dirname(filename)); capsule._compile(compiled.outputFiles[0].text, filename)
const { createWorkbench, zh } = capsule.exports, h = React.createElement
const ui = new Proxy({
  Button: ({ children, disabled, type, className }) => h('button', { disabled, type, className }, children),
  Menu: ({ anchor }) => anchor,
  Tag: ({ children }) => h('span', null, children),
  Modal: () => null,
}, { get: (target, key) => target[key] ?? (() => null) })
const Workbench = createWorkbench(React, ui), expected = JSON.parse(await readFile(new URL('./fixtures/archived-task.expected.json', import.meta.url), 'utf8'))

for (const archived of [true, 'missing']) test(`saved task remains visible when its collection is ${archived === true ? 'archived' : 'missing'}`, async () => {
  const previous = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])), dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.invalid/' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const renderedRoot = createRoot(dom.window.document.getElementById('root'))
  const style = { styleId: 'archived', name: 'Archived cars', archived: true, revision: 1, draftId: 'draft', draftRevision: 1, rules: [], conflicts: [], referenceIds: [], releases: [], candidates: [] }
  const run = { runId: 'saved', styleId: style.styleId, kind: 'crop', status: 'completed', taskBrief: 'Saved twenty wallpapers', counts: { finalPassed: 20 }, warnings: [], results: [{ imageVersionId: 'final', name: 'Saved final wallpaper', width: 1845, height: 3280, kind: 'crop', previewPath: '/api/visual-curator/resource?imageVersionId=final', exportPermission: 'allowed', resultCategory: 'selected', selection: { kind: 'selected', qualification: 'auto-qualified', selectionId: 'selection', rank: 0, warnings: [] } }] }
  const unrelated = { ...style, styleId: 'unrelated', name: 'Other active collection', archived: false }
  const snapshot = { configuration: { ...resolveCurrentConfig({}), visionConfigured: true }, styles: [unrelated, ...(archived === true ? [style] : [])], images: [], runs: [{ ...run, results: [] }], usages: [], splits: [], evaluations: [], exports: [], suggestions: [] }
  const store = createCuratorStore({ invoke: async operation => operation === 'session-open' ? { sessionToken: 'fixture' } : operation === 'snapshot' ? snapshot : operation === 'run-get' ? run : Promise.reject(new Error(operation)) })
  try {
    await store.openTask(run.runId, 'saved-session')
    await store.reload(true, true)
    await act(async () => renderedRoot.render(h(Workbench, { useWorkbench: select => select(store.getSnapshot()), useVisionModels: select => select({ status: 'idle' }), useDatasets: select => select({ entries: [] }), useLaunches: select => select({ entries: [] }), actions: { ...store, datasets: {}, launches: {} }, t: key => zh[key], welcomeImage: '', logoImage: '', renderFactorySlot: () => null })))
    const document = dom.window.document
    assert.deepEqual({ welcome: !!document.querySelector('.vc-welcome'), results: document.querySelectorAll('.vc-result-card').length, image: document.querySelector('.vc-result-preview img')?.getAttribute('alt'), dimensions: document.querySelector('.vc-result-dimensions')?.textContent, archived: store.getSnapshot().snapshot.styles.find(item => item.styleId === style.styleId)?.archived ?? null }, { ...expected, archived: archived === true ? true : null })
    assert(document.body.textContent.includes('20'))
    assert.equal(document.querySelector('.vc-task-empty'), null)
  } finally { await act(async () => renderedRoot.unmount()); store.dispose(); dom.window.close(); for (const [key, descriptor] of Object.entries(previous)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
})
