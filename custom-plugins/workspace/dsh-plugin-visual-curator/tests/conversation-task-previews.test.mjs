/** Conversation task thumbnails preserve original links without decoding missing or failed originals. */
import assert from 'node:assert/strict'
import test from 'node:test'
import Module, { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiled = await build({ stdin: { contents: "export { createConversationTaskDock } from './src/client/conversation-task-dock.tsx'; export { conversationRunSchema } from './src/client/conversation-feedback.ts';", resolveDir: root, loader: 'ts' }, bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'silent' })
const filename = resolve(root, 'tests/conversation-thumbnails-memory.cjs'), capsule = new Module(filename)
capsule.filename = filename; capsule.paths = Module._nodeModulePaths(dirname(filename)); capsule._compile(compiled.outputFiles[0].text, filename)
const { createConversationTaskDock, conversationRunSchema } = capsule.exports
const require = createRequire(import.meta.url), React = require('react'), { act } = React

test('the real task dock renders only saved thumbnail resources and keeps original links after errors and missing history', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://owner.example/' }), win = dom.window
  const globals = { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, Element: win.Element, getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const { createRoot } = require('react-dom/client')
  const passthrough = ({ children }) => React.createElement('span', null, children)
  const Button = React.forwardRef(({ children, onClick, className, ...props }, ref) => React.createElement('button', { ref, onClick, className, 'aria-expanded': props['aria-expanded'] }, children))
  const ui = new Proxy({ Button, AnimatedCollapse: ({ children }) => React.createElement('div', null, children), Tooltip: ({ children }) => children, Tag: passthrough }, { get: (target, key) => target[key] ?? passthrough })
  const path = id => `/api/visual-curator/resource?imageVersionId=${id}`
  const run = conversationRunSchema.parse({ runId: 'search', owner: { kind: 'session', sessionId: 'session' }, kind: 'search', status: 'completed', counts: { qualified: 4 }, warnings: [], results: [
    { imageVersionId: 'source-a', name: 'A', previewPath: path('source-a'), thumbnailPath: path('preview-a') },
    { imageVersionId: 'source-b', name: 'B', previewPath: path('source-b'), thumbnailPath: path('preview-b') },
    { imageVersionId: 'legacy', name: 'Legacy', previewPath: path('legacy') },
    { imageVersionId: 'unsafe', name: 'Unsafe', previewPath: path('unsafe'), thumbnailPath: 'https://remote.invalid/private.png' },
  ] })
  const state = { selectedRunId: 'search', tasks: { items: [{ runId: 'search', kind: 'search', status: 'completed', taskBrief: 'Saved image task' }], freshness: 'current' }, runs: { search: { run, freshness: 'current' } } }
  const Dock = createConversationTaskDock(React, ui), host = createRoot(win.document.getElementById('root'))
  const draw = async () => { await act(async () => { host.render(React.createElement(React.Fragment, null, React.createElement('p', { id: 'normal-ai' }, 'Normal AI answer stays visible.'), React.createElement(Dock, { sessionId: 'session', t: key => key, useFeedback: select => select(state), selectTask() {}, refreshTask() {}, openTask: async () => {}, filterTask() {}, loadMoreTask() {} }))) }) }
  const id = url => new URL(url).searchParams.get('imageVersionId')
  try {
    await draw()
    const images = [...win.document.querySelectorAll('.vc-conversation-task-previews img')]
    const links = [...win.document.querySelectorAll('.vc-conversation-task-previews a')]
    assert.deepEqual({ displayedImages: images.map(image => id(image.src)), originalLinks: links.map(link => id(link.href)), legacyOriginalInImgSrc: images.some(image => id(image.src) === 'legacy'), normalAI: win.document.getElementById('normal-ai').textContent }, JSON.parse(await readFile(new URL('./fixtures/conversation-task-previews.expected.json', import.meta.url), 'utf8')))
    await act(async () => { images[0].dispatchEvent(new win.Event('error')) })
    assert.equal(win.document.querySelectorAll('.vc-conversation-task-previews img').length, 1)
    assert.equal(id(win.document.querySelector('a[aria-label="A"]').href), 'source-a')
    await draw()
    assert.equal(win.document.querySelectorAll('.vc-conversation-task-previews img').length, 1, 'Polling cannot turn a failed thumbnail into an original request')
    run.results[0].thumbnailPath = path('preview-a-retry')
    await draw()
    assert.deepEqual([...win.document.querySelectorAll('.vc-conversation-task-previews img')].map(image => id(image.src)), ['preview-a-retry', 'preview-b'])
    assert.equal(win.document.getElementById('normal-ai').textContent, 'Normal AI answer stays visible.')
  } finally {
    await act(async () => { host.unmount() }); win.close()
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})
