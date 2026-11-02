/** Real stores and native Workbench, with explicit read barriers and no server mutations. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { installIconSprite } from '../../../../../packages/client/ui-theme/src/client/icon-sprite.ts'
import { createCuratorStore } from '../../src/client/store.ts'
import { createSearchBatchesStore } from '../../src/client/search-batches-store.ts'
import { createWorkbench } from '../../src/client/workbench.tsx'
import { zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/personalization.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'

const h = React.createElement, Workbench = createWorkbench(React, UI), base = window.feedbackFixtureData.snapshot
const t = key => zh[key], styleId = base.styles[0].styleId, disposers = []
installIconSprite({ effect: register => { disposers.push(register()) }, on: () => () => {} }, undefined)
const css = document.createElement('style'); css.textContent = pluginCss; document.head.append(css)
const flags = { holdSession: false, holdRuns: false, holdBatches: false, holdOwner: false, calls: [] }
const waiters = []
const wait = (kind, key) => new Promise(resolve => waiters.push({ kind, key, resolve }))
const release = (kind, key) => { for (const entry of [...waiters]) if (entry.kind === kind && (key === undefined || entry.key === key)) { waiters.splice(waiters.indexOf(entry), 1); entry.resolve() } }
const image = (id, category = 'selected') => ({ ...base.images[0], imageVersionId: id, name: id,
  resultCategory: category, selection: category === 'selected' ? { kind: 'selected', selectionId: id, qualification: 'auto-qualified', rank: 0, warnings: [] } : { kind: 'not-selected' },
  previewPath: `/api/visual-curator/resource?imageVersionId=${id}`, width: 400, height: 240,
})
const images = ['selected', 'review', 'rejected', 'processing'].map(category => image(`${category}-image`, category))
const summary = { candidates: 4, selected: 1, needsReview: 1, rejected: 1, failedImages: 0, processing: 1, pending: 0, sourceImages: 0, technicalFailed: 0, unavailable: 0, target: 3 }
const run = id => ({ runId: id, styleId, kind: 'search', status: 'completed', counts: { candidates: 4, qualified: 1 }, results: [], taskBrief: id === 'task-a' ? 'Target A saved search' : id === 'task-b' ? 'Target B saved search' : 'Old unrelated task must stay hidden', warnings: [], resultSummary: summary, outputKind: 'preview' })
const batch = id => ({ runId: id, sessionId: `session-${id.slice(-1)}`, kind: 'search', status: 'completed', createdAt: '2026-10-31T00:00:00Z', taskBrief: `Saved batch ${id}`, matched: 1, unavailable: false, images: [image(`match-${id}`)] })
const owner = { ...base, collectionPaging: true, images: [], runs: [], styles: [base.styles[0]] }
const session = { ...owner, runs: [run('old-unrelated')] }
async function invoke(operation, args) {
  flags.calls.push({ operation, runId: args.runId, resultFilter: args.resultFilter, batchId: args.batchId, pageToken: args.pageToken, scoped: !!args.sessionToken })
  if (operation === 'session-open') { if (flags.holdSession) await wait('session', args.sessionId); return { sessionToken: `grant-${args.sessionId}` } }
  if (operation === 'snapshot') { if (!args.sessionToken && flags.holdOwner) await wait('owner'); return args.sessionToken ? session : owner }
  if (operation === 'run-get') {
    if (flags.holdRuns) await wait('run', args.resultFilter)
    return { ...run(args.runId), resultFilter: args.resultFilter, results: args.resultFilter === 'all' ? images : images.filter(image => image.resultCategory === args.resultFilter) }
  }
  if (operation === 'search-batches') {
    if (flags.holdBatches) await wait('batches')
    return { styleId, totalBatches: 2, totalMatches: 2,
      batches: args.batchId ? [batch(args.batchId)] : args.pageToken ? [batch('task-b')] : [batch('task-a')],
      ...(!args.batchId && !args.pageToken ? { nextPageToken: 'next-batch' } : {}),
    }
  }
  if (operation === 'gallery-reference-tasks') return { tasks: [], analyses: [] }
  if (operation === 'reference-state') return { styleId, revision: 1, digest: 'fixture', total: 0, pending: 0, reusable: 0, changed: 0, entries: [] }
  throw new Error(`Unexpected fixture operation: ${operation}`)
}
const store = createCuratorStore({ invoke })
const batches = createSearchBatchesStore({ invoke, scope: store.getOwnerScopeId, pollMs: () => 1_000_000,
  cachePolicy: () => ({ ttlMs: store.getSnapshot().snapshot?.configuration.limits.batchCacheTtlMs ?? 0, maxViews: 8, resourceTtlMs: store.getSnapshot().snapshot?.configuration.limits.sessionGrantTtlMs ?? 0 }),
})
const noop = () => {}, asyncNoop = async () => {}
const dataset = { entries: [], pageIds: [], total: 0, allTotal: 0, watched: [], dismissed: [], submissions: [], loading: false, error: false, detailId: '', detail: null }
const actions = { ...store, batches,
  datasets: { start: asyncNoop, refresh: asyncNoop, loadMore: asyncNoop, filter: noop, open: asyncNoop, moreSamples: asyncNoop, closeDetail: noop, dismiss: noop },
  launches: { start: asyncNoop, retry: asyncNoop, stop: asyncNoop, refresh: asyncNoop, loadOptions: asyncNoop, loadDatasets: asyncNoop, openSession: noop },
  publish: asyncNoop, saveCredential: asyncNoop, loadVisionModels: asyncNoop, reloadVisionModels: noop, openModelSettings: noop, pickLocalReferences: asyncNoop, listLocalReferences: asyncNoop, galleryRead: asyncNoop,
}
function App() {
  const client = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const groups = React.useSyncExternalStore(batches.subscribe, batches.getSnapshot)
  return h(React.Fragment, null,
    h('div', { className: 'fixture-toolbar' }, h(UI.Button, { onClick: () => { void store.openTask('task-a', 'session-a') } }, 'Native open task A')),
    h(Workbench, { useWorkbench: select => select(client), useSearchBatches: select => select(groups), useVisionModels: select => select({ status: 'ready', value: { models: [], unavailable: [] } }),
      useDatasets: select => select(dataset), useLaunches: select => select({ entries: [], loading: false, optionsLoading: false, error: '', options: null, submission: null }),
      actions, t, welcomeImage: '', logoImage: '', renderFactorySlot: () => null,
    }),
  )
}
const root = createRoot(document.getElementById('root'))
store.selectWorkspace('tasks')
await store.reload(true, true)
root.render(h(App))
window.taskNavigationFixture = { flags, store, batches, release,
  status: () => ({ target: store.getSnapshot().taskTarget, scope: store.getSnapshot().scopeSessionId, filter: store.getSnapshot().snapshot?.runs.find(run => run.runId === store.getSnapshot().runId)?.resultFilter, batchId: batches.getSnapshot().batchId, batches: batches.getSnapshot().page?.batches.map(batch => batch.runId), calls: flags.calls }),
  dispose() { release('session'); release('run'); release('owner'); release('batches'); root.unmount(); batches.dispose(); store.dispose(); disposers.forEach(dispose => dispose()) },
}
