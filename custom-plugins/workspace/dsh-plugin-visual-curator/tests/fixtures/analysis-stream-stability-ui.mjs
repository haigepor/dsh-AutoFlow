/** Real dialog, stream store, virtualizer and Markdown with synthetic visual observations. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { installIconSprite } from '../../../../../packages/client/ui-theme/src/client/icon-sprite.ts'
import { createAnalysisDialog } from '../../src/client/analysis-dialog.tsx'
import { createCuratorStore } from '../../src/client/store.ts'
import { en, zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/gradient-shadow-text.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'
import '../../../../../packages/client/ui-theme/src/styles/scrollbar.css'

const h = React.createElement, root = createRoot(document.getElementById('root')), Dialog = createAnalysisDialog(React, UI)
const disposers = []
installIconSprite({ effect: callback => { disposers.push(callback()) }, on: () => () => {} }, undefined)
const css = document.createElement('style'); css.textContent = pluginCss; document.head.append(css)
let dictionary = zh
const t = key => dictionary[key], noop = () => {}
const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied', toolbarLabels: { codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' } }, footnotes: 'Footnotes' }
const at = '2026-11-02T00:00:00.000Z'
const imageIds = ['synthetic-image']
const task = { runId: 'synthetic-stream', styleId: 'synthetic-style', name: 'Synthetic stream stability', status: 'running', phase: 'receiving', observed: 0, total: 1, model: 'synthetic-model', reasoningEffort: null, attempts: 1, startedAt: at, autoResume: true }
const observations = Array.from({ length: 48 }, (_, index) => ({ dimension: ['color', 'lighting', 'texture', 'composition'][index % 4], observation: `Visible observation ${String(index).padStart(2, '0')}: soft reflected light and fine surface grain remain consistent across the supplied image. `.repeat(3), uncertain: false }))
const content = JSON.stringify({ observations: [{ imageVersionId: imageIds[0], dimensions: observations }] }, null, 2)
const initialLength = content.indexOf('Visible observation 18')
const message = { sequence: 0, kind: 'analysis', batch: 1, imageIds, state: 'streaming', reasoning: 'Synthetic reasoning for the supplied reference.', content: content.slice(0, initialLength), at, updatedAt: at }
let detail = { task, observations: [], images: [{ imageVersionId: imageIds[0], name: 'Synthetic reference' }], requests: [], process: { messages: [message], events: [], content: '', reasoning: '', truncated: false, updatedAt: at, phase: 'receiving' } }
let receive, endFollow, position = initialLength, revision = 0
let resumeCalls = 0
const store = createCuratorStore({
  invoke: async operation => { if (operation !== 'analysis-detail') throw new Error(`Unexpected fixture operation: ${operation}`); return detail },
  followAnalysis: async (_args, callback, signal) => { receive = callback; await new Promise(resolve => { endFollow = resolve; signal.addEventListener('abort', resolve, { once: true }) }) },
})
function renderFactorySlot(name, props) {
  if (name === 'conversation.images.content') return h('span', {}, 'Synthetic reference')
  return h(UI.MarkdownText, { text: props.text ?? '', streaming: props.streaming ?? props.running ?? false, labels })
}
function App() {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  return h(Dialog, { state, t, onClose: noop, onStop: noop, onPause: noop, onResume: () => { resumeCalls++ }, onRetry: noop, onReadInput: noop, renderFactorySlot })
}
store.openAnalysis(task.runId)
await store.refreshAnalysisDetail()
flushSync(() => root.render(h(App)))
window.analysisStreamStability = {
  append(bytes = 37) {
    position = Math.min(content.length, position + bytes)
    revision++
    const retained = content.slice(0, position).slice(-12_000)
    detail = { ...detail, process: { ...detail.process, content: retained, truncated: position > 12_000, messages: [{ ...message, content: retained, updatedAt: `${at}-${revision}` }], updatedAt: `${at}-${revision}` } }
    receive({ runId: task.runId, status: 'running', process: detail.process, checkpoint: false })
    return { position, total: content.length }
  },
  raw() { return detail.process.messages[0].content },
  resumeCalls() { return resumeCalls },
  fail() {
    detail = { ...detail, task: { ...detail.task, status: 'failed', phase: 'failed', continuation: { allowed: true, reason: 'ready' } }, process: { ...detail.process, phase: 'failed', messages: [{ ...detail.process.messages[0], state: 'failed' }] } }
    receive({ runId: task.runId, status: 'failed', process: detail.process, checkpoint: true })
    endFollow()
  },
  async complete() {
    detail = { ...detail, task: { ...task, status: 'completed', phase: 'completed', observed: 1 }, observations: [{ imageVersionId: imageIds[0], dimensions: observations.map(row => ({ field: row.dimension, value: row.observation, uncertain: row.uncertain })) }], process: { ...detail.process, phase: 'completed', messages: [{ ...detail.process.messages[0], state: 'complete' }] } }
    await store.refreshAnalysisDetail()
  },
  async openFresh() {
    store.closeAnalysis()
    detail = { ...detail, task: { ...task, runId: 'synthetic-fresh' }, observations: [], process: { ...detail.process, phase: 'receiving', messages: [{ ...message, content: '{"observations":[]}' }] } }
    store.openAnalysis(detail.task.runId)
    await store.refreshAnalysisDetail()
  },
  writeFresh() {
    const content = JSON.stringify({ observations: [{ imageVersionId: imageIds[0], dimensions: [{ dimension: 'color', observation: 'Fresh response stays independent.' }] }] })
    detail = { ...detail, process: { ...detail.process, messages: [{ ...message, content }] } }
    receive({ runId: detail.task.runId, status: 'running', process: detail.process, checkpoint: false })
  },
  locale(language) { dictionary = language === 'en' ? en : zh; flushSync(() => root.render(h(App))) },
  theme(dark) { document.body.toggleAttribute('data-ds-dark-theme', dark) },
  dispose() { root.unmount(); store.dispose(); disposers.forEach(dispose => dispose()) },
}
