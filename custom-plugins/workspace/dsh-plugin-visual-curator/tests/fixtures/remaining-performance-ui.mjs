/** Native production components with synthetic observations and controlled, keyless Host reads. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { installIconSprite } from '../../../../../packages/client/ui-theme/src/client/icon-sprite.ts'
import { createSearchBatchResults } from '../../src/client/search-batch-results.tsx'
import { createDatasetWorkspace } from '../../src/client/dataset-workspace.tsx'
import { createDatasetStore } from '../../src/client/dataset-store.ts'
import { zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../../../packages/client/ui-theme/src/styles/personalization.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'

const cleanups = []
installIconSprite({ effect: callback => cleanups.push(callback()), on: () => () => {} }, undefined)
const css = document.createElement('style'); css.textContent = pluginCss; document.head.append(css)
const h = React.createElement, t = key => zh[key], root = createRoot(document.getElementById('app'))
const Batch = createSearchBatchResults(React, UI), Dataset = createDatasetWorkspace(React, UI)
const fields = ['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth']
let mode = 'none', count = 20, paged = false, datasets, rows = [], epoch = 0, reads = [], selectedBatch = '', batchCounts = [20]
const role = index => index % 5 === 4 ? 'negative' : 'positive'
const entry = () => ({ id: 'synthetic-run', runId: 'synthetic-run', exportId: 'synthetic-export', styleId: 'synthetic-style', name: 'Synthetic collection', modelProfileId: 'synthetic-profile', profileRevision: 1, model: 'fixture', contentDigest: 'synthetic-digest', sampleScope: 'all', createdAt: '2026-01-01T00:00:00Z', status: 'completed', counts: { references: count, positive: count - Math.floor(count / 5), negative: Math.floor(count / 5), undecided: 0, rules: 0, candidates: 0, groups: 0, enabledGroups: 0, files: 0 } })
function createDatasets() {
  return createDatasetStore({ context: () => ({ scope: 1, styleId: 'synthetic-style' }), cachePolicy: () => ({ ttlMs: 60000, maxViews: 8, maxBytes: 16777216, resourceTtlMs: 1800000 }), invoke: async (operation, args) => {
    if (operation === 'datasets-list') return { styleId: 'synthetic-style', total: 1, allTotal: 1, entries: [entry()] }
    if (operation !== 'dataset-get') throw new Error('Unexpected fixture read')
    reads.push({ ...args })
    const filtered = rows.filter(sample => args.sampleRole === 'all' || sample.role === args.sampleRole), start = Number(args.pageToken ?? 0), end = paged ? Math.min(start + 20, filtered.length) : filtered.length
    return { entry: entry(), summary: '', matchingPrompt: '', rules: [], groups: [], files: [], resources: { remote: 0, total: count, pixelDigests: 0, humanAccepts: 0 }, sampleTotal: filtered.length, samples: filtered.slice(start, end), ...(end < filtered.length ? { nextSamplePageToken: String(end) } : {}) }
  } })
}
const batchActions = { watch: () => () => {}, select: value => { selectedBatch = value; root.render(h(App, { key: epoch })) }, refresh: () => {}, more: async () => {}, moreImages: async () => {}, remove: async () => {} }
function useDatasets(select) { return select(React.useSyncExternalStore(datasets.subscribe, datasets.getSnapshot)) }
function App() {
  const batches = batchCounts.map((n, index) => ({ runId: `synthetic-batch-${index}`, kind: 'search', status: 'completed', createdAt: '2026-01-01T00:00:00Z', taskBrief: `Synthetic vehicle image batch ${index}`, matched: n, unavailable: false, images: Array.from({ length: n }, (_, i) => ({ imageVersionId: `synthetic-image-${index}-${i}`, name: `Synthetic vehicle ${index}-${i}`, width: 1200, height: 800, previewPath: `/api/visual-curator/resource?imageVersionId=synthetic-image-${index}-${i}` })) }))
  const page = { styleId: 'synthetic-style', totalMatches: batchCounts.reduce((sum, n) => sum + n, 0), totalBatches: batches.length, batches: selectedBatch ? batches.filter(batch => batch.runId === selectedBatch) : batches }
  return h('div', { className: 'vc-page-frame' }, mode === 'batch' ? h(Batch, { styleId: 'synthetic-style', pageSize: 20, t, actions: batchActions, useBatches: select => select({ styleId: 'synthetic-style', batchId: selectedBatch, page, loading: false, error: false, deleting: [] }), onOpen: async () => {} }) : mode === 'dataset' ? h(Dataset, { useDatasets, actions: { datasets }, t, onGenerate: () => {}, canGenerate: false }) : null)
}
async function show(next, total, paging = false) {
  datasets?.dispose(); count = total; mode = next; paged = paging; reads = []; epoch++; selectedBatch = ''; batchCounts = [total]
  rows = Array.from({ length: total }, (_, index) => ({ referenceId: `synthetic-ref-${index}`, imageVersionId: `synthetic-image-${index}`, role: role(index), unavailable: false, measuredCount: 0, previewSize: { width: 1200, height: 800 }, previewPath: `/api/visual-curator/resource?imageVersionId=synthetic-image-${index}`, observations: fields.map(field => ({ field, value: `The vehicle remains a clear subject in natural light with layered surroundings. ${'Readable subject and environmental texture. '.repeat(3)}`, uncertain: false })) }))
  if (mode === 'dataset') { datasets = createDatasets(); datasets.sync(); await datasets.open('synthetic-run') }
  root.render(h(App, { key: epoch }))
}
window.remainingFixture = { show, reads: () => reads, appendResults() { batchCounts[0] += 20; root.render(h(App, { key: epoch })) }, showBatches(totals) { mode = 'batch'; epoch++; batchCounts = totals; selectedBatch = ''; root.render(h(App, { key: epoch })) } }
document.getElementById('controls')?.addEventListener('click', event => { const button = event.target.closest('button[data-mode]'); if (button) void show(button.dataset.mode, Number(button.dataset.count)) })
window.addEventListener('beforeunload', () => { datasets?.dispose(); root.unmount(); cleanups.forEach(dispose => dispose()) }, { once: true })
root.render(h(App, { key: epoch }))
