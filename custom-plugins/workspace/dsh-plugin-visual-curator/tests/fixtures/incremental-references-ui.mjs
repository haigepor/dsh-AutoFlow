/** Native component acceptance with controlled gallery metadata and no external model calls. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { createWorkbench } from '../../src/client/workbench.tsx'
import { createGalleryReferenceDialog } from '../../src/client/gallery-reference-dialog.tsx'
import { zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/personalization.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'
import '../../../../../packages/client/ui-theme/src/styles/scrollbar.css'

const h = React.createElement, Workbench = createWorkbench(React, UI), Gallery = createGalleryReferenceDialog(React, UI)
const css = document.createElement('style'); css.textContent = pluginCss; document.head.append(css)
const base = window.feedbackFixtureData.snapshot, styleId = base.styles[0].styleId
const image = '/api/visual-curator/resource?imageVersionId=landscape'
const config = { ...base.configuration, visionConfigured: true, source: { ...base.configuration.source, unsplash: { ...base.configuration.source.unsplash, accounts: [{ id: 'a', label: '图库 A', userId: 'user-a', username: 'owner', name: 'Owner', credentialRef: 'FIXTURE' }], defaultAccountId: 'a' } } }
const collection = { ...base.styles[0], revision: 99, referenceIds: ['old-ref', 'new-ref'], modelProfile: { ...base.styles[0].modelProfile, stale: true }, analysis: undefined }
const photos = ['old', 'new-1', 'new-2', 'new-3'].map(id => ({ id, title: id, photographer: '图库作者', width: 400, height: 200, thumbnailUrl: image, referenceUrl: image, pageUrl: 'https://unsplash.com/', photographerUrl: '', premium: false }))
const folder = { id: 'folder', title: '新增和已有图片', description: '', totalPhotos: 4, private: false }
const plan = { styleId, revision: 99, digest: 'confirmed-plan', total: 2, pending: 1, reusable: 1, changed: 0, entries: [{ referenceId: 'old-ref', imageVersionId: 'old-image', state: 'analyzed', providerId: 'unsplash', photoId: 'old' }, { referenceId: 'new-ref', imageVersionId: 'new-image', state: 'pending' }] }
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
  referenceState, selectWorkspace: value => { client.workspace = value; render() }, openSession: asyncNoop, closeSession: noop, prepareTask: asyncNoop, execute: asyncNoop, reload: asyncNoop, getSnapshot: () => client, selectStyle: noop, selectRun: noop, loadMoreImages: asyncNoop, loadRun: asyncNoop, loadReferences: asyncNoop,
  startGalleryReferences: async args => { state.imports.push(args) }, stopGalleryReferences: asyncNoop, startAnalysis: async args => { state.launches.push(args); if (state.holdStart) await new Promise(resolve => (state.startWaiters ??= []).push(resolve)); return { runId: 'accepted' } }, stopAnalysis: asyncNoop, pauseAnalysis: async () => { client.pending = ['pause:fixture-analysis']; updateAnalysis('pausing'); if (state.holdPause) await new Promise(resolve => (state.pauseWaiters ??= []).push(resolve)); client.pending = []; updateAnalysis('paused') }, resumeAnalysis: async () => { state.resumes = (state.resumes ?? 0) + 1; client.pending = ['resume:fixture-analysis']; render(); if (state.holdResume) await new Promise(resolve => (state.resumeWaiters ??= []).push(resolve)); client.pending = []; updateAnalysis('running') }, openAnalysis: runId => { client.analysisRunId = runId; render() }, closeAnalysis: () => { client.analysisRunId = ''; render() }, refreshAnalysisDetail: asyncNoop, loadAnalysisInput: asyncNoop, saveConfiguration: asyncNoop,
  datasets: { start: asyncNoop, refresh: asyncNoop, loadMore: asyncNoop, filter: noop, open: asyncNoop, moreSamples: asyncNoop, closeDetail: noop, dismiss: noop }, launches: { start: asyncNoop, retry: asyncNoop, stop: asyncNoop, refresh: asyncNoop, loadOptions: asyncNoop, loadDatasets: asyncNoop, openSession: noop },
  publish: asyncNoop, saveCredential: asyncNoop, loadVisionModels: asyncNoop, reloadVisionModels: noop, openModelSettings: noop, pickLocalReferences: asyncNoop, listLocalReferences: asyncNoop,
  galleryRead: async (operation, args) => {
    if (operation === 'gallery-collections') return { items: [folder], nextCursor: null }
    if (operation === 'gallery-photos') {
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
  const error = { code: 'request-timeout', stage: 'reviewing', retryable: true, safeMessage: 'The native model request timed out.', suggestedAction: 'Continue from the saved checkpoint.' }
  const task = { ...analysisTask, name, status: status === 'completed' ? 'completed' : 'failed', phase: status === 'completed' ? 'completed' : 'failed', observed: 267, total: 267, continuation: { allowed: status === 'failed', reason: status === 'completed' ? 'completed' : status === 'expired' ? 'deadline' : 'ready' }, ...(status === 'completed' ? { outcome: 'target-met' } : { error }) }
  const requests = ['first', 'second', 'third'].map((requestId, index) => ({ requestId, createdAt: '2026-10-30T00:00:00Z', operation: 'summarize', model: 'fixture', state: index === 2 ? 'committed' : 'outcome-unknown', available: false, imageIds: [], ...(index === 0 ? { error } : index === 1 ? { error: { code: 'cancelled' } } : {}) }))
  const messages = requests.map((request, index) => ({ sequence: index, requestId: request.requestId, kind: 'summary', imageIds: [], content: 'Saved attempt output', reasoning: '', state: index === 0 ? 'failed' : index === 1 ? 'interrupted' : 'complete', at: request.createdAt, updatedAt: request.createdAt }))
  client.analysisTasks = [task]
  client.analysisDetail = { ...client.analysisDetail, task, requests: status === 'completed' ? requests : requests.slice(0, 1), process: { ...client.analysisDetail.process, phase: task.phase, messages: status === 'completed' ? messages : messages.slice(0, 1) } }
  collection.analysis = { ...task, samples: [] }
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
  root.render(state.mode === 'gallery' ? h(Gallery, { config, style: collection, role: 'positive', actions, t: key => zh[key], onClose: noop, onManageAccounts: noop }) : h(Workbench, { useWorkbench: select => select(client), useVisionModels: select => select({ status: 'ready', value: { models: [], unavailable: [] } }), useDatasets: select => select({ styleId, entries: [], pageIds: [], total: 0, allTotal: 0, watched: [], dismissed: [], submissions: [], loading: false, error: false, detailId: '', detail: null }), useLaunches: select => select({ entries: [], loading: false, optionsLoading: false, error: '', options: null, submission: null }), actions, t: key => zh[key], welcomeImage: image, logoImage: image, renderFactorySlot: () => null }))
}
window.incrementalFixture = { state, showDiagnostics, showProfile, releaseResume: () => { state.holdResume = false; for (const resolve of state.resumeWaiters ?? []) resolve(); state.resumeWaiters = [] }, advanceAnalysisProgress: () => { const task = { ...analysisTask, ...collection.analysis, runId: 'fixture-analysis', status: 'running', phase: 'analyzing', observed: 4, total: 267 }; collection.analysis = { ...task, samples: [] }; client.analysisTasks = [task]; if (client.analysisDetail) client.analysisDetail = { ...client.analysisDetail, task }; render() }, getAnalysisRunId: () => client.analysisRunId, showAnalysis, releaseStart: () => { state.holdStart = false; for (const resolve of state.startWaiters ?? []) resolve(); state.startWaiters = [] }, releasePause: () => { state.holdPause = false; for (const resolve of state.pauseWaiters ?? []) resolve(); state.pauseWaiters = [] }, nextRequest: () => { client.analysisDetail = { ...client.analysisDetail, requests: [...client.analysisDetail.requests, { requestId: 'pending-next', createdAt: 'now', operation: 'analyze', state: 'reserved', model: 'fixture', imageIds: [], available: false }] }; render() }, show: mode => { state.mode = mode; render() }, advance: () => { collection.revision++; render() }, releasePages: () => state.pageWaiters.splice(0).forEach(resolve => resolve()), releaseStatus: () => { state.holdStatus = false; state.statusWaiters.splice(0).forEach(resolve => resolve()) }, changed: () => { plan.pending = 2; plan.reusable = 0; plan.changed = 1; plan.entries[0].state = 'needs-update'; render() }, theme: dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dispose: () => root.unmount() }
render()
