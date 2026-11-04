/** Native component acceptance with controlled gallery metadata and no external model calls. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { installIconSprite } from '../../../../../packages/client/ui-theme/src/client/icon-sprite.ts'
import { createWorkbench } from '../../src/client/workbench.tsx'
import { createGalleryReferenceDialog } from '../../src/client/gallery-reference-dialog.tsx'
import { zh } from '../../src/client/workbench-locale.ts'
import bookmarksExpected from './gallery-reference-bookmarks.expected.json'
import pluginCss from '../../src/client/entry.css'
import searchLaunchArtwork from '../../assets/search-launch-whale-maid-v1.webp'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/gradient-shadow-text.css'
import '../../../../../packages/client/ui-theme/src/styles/personalization.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'
import '../../../../../packages/client/ui-theme/src/styles/scrollbar.css'

const h = React.createElement, Workbench = createWorkbench(React, UI), Gallery = createGalleryReferenceDialog(React, UI)
const iconDisposers = []
installIconSprite({ effect: register => { iconDisposers.push(register()) }, on: () => () => {} }, undefined)
const css = document.createElement('style'); css.textContent = pluginCss.replace('__VC_SEARCH_LAUNCH_ART__', searchLaunchArtwork); document.head.append(css)
const base = window.feedbackFixtureData.snapshot, styleId = base.styles[0].styleId
const image = '/api/visual-curator/resource?imageVersionId=landscape'
const config = { ...base.configuration, visionConfigured: true, source: { ...base.configuration.source, unsplash: { ...base.configuration.source.unsplash, accounts: [{ id: 'a', label: '图库 A', userId: 'user-a', username: 'owner', name: 'Owner', credentialRef: 'FIXTURE' }], defaultAccountId: 'a' } } }
const collection = { ...base.styles[0], revision: 99, referenceIds: ['old-ref', 'new-ref'], modelProfile: { ...base.styles[0].modelProfile, stale: true }, analysis: undefined }
const photos = ['old', 'new-1', 'new-2', 'new-3'].map(id => ({ id, title: id, photographer: '图库作者', width: 400, height: 200, thumbnailUrl: image, referenceUrl: image, pageUrl: 'https://unsplash.com/', photographerUrl: '', premium: false }))
const folder = { id: 'folder', title: '新增和已有图片', description: '', totalPhotos: 4, private: false }
const plan = { styleId, revision: 99, digest: 'confirmed-plan', total: 2, pending: 1, reusable: 1, changed: 0, entries: [{ referenceId: 'old-ref', imageVersionId: 'old-image', role: 'positive', state: 'analyzed', providerId: 'unsplash', photoId: 'old' }, { referenceId: 'new-ref', imageVersionId: 'new-image', role: 'negative', state: 'pending' }] }
const snapshot = { ...base, configuration: config, collectionPaging: true, runs: [], styles: [collection], images: ['old', 'new'].map(name => ({ ...base.images[0], imageVersionId: `${name}-image`, referenceId: `${name}-ref`, width: 400, height: 200, name, previewPath: image, thumbnailPath: image })) }
const client = { snapshot, styleId, workspace: 'styles', runId: '', candidateId: '', cropRunId: '', selectedImageIds: [], pending: [], error: null, toast: null, loading: false, page: 0, filter: '', referencePages: {}, galleryTasks: [], analysisTasks: [], analysisDetail: null, analysisRunId: '', analysisInputLoading: [], analysisInputs: {}, analysisInputErrors: {}, analysisLoading: false, analysisStreaming: false, configSaving: false, scopeSessionId: '', sessionToken: '', runLoading: false }
const state = { mode: 'workbench', plans: [], launches: [], imports: [], statusFailure: false, holdStatus: false, statusWaiters: [], pageWaiters: [] }
const referenceState = async id => {
  state.statusReads = (state.statusReads ?? 0) + 1
  if (state.holdStatus) await new Promise(resolve => state.statusWaiters.push(resolve))
  if (state.statusFailure) throw new Error('fixture-read-failed')
  return { ...plan, revision: collection.revision, styleId: id }
}
const noop = () => {}, asyncNoop = async () => {}
const actions = {
  referenceState, selectWorkspace: value => { client.workspace = value; render() }, openSession: asyncNoop, closeSession: noop, prepareTask: asyncNoop, execute: async (operation, args) => { if (operation !== 'style-rename') return; if (args.styleId !== collection.styleId || args.expectedRevision !== collection.revision) throw { code: 'revision-conflict' }; (state.renames ??= []).push(args); collection.name = args.name; collection.revision++; render(); return { id: collection.styleId, name: collection.name, revision: collection.revision } }, reload: asyncNoop, reconcileProfile: asyncNoop, getSnapshot: () => client, selectStyle: noop, selectRun: noop, loadMoreImages: asyncNoop, loadRun: asyncNoop, loadReferences: asyncNoop,
  startGalleryReferences: async args => { state.imports.push(args) }, resumeGalleryReferences: taskId => galleryControl('resume', taskId), stopGalleryReferences: taskId => galleryControl('cancel', taskId), startAnalysis: async args => { state.launches.push(args); if (state.holdStart) await new Promise(resolve => (state.startWaiters ??= []).push(resolve)); return { runId: 'accepted' } }, stopAnalysis: asyncNoop, pauseAnalysis: async () => { client.pending = ['pause:fixture-analysis']; updateAnalysis('pausing'); if (state.holdPause) await new Promise(resolve => (state.pauseWaiters ??= []).push(resolve)); client.pending = []; updateAnalysis('paused') }, resumeAnalysis: async () => { state.resumes = (state.resumes ?? 0) + 1; client.pending = ['resume:fixture-analysis']; render(); if (state.holdResume) await new Promise(resolve => (state.resumeWaiters ??= []).push(resolve)); client.pending = []; updateAnalysis('running') }, openAnalysis: runId => { client.analysisRunId = runId; render() }, closeAnalysis: () => { client.analysisRunId = ''; render() }, refreshAnalysisDetail: asyncNoop, loadAnalysisInput: asyncNoop, saveConfiguration: async args => { (state.configurationSaves ??= []).push(args); if (args.searchScreening) config.searchScreening = { ...args.searchScreening }; config.revision += ':saved'; render() },
  datasets: { start: asyncNoop, refresh: asyncNoop, loadMore: asyncNoop, filter: noop, open: asyncNoop, moreSamples: asyncNoop, closeDetail: noop, dismiss: noop }, launches: { start: asyncNoop, retry: asyncNoop, stop: asyncNoop, refresh: asyncNoop, loadOptions: asyncNoop, loadDatasets: asyncNoop, openSession: noop },
  publish: asyncNoop, saveCredential: asyncNoop, loadVisionModels: asyncNoop, reloadVisionModels: noop, openModelSettings: noop, pickLocalReferences: asyncNoop, listLocalReferences: asyncNoop,
  galleryRead: async (operation, args) => {
    (state.galleryReads ??= []).push({ operation, ...structuredClone(args) })
    if (operation === 'gallery-collections') return { items: state.emptyCollections ? [] : [folder], nextCursor: null }
    if (operation === 'gallery-photos') {
      if (args.scope.kind === 'bookmarks') {
        if (state.bookmarkFailure) throw { code: 'source-request-timeout' }
        if (state.failBookmarksOnce) { state.failBookmarksOnce = false; throw { code: 'source-request-timeout' } }
        if (state.emptyBookmarks) return { items: [], nextCursor: null }
        if (args.cursor && state.holdBookmarkPages) await new Promise(resolve => (state.bookmarkWaiters ??= []).push(resolve))
        const ids = args.cursor ? [3] : [1, 2]
        return { items: ids.map(index => ({ ...photos[1], id: `bookmark-${args.accountId}-${index}`, title: `bookmark-${args.accountId}-${index}` })), nextCursor: args.cursor ? null : 'bookmarks-next' }
      }
      if (args.cursor) await new Promise(resolve => state.pageWaiters.push(resolve))
      return { items: args.cursor ? [photos[0], photos[3]] : photos.slice(0, 3), nextCursor: args.cursor ? null : 'next' }
    }
    throw new Error('Unexpected operation: ' + operation)
  },
}
const analysisTask = { runId: 'fixture-analysis', styleId, name: 'Analysis fixture', status: 'running', observed: 4, total: 8, model: 'fixture-model', reasoningEffort: null, attempts: 1, startedAt: '2026-10-30T00:00:00Z', phase: 'receiving', autoResume: true }
function updateAnalysis(status) {
  const { error, ...previous } = client.analysisDetail?.task ?? analysisTask
  const task = { ...previous, status, phase: status === 'paused' ? 'paused' : 'receiving', continuation: { allowed: status === 'paused', reason: status === 'paused' ? 'ready' : 'active' } }
  client.analysisTasks = [task]
  if (client.analysisDetail) client.analysisDetail = { ...client.analysisDetail, task }
  if (collection.analysis?.runId === task.runId) collection.analysis = { ...collection.analysis, ...task }
  render()
}
function showAnalysis() {
  const native = { transport: 'native-llm', provider: 'fixture', context: { contextWindow: 1000000 }, usage: { inputTokens: 20000, cacheReadTokens: 5000, cacheWriteTokens: 2000, outputTokens: 13000 }, timing: { elapsedMs: 1 } }
  client.analysisRunId = analysisTask.runId
  client.analysisDetail = { task: analysisTask, requests: [{ requestId: 'known', createdAt: 'now', operation: 'analyze', model: 'fixture', state: 'committed', available: false, imageIds: [], native }, { requestId: 'pending', createdAt: 'now', operation: 'analyze', model: 'fixture', state: 'reserved', available: false, imageIds: [], native: { ...native, usage: undefined } }], images: [], observations: [], process: { phase: 'receiving', content: '', reasoning: '', events: [], messages: [], truncated: false, updatedAt: 'now' } }
  updateAnalysis('running')
}
const root = createRoot(document.getElementById('root'))
function showDiagnostics(status, name = 'Analysis fixture') {
  showAnalysis()
  const error = status === 'legacy' ? { code: 'capability-unavailable', stage: 'workflow', retryable: false, safeMessage: 'The operation failed. Saved results remain available.', suggestedAction: 'Check configuration and the saved task diagnostics.' } : { code: 'request-timeout', stage: 'reviewing', retryable: true, safeMessage: 'The native model request timed out.', suggestedAction: 'Continue from the saved checkpoint.' }
  const task = { ...analysisTask, name, status: status === 'completed' ? 'completed' : 'failed', phase: status === 'completed' ? 'completed' : 'failed', observed: status === 'legacy' ? 12 : 267, total: 267, continuation: { allowed: status === 'failed', reason: status === 'completed' ? 'completed' : status === 'expired' ? 'deadline' : status === 'legacy' ? 'not-retryable' : 'ready' }, ...(status === 'completed' ? { outcome: 'target-met' } : { error }) }
  const requests = ['first', 'second', 'third'].map((requestId, index) => ({ requestId, createdAt: '2026-10-30T00:00:00Z', operation: 'summarize', model: 'fixture', state: index === 2 ? 'committed' : 'outcome-unknown', available: false, imageIds: [], ...(index === 0 ? { error } : index === 1 ? { error: { code: 'cancelled' } } : {}) }))
  const messages = requests.map((request, index) => ({ sequence: index, requestId: request.requestId, kind: 'summary', imageIds: [], content: 'Saved attempt output', reasoning: '', state: index === 0 ? 'failed' : index === 1 ? 'interrupted' : 'complete', at: request.createdAt, updatedAt: request.createdAt }))
  client.analysisTasks = [task]
  client.analysisDetail = { ...client.analysisDetail, task, requests: status === 'completed' ? requests : requests.slice(0, 1), process: { ...client.analysisDetail.process, phase: task.phase, messages: status === 'completed' ? messages : messages.slice(0, 1) } }
  collection.analysis = { ...task, samples: [] }
  render()
}
async function galleryControl(command, taskId) {
  (state.galleryControls ??= []).push({ command, taskId })
  if (state.holdGalleryControl) await new Promise(resolve => (state.galleryWaiters ??= []).push(resolve))
  if (state.galleryControlFailure) throw typeof state.galleryControlFailure === 'string' ? { code: state.galleryControlFailure } : typeof state.galleryControlFailure === 'object' ? state.galleryControlFailure : new Error('fixture-connection-unavailable')
  client.galleryTasks = client.galleryTasks.map(task => task.id === taskId ? { ...task, status: command === 'resume' ? 'running' : 'cancelled' } : task)
  render()
}
function showGalleryRecovery() {
  client.analysisRunId = ''; client.analysisTasks = []; collection.analysis = undefined
  client.galleryTasks = [{ id: 'a'.repeat(64), styleId, status: 'needs-review', phase: 'referencing', total: 299, completed: 170, registered: 0, failed: 10, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' }]
  render()
}
function showProfile(status = 'completed', referenceStatus = 'cancelled') {
  showDiagnostics(status)
  client.analysisRunId = ''
  collection.modelProfile = { ...collection.modelProfile, stale: false }
  client.galleryTasks = [{ id: 'a'.repeat(64), styleId, status: referenceStatus, phase: 'referencing', total: 289, completed: 257, registered: 0, failed: 0, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' }]
  render()
}
function render() {
  root.render(state.mode === 'gallery' ? h(Gallery, { config, style: collection, role: state.galleryRole ?? 'positive', actions, t: key => zh[key], onClose: noop, onManageAccounts: noop }) : h(Workbench, { useWorkbench: select => select(client), useVisionModels: select => select({ status: 'ready', value: { models: state.visionModels ?? [], unavailable: [] } }), useDatasets: select => select(state.datasetView ?? { styleId, entries: [], pageIds: [], total: 0, allTotal: 0, watched: [], dismissed: [], submissions: [], loading: false, error: false, detailId: '', detail: null }), useLaunches: select => select(state.launchView ?? { entries: [], loading: false, optionsLoading: false, error: '', options: null, submission: null }), actions, t: key => zh[key], welcomeImage: image, logoImage: image, renderFactorySlot: () => null }))
}
window.incrementalFixture = { state, showDiagnostics, showProfile, releaseResume: () => { state.holdResume = false; for (const resolve of state.resumeWaiters ?? []) resolve(); state.resumeWaiters = [] }, advanceAnalysisProgress: () => { const task = { ...analysisTask, ...collection.analysis, runId: 'fixture-analysis', status: 'running', phase: 'analyzing', observed: 4, total: 267 }; collection.analysis = { ...task, samples: [] }; client.analysisTasks = [task]; if (client.analysisDetail) client.analysisDetail = { ...client.analysisDetail, task }; render() }, getAnalysisRunId: () => client.analysisRunId, showAnalysis, releaseStart: () => { state.holdStart = false; for (const resolve of state.startWaiters ?? []) resolve(); state.startWaiters = [] }, releasePause: () => { state.holdPause = false; for (const resolve of state.pauseWaiters ?? []) resolve(); state.pauseWaiters = [] }, nextRequest: () => { client.analysisDetail = { ...client.analysisDetail, requests: [...client.analysisDetail.requests, { requestId: 'pending-next', createdAt: 'now', operation: 'analyze', state: 'reserved', model: 'fixture', imageIds: [], available: false }] }; render() }, show: mode => { state.mode = mode; render() }, advance: () => { collection.revision++; render() }, releasePages: () => state.pageWaiters.splice(0).forEach(resolve => resolve()), releaseStatus: () => { state.holdStatus = false; state.statusWaiters.splice(0).forEach(resolve => resolve()) }, changed: () => { plan.pending = 2; plan.reusable = 0; plan.changed = 1; plan.entries[0].state = 'needs-update'; render() }, theme: dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dispose: () => { root.unmount(); iconDisposers.forEach(dispose => dispose()) } }
render()

window.incrementalFixture.showScreeningSettings = () => {
  config.vision = { ...config.vision, backend: 'native', provider: 'fixture', model: 'vision-model' }
  config.searchScreening = { candidatePoolSize: 50, batchSize: 6, maxScreeningImageEdge: 384 }
  state.visionModels = [{ provider: 'fixture', providerName: 'Fixture', id: 'vision-model', name: 'Vision model', inputModalities: ['text', 'image'], contextWindow: 100000, maxOutputTokens: 4096 }]
  state.configurationSaves = []
  render()
}

Object.assign(window.incrementalFixture, { showGalleryRecovery, galleryTasks: () => client.galleryTasks, releaseGalleryControl() { state.holdGalleryControl = false; state.galleryWaiters?.splice(0).forEach(resolve => resolve()) } })
Object.assign(window.incrementalFixture, { setScopeCounts(positive, negative) { plan.total = positive + negative; plan.reusable = positive; plan.pending = negative; plan.changed = 0; plan.entries = Array.from({ length: plan.total }, (_, index) => ({ referenceId: `scope-ref-${index}`, imageVersionId: `scope-image-${index}`, role: index < positive ? 'positive' : 'negative', state: index < positive ? 'analyzed' : 'pending' })); collection.referenceIds = plan.entries.map(entry => entry.referenceId); collection.revision++; render() } })

Object.assign(window.incrementalFixture, {
  configureRoleWorkflow(status = 'running') {
    state.mode = 'workbench'
    window.incrementalFixture.setScopeCounts(16, 15)
    collection.modelProfile = { ...base.styles[0].modelProfile, stale: true }
    collection.analysis = { ...analysisTask, status, observed: 16, total: 31, samples: [] }
    const row = { id: 'latest-dataset', exportId: 'latest-dataset', styleId, name: collection.name, modelProfileId: collection.modelProfile.id, profileRevision: 8, model: 'analysis-model-b', contentDigest: 'fixture', sampleScope: 'all', status: 'completed', createdAt: '2026-11-04T00:00:00Z', isFinal: true, stale: true, counts: { references: 16, positive: 16, negative: 0, undecided: 0, rules: 8, candidates: 8, groups: 2, enabledGroups: 2, files: 5 }, downloadPath: '/api/visual-curator/resource?exportId=fixture', byteLength: 2048 }
    const previous = { ...row, id: 'previous-dataset', exportId: 'previous-dataset', modelProfileId: 'previous-profile', profileRevision: 7, model: 'analysis-model-a', isFinal: false, stale: false }
    state.datasetView = { styleId, entries: [row, previous], pageIds: [row.id, previous.id], query: '', status: 'all', total: 2, allTotal: 2, watched: [], dismissed: [], submissions: [], loading: false, error: false, detailId: '', detail: null }
    state.launchView = { entries: [], loading: false, optionsLoading: false, error: '', options: { workspaces: [{ id: 'fixture-workspace', title: 'Isolated image workspace' }], conversationModels: [{ provider: 'fixture', model: 'conversation', label: 'Conversation model' }], defaultConversationModel: { provider: 'fixture', model: 'conversation' }, conversationModelSelection: true, automaticDatasetPreparation: true, negativeReferenceDatasets: true, datasetSelection: 'required', previewSearch: true, maxTargetCount: 100 }, submission: null }
    actions.launches.loadDatasets = async modelProfileId => { state.launchView.datasetOptions = { modelProfileId, entries: [row, previous], total: 2, loading: false, error: '', negativeReferences: { datasets: 0, references: 0 } }; render() }
    actions.launches.start = async input => { (state.searchLaunches ??= []).push(input) }
    render()
  },
})
Object.assign(window.incrementalFixture, {
  bookmarksExpected,
  showBookmarks(role = 'positive') {
    state.mode = 'gallery'; state.galleryRole = role; state.galleryReads = []; state.imports = []
    config.source.unsplash.accounts = [config.source.unsplash.accounts[0], { id: 'b', label: '图库 B', userId: 'user-b', username: 'other', name: 'Other', credentialRef: 'OTHER_FIXTURE' }]
    render()
  },
  releaseBookmarkPages() { state.holdBookmarkPages = false; for (const resolve of state.bookmarkWaiters ?? []) resolve(); state.bookmarkWaiters = [] },
  preparePerformance(count) {
    const template = snapshot.images[0], sample = collection.modelProfile.samples[0]
    snapshot.images = Array.from({ length: count }, (_, index) => ({ ...template, imageVersionId: `performance-image-${index}`, referenceId: `performance-ref-${index}`, name: `vehicle ${index}`, role: index % 10 ? 'positive' : 'negative' }))
    collection.referenceIds = snapshot.images.map(image => image.referenceId)
    plan.total = count; plan.pending = 0; plan.reusable = count; plan.changed = 0
    plan.entries = snapshot.images.map(image => ({ referenceId: image.referenceId, imageVersionId: image.imageVersionId, role: image.role, state: 'analyzed' }))
    const samples = snapshot.images.map(image => ({ ...sample, referenceId: image.referenceId, imageVersionId: image.imageVersionId, role: image.role, image }))
    const profile = { ...collection.modelProfile }
    state.closedEvidenceReads = 0
    Object.defineProperty(profile, 'samples', { enumerable: true, get() { state.closedEvidenceReads++; return samples } })
    collection.modelProfile = profile; collection.revision++; render()
  },
  performanceCounts() { return { closedEvidenceReads: state.closedEvidenceReads, statusReads: state.statusReads ?? 0 } },
  enablePerformancePaging() {
    const count = snapshot.images.length
    collection.referenceIds = [...collection.referenceIds, ...Array.from({ length: 20 }, (_, index) => `performance-ref-${count + index}`)]
    const total = collection.referenceIds.length
    client.referencePages = { [styleId]: { total, ids: collection.referenceIds, counts: { all: total, positive: total - Math.ceil(total / 10), negative: Math.ceil(total / 10), undecided: 0 }, nextPageToken: 'performance-next', endPageToken: 'performance-next', revision: collection.revision, draftRevision: collection.draftRevision, loading: false, error: null } }
    state.performancePageReads = 0
    actions.loadMoreImages = async () => {
      const current = client.referencePages[styleId]
      if (!current.nextPageToken) return
      state.performancePageReads++
      const start = snapshot.images.length, template = snapshot.images[0]
      snapshot.images = [...snapshot.images, ...Array.from({ length: 20 }, (_, index) => ({ ...template, imageVersionId: `performance-image-${start + index}`, referenceId: `performance-ref-${start + index}`, name: `vehicle ${start + index}`, role: (start + index) % 10 ? 'positive' : 'negative' }))]
      delete current.nextPageToken; render()
    }
    render()
  },
})
