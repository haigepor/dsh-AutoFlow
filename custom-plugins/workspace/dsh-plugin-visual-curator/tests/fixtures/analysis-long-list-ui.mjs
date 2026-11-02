/** Synthetic 300-image transcript over the real analysis dialog and native Markdown renderer. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { installIconSprite } from '../../../../../packages/client/ui-theme/src/client/icon-sprite.ts'
import { createAnalysisDialog } from '../../src/client/analysis-dialog.tsx'
import { zh } from '../../src/client/workbench-locale.ts'
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
const t = key => zh[key], noop = () => {}, labels = {}, metrics = { markdownCalls: 0, initialCommitMs: 0 }
const fields = ['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth']
let state
let growth = 0
function prepare(count = 75) {
  const observations = [], images = [], requests = [], messages = [], inputs = {}
  for (let batch = 0; batch < count; batch++) {
    const imageIds = Array.from({ length: 4 }, (_, i) => `synthetic-image-${batch * 4 + i}`), requestId = `synthetic-request-${batch}`
    for (const [i, imageVersionId] of imageIds.entries()) {
      images.push({ imageVersionId, name: `Synthetic reference ${batch + 1}-${i + 1}` })
      observations.push({ imageVersionId, dimensions: fields.map((field, index) => ({ field, value: `Observation ${batch + 1}-${i + 1}-${field}. Soft reflected light separates the vehicle from the background. Fine surface grain and balanced negative space remain visible. `.repeat(2 + index % 2), uncertain: false })) })
    }
    const native = { transport: 'native-llm', provider: 'synthetic', context: { contextWindow: 128000 }, usage: { inputTokens: 4000 + batch * 10, outputTokens: 1200, cacheReadTokens: 20 }, timing: { elapsedMs: 1200 } }
    requests.push({ requestId, operation: 'analyze', state: 'committed', model: 'synthetic-model', imageIds, available: true, createdAt: '2026-10-30T00:00:00Z', native })
    messages.push({ sequence: batch, requestId, kind: 'analysis', batch: batch + 1, imageIds, state: 'complete', reasoning: `Batch ${batch + 1} checks only the supplied visual dimensions.`, content: JSON.stringify({ observations: observations.slice(-4) }), at: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' })
    inputs[requestId] = { requestId, instructions: 'Inspect only supplied visual references.', inputText: `Inspect batch ${batch + 1} for color, light, texture and composition.`, images: imageIds.map(imageVersionId => ({ imageVersionId, name: imageVersionId, digest: imageVersionId, mime: 'image/webp', role: 'positive', previewPath: `/api/visual-curator/resource?imageVersionId=${imageVersionId}`, sourceKind: 'remote' })) }
  }
  const task = { runId: 'synthetic-run', styleId: 'synthetic-style', name: 'Synthetic long transcript', status: 'running', phase: 'analyzing', observed: count * 4, total: count * 4, model: 'synthetic-model', reasoningEffort: null, attempts: 1, startedAt: '2026-10-30T00:00:00Z', autoResume: true }
  state = { analysisRunId: task.runId, analysisDetail: { task, observations, images, requests, process: { messages, events: [], content: '', reasoning: '', truncated: false, updatedAt: '2026-10-30T00:00:00Z', phase: 'analyzing' } }, analysisTasks: [task], analysisInputs: inputs, analysisInputErrors: {}, analysisInputLoading: [], analysisLoading: false, pending: [], analysisError: null, snapshot: null }
}
function renderFactorySlot(name, props) {
  if (name === 'conversation.images.content') return h('div', { style: { display: 'flex', gap: 8 } }, props.images.map((image, i) => h('img', { key: i, src: image.preview.thumbnailUrl ?? image.preview.url, alt: image.preview.name ?? '', loading: 'lazy', width: 64, height: 64 })))
  metrics.markdownCalls++
  return h(UI.MarkdownText, { text: props.text ?? '', streaming: props.streaming ?? props.running ?? false, labels })
}
function render() { root.render(h(Dialog, { state, t, onClose: noop, onStop: noop, onPause: noop, onResume: noop, onRetry: noop, onReadInput: noop, renderFactorySlot })) }
prepare()
const mountedAt = performance.now(); flushSync(render); metrics.initialCommitMs = performance.now() - mountedAt
window.analysisLongList = {
  metrics,
  update() { const start = performance.now(), detail = state.analysisDetail; state = { ...state, analysisDetail: { ...detail, process: { ...detail.process, updatedAt: new Date().toISOString() } } }; flushSync(render); return performance.now() - start },
  grow() { const detail = state.analysisDetail, tail = detail.process.messages.at(-1); growth++; const content = JSON.stringify({ observations: [{ imageVersionId: tail.imageIds[0], dimensions: [{ dimension: 'color', observation: 'New live output with a slowly expanding visual observation. '.repeat(growth * 20) }] }] }); state = { ...state, analysisDetail: { ...detail, process: { ...detail.process, messages: [...detail.process.messages.slice(0, -1), { ...tail, state: 'streaming', content }], updatedAt: new Date().toISOString() } } }; flushSync(render) },
  reportUsage(tokens) { const detail = state.analysisDetail, requests = detail.requests.map((request, i) => i === detail.requests.length - 1 ? { ...request, native: { ...request.native, usage: { inputTokens: tokens, outputTokens: 0 } } } : request); state = { ...state, analysisDetail: { ...detail, requests } }; flushSync(render) },
  reset(count) { prepare(count); metrics.markdownCalls = 0; flushSync(render) },
  theme(dark) { document.body.toggleAttribute('data-ds-dark-theme', dark) },
  dispose() { root.unmount(); disposers.forEach(dispose => dispose()) },
}
