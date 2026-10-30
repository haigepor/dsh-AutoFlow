/** Native components; browser-only transport replies are controlled and never reach a provider. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as UI from '../../../../../packages/client/ui-primitives/src/index.ts'
import { TodoPanel } from '../../../../../packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx'
import { ConversationContent } from '../../../../../packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx'
import conversationCss from '../../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css'
import { createConversationFeedback } from '../../src/client/conversation-feedback.ts'
import { createTaskToolView } from '../../src/client/task-tool-view.tsx'
import { createConversationTaskDock } from '../../src/client/conversation-task-dock.tsx'
import { createWorkbench } from '../../src/client/workbench.tsx'
import { zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/personalization.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'

const h = React.createElement, t = key => zh[key], { run: hostRun, snapshot: baseSnapshot } = window.feedbackFixtureData
const style = document.createElement('style'); style.textContent = pluginCss; document.head.append(style)

const svgUrl = (w, h, bg, accent, label) => `/api/visual-curator/resource?imageVersionId=${encodeURIComponent(`${label}-${w}x${h}-${bg}-${accent}`)}`
const baseImage = hostRun.results[0] ?? {
  imageVersionId: 'img-selected-landscape', assetId: 'asset-1', familyId: 'fam-1',
  width: 1600, height: 900, kind: 'crop', previewPath: '/api/visual-curator/resource?imageVersionId=landscape',
  sourcePreviewPath: '/api/visual-curator/resource?imageVersionId=source-landscape',
  name: 'misty-forest-wide.png', source: 'provider', exportPermission: 'allowed', groupingStatus: 'confirmed',
}
const longReason = '色彩与光影完全契合目标低饱和胶片画像：高光柔和克制，暗部保留冷绿森林层次，主体构图在右侧三分之一处留出充足的标题安全区。规则核对：1) 色彩饱和度偏低且色调统一（通过）；2) 自然散射光无生硬直射阴影（通过）；3) 远景雾气形成柔和景深过渡（通过）；4) 裁剪框完整避开边缘干扰元素并保留地面纹理细节。'
const richResults = [
  {
    ...baseImage,
    imageVersionId: 'img-selected-landscape',
    name: 'misty-forest-wide.png',
    width: 1600,
    height: 900,
    previewPath: '/api/visual-curator/resource?imageVersionId=landscape',
    sourcePreviewPath: '/api/visual-curator/resource?imageVersionId=source-landscape',
    reviewStage: 'final',
    verdict: 'pass',
    resultCategory: 'selected',
    selection: { kind: 'selected', selectionId: 'sel-1', qualification: 'auto-qualified', rank: 1, rankScore: 0.94, warnings: ['主体偏右，叠加居中长标题时建议复核留白'] },
    styleMatch: { satisfiedWeightRatio: 0.94, groupId: null },
    effectivePixelRect: { x: 120, y: 40, width: 1600, height: 900 },
    reason: longReason,
  },
  {
    ...baseImage,
    imageVersionId: 'img-rejected-portrait',
    name: 'vertical-pine-ridge.png',
    width: 900,
    height: 1440,
    previewPath: '/api/visual-curator/resource?imageVersionId=portrait',
    reviewStage: 'source',
    verdict: 'reject',
    resultCategory: 'rejected',
    selection: { kind: 'not-selected' },
    styleMatch: { satisfiedWeightRatio: 0.42, groupId: null },
    reason: '竖幅构图明暗反差过强，顶部天空高光溢出，不符合柔和自然光与低反差胶片层次要求。',
  },
  {
    ...baseImage,
    imageVersionId: 'img-failed-tall',
    name: 'panoramic-scroll-strip.png',
    width: 420,
    height: 1680,
    previewPath: '/api/visual-curator/resource?imageVersionId=tall',
    reviewStage: 'source',
    resultCategory: 'failed',
    selection: { kind: 'not-selected' },
    technicalFailure: 'vision-timeout',
    reason: '极端竖长图在视觉复核阶段响应超时，已记录技术失败供复核。',
  },
  {
    ...baseImage,
    imageVersionId: 'img-source-wide',
    name: 'horizon-banner-raw.png',
    width: 2100,
    height: 500,
    previewPath: '/api/visual-curator/resource?imageVersionId=wide',
    reviewStage: 'source',
    verdict: 'pass',
    resultCategory: 'source',
    selection: { kind: 'not-selected' },
    styleMatch: { satisfiedWeightRatio: 0.88, groupId: null },
    reason: '超宽幅原图通过初筛，色调与薄雾质感符合画像，保留为源图供其他尺寸裁图复用。',
  },
]

const enrichedPrimaryRun = {
  ...hostRun,
  styleId: baseSnapshot.styles[0]?.styleId,
  taskBrief: '寻找符合当前风格画像的安静森林横版封面图片',
  stage: 'reviewing',
  outcome: 'source-exhausted',
  counts: { ...hostRun.counts, candidates: 6, distinct: 4, qualified: 1, unavailable: 1, technicalFailed: 1, failedQueries: 0 },
  resultSummary: {
    candidates: 4,
    selected: 1,
    needsReview: 0,
    rejected: 1,
    failedImages: 1,
    processing: 0,
    pending: 0,
    sourceImages: 1,
    technicalFailed: 1,
    unavailable: 1,
    target: 10,
  },
  warnings: ['图库关键词 forest 第 2 页无更多结果，已保留当前确认图片'],
  results: richResults,
}

const secondaryInterruptedRun = {
  ...enrichedPrimaryRun,
  runId: 'run-crop-interrupted',
  kind: 'crop',
  status: 'interrupted',
  stage: 'cropping',
  taskBrief: '按竖版海报用途裁剪森林封面并复核留白区域',
  outcome: 'partial-failure',
  error: { code: 'vision-request-interrupted', safeMessage: '视觉复核连接中断' },
  counts: { retrievedUnique: 4, sourceReviewed: 3, cropGenerated: 2, finalPassed: 1 },
  resultSummary: {
    candidates: 2,
    selected: 1,
    needsReview: 1,
    rejected: 0,
    failedImages: 0,
    processing: 0,
    pending: 0,
    sourceImages: 0,
    technicalFailed: 0,
    unavailable: 0,
    target: 4,
  },
  results: [
    richResults[0],
    {
      ...richResults[1],
      imageVersionId: 'img-review-crop',
      name: 'poster-crop-candidate.png',
      resultCategory: 'review',
      verdict: 'needs-review',
      reason: '竖版安全区底部存在树枝细节，需人工确认是否影响副标题可读性。',
    },
  ],
}

let state = { mode: 'conversation', session: 'a', offline: false, calls: [], opened: [], scenario: 'default', filter: 'selected', selectedRunId: enrichedPrimaryRun.runId, scopeSessionId: 'session-a', runCommands: [] }
const store = createConversationFeedback({ invoke: async (operation, args) => {
  state.calls.push([operation, args.sessionId])
  if (state.offline) throw new Error('offline')
  if (operation === 'session-open') return { sessionToken: 'fixture', expiresAt: Date.now() + 1000000, pollIntervalMs: 100 }
  if (operation === 'conversation-runs') return { sessionId: args.sessionId, tasks: [{ runId: hostRun.runId, kind: 'search', status: hostRun.status, taskBrief: hostRun.taskBrief }] }
  return { ...hostRun, owner: { kind: 'session', sessionId: args.sessionId } }
} })
const Task = createTaskToolView(React, UI), WorkbenchView = createWorkbench(React, UI)
const TaskDock = createConversationTaskDock(React, UI)
const todoT = (key, vars = {}) => ({ 'todo.title': '任务', 'todo.status.completed': '已完成', 'todo.status.inProgress': '进行中', 'todo.status.pending': '待处理', 'todo.progress.done': `${vars.done} 已完成`, 'todo.progress.active': `${vars.active} 进行中`, 'todo.progress.pending': `${vars.pending} 待处理` })[key] ?? key
const todos = [{ content: '读取参考包并核验固定画像与检索参数', status: 'completed' }, { content: '启动检索并等待实际像素筛选和最终复核，完整长文本应换行显示', status: 'in_progress' }, { content: '核验保存结果并报告合格数量与失败情况', status: 'pending' }]
function FixtureViews() {
  return h('div', { className: 'fixture-chat' }, h(Task, { phase: 'result', toolName: 'visual_search_start', block: { isError: false, content: [{ type: 'text', text: JSON.stringify({ runId: hostRun.runId }) }] }, t }))
}
function FixtureTaskDock() {
  const source = store.sessionSource(state.session)
  const useFeedback = selector => selector(React.useSyncExternalStore(source.subscribe, source.getSnapshot))
  return h(TaskDock, { sessionId: state.session, t, useFeedback, selectTask: id => store.select(state.session, id), refreshTask: id => store.refresh(state.session, id), openTask: async id => state.opened.push([state.session, id]) })
}
function Conversation() {
  return h('div', { className: `${conversationCss.root} fixture-conversation`, 'data-phase': 'active' }, h(ConversationContent, {
    phase: 'active', sessionId: state.session, hero: false, variant: 'main', t: todoT,
    useSession: select => select({}), useSessions: select => select({ byId: {} }), useSessionStatus: select => select(new Map()),
    useWorkspaces: select => select({ phase: 'ready', items: [] }), useInput: select => select({ draft: '' }), useComposerBlock: select => select(undefined),
    useFactorySlot: (name, fallback) => name === 'views' ? FixtureViews : fallback,
    renderSlot: name => name === 'conversation.input.dock' ? h(FixtureTaskDock) : name === 'conversation.body.overlay' ? h(TodoPanel, { key: state.session, todos: state.session === 'a' ? todos : [{ content: '另一个会话自己的任务', status: 'pending' }], t: todoT }) : name === 'conversation.composer.bar' ? h('div', { className: 'fixture-composer' }, '原生输入区域') : null,
    renderSlotChain: (_name, _owner, options) => options.fallback, inputActions: { prefill: async () => {} }, selectWorkspace: async () => {},
  }))
}

function currentRuns() {
  const primary = {
    ...enrichedPrimaryRun,
    resultFilter: state.selectedRunId === enrichedPrimaryRun.runId ? state.filter : 'selected',
    ...(state.scenario === 'live-refresh' ? {
      counts: { ...enrichedPrimaryRun.counts, candidates: 8, distinct: 5, qualified: 2 },
      resultSummary: { ...enrichedPrimaryRun.resultSummary, candidates: 5, selected: 2 },
      results: [...richResults, { ...richResults[0], imageVersionId: 'img-selected-live', name: 'misty-forest-dawn.png', width: 1440, height: 960, reason: '实时刷新新增入选图片：晨雾层次细腻，布局保持稳定。' }],
    } : {}),
  }
  const secondary = {
    ...secondaryInterruptedRun,
    resultFilter: state.selectedRunId === secondaryInterruptedRun.runId ? state.filter : 'all',
  }
  if (state.scenario === 'multi-task') return [primary, secondary]
  if (state.scenario === 'batches') return [{ ...primary, runId: 'batch-one', outputKind: 'preview' }, { ...primary, runId: 'batch-two', outputKind: 'preview', kind: 'crop', status: 'completed' }]
  if (state.scenario === 'preview') return [{ ...primary, outputKind: 'preview', delivery: undefined, warnings: [...primary.warnings, ...primary.issues.map(issue => `Candidate ${issue.candidateId}: ${issue.code}.`)], results: primary.results.map(image => ({ ...image, kind: 'remote-reference', sourcePreviewPath: undefined, previewUrl: `https://images.unsplash.com/photo-${image.imageVersionId}` })) }]
  if (state.scenario === 'interrupted') return [{ ...secondary, runId: enrichedPrimaryRun.runId, resultFilter: state.filter }]
  return [primary]
}

function Workbench() {
  const styleId = baseSnapshot.styles[0]?.styleId ?? ''
  const runs = currentRuns()
  const activeRun = runs.find(item => item.runId === state.selectedRunId) ?? runs[0]
  const snapshot = { ...baseSnapshot, runs, ...(state.analysisRunning ? { styles: baseSnapshot.styles.map(style => ({ ...style, modelProfile: style.modelProfile ? { ...style.modelProfile, stale: true } : undefined, analysis: { ...style.analysis, runId: 'fixture-analysis', status: 'running', observed: 4, total: 267 } })) } : {}) }
  const clientState = {
    analysisTasks: [],
    analysisDetail: null,
    analysisRunId: '',
    analysisLoading: false,
    analysisStreaming: false,
    analysisError: null,
    analysisInputs: {},
    analysisInputLoading: [],
    analysisInputErrors: {},
    configSaving: false,
    configError: null,
    galleryTasks: [],
    galleryTaskError: null,
    referencePages: {},
    snapshot,
    workspace: 'tasks',
    styleId,
    runId: activeRun?.runId ?? '',
    candidateId: '',
    cropRunId: '',
    cropSelection: 0,
    selectedImageIds: [],
    previewId: '',
    filter: 'all',
    page: 1,
    loading: false,
    pending: [],
    error: null,
    toast: null,
    sessionToken: 'fixture',
    scopeSessionId: state.scopeSessionId ?? '',
    runLoading: false,
    runError: null,
  }
  const launchEntry = {
    id: 'launch-op-1',
    input: { operationId: 'launch-op-1', workspaceId: 'ws-1', modelProfileId: baseSnapshot.styles[0]?.modelProfile?.id ?? 'mp-1', taskBrief: activeRun?.taskBrief ?? '', targetCount: 10, output: { kind: 'original' } },
    sessionId: 'session-a',
    status: 'accepted',
    stage: 'accepted',
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
    runIds: [activeRun?.runId ?? enrichedPrimaryRun.runId],
    runStatus: activeRun?.status ?? 'completed',
    qualified: activeRun?.resultSummary?.selected ?? 1,
  }
  const launchState = { entries: [launchEntry], submission: null, options: { workspaces: [{ id: 'ws-1', title: '默认工作区', path: 'D:/workspace' }], usages: [], defaultTargetCount: 10, maxTargetCount: 200 }, optionsLoading: false, loading: false, error: '' }
  const datasetState = { styleId, entries: [], pageIds: [], total: 0, allTotal: 0, query: '', status: 'all', loading: false, error: false, submissions: [], watched: [], dismissed: [], detailId: '', detail: null, detailLoading: false, detailError: false }
  const batchRows = ['batch-one', 'batch-two'].map((runId, index) => ({ runId, kind: index ? 'crop' : 'search', status: 'completed', createdAt: `2026-10-29T0${index}:00:00Z`, taskBrief: `匹配批次 ${index + 1}`, matched: 1, unavailable: false, images: [{ ...richResults[index], thumbnailPath: `${richResults[index].previewPath}&preview=thumbnail` }] }))
  const batchState = { deleting: [], styleId, batchId: state.batchFilter ?? '', page: { styleId, totalBatches: state.batchFilter ? 1 : 2, totalMatches: state.batchFilter ? 1 : 2, batches: batchRows.filter(batch => !(state.deletedBatchIds ?? []).includes(batch.runId) && (!state.batchFilter || batch.runId === state.batchFilter)) }, loading: false, error: false }
  if (state.batchLoading === 'initial' || state.batchLoading === 'error') batchState.page = null
  if (state.batchLoading === 'empty') batchState.page = { styleId, totalBatches: 0, totalMatches: 0, batches: [] }
  batchState.loading = state.batchLoading === 'initial' || state.batchLoading === 'refresh'
  batchState.error = state.batchLoading === 'error' || state.batchLoading === 'stale-error'
  return h(WorkbenchView, {
    useWorkbench: select => select(clientState),
    useVisionModels: select => select({ status: 'ready', value: { models: [], unavailable: [] } }),
    useDatasets: select => select(datasetState),
    useLaunches: select => select(launchState),
    ...(state.scenario === 'batches' ? { useSearchBatches: select => select(batchState) } : {}),
    t,
    welcomeImage: '/api/visual-curator/resource?imageVersionId=landscape',
    logoImage: '/api/visual-curator/resource?imageVersionId=landscape',
    renderFactorySlot: () => null,
    actions: {
      batches: { watch: () => () => {}, select: batchId => { state.batchFilter = batchId; render() }, refresh: () => {}, more: async () => {}, moreImages: async () => {}, remove: async runId => { state.deletedBatchIds = [...(state.deletedBatchIds ?? []), runId]; render() } },
      selectWorkspace: () => {},
      openSession: async () => {},
      closeSession: () => { state.scopeSessionId = undefined; render() },
      prepareTask: async () => ({}),
      execute: async (op, args) => { state.runCommands.push([op, args]); return {} },
      reload: async () => {},
      getSnapshot: () => clientState,
      selectStyle: () => {},
      selectRun: runId => { state.selectedRunId = runId; state.filter = runId === 'run-crop-interrupted' ? 'all' : 'selected'; render() },
      loadMoreImages: async () => {},
      loadRun: async (runId, _append, resultFilter) => { state.selectedRunId = runId; if (resultFilter) state.filter = resultFilter; render() },
      loadReferences: async () => {},
      startGalleryReferences: async () => ({}),
      stopGalleryReferences: async () => {},
      referenceState: async styleId => ({ styleId, revision: 1, digest: 'fixture', total: 0, pending: 0, reusable: 0, changed: 0, entries: [] }),
      startAnalysis: async () => ({}),
      stopAnalysis: async () => {},
      openAnalysis: () => {},
      closeAnalysis: () => {},
      refreshAnalysisDetail: async () => {},
      loadAnalysisInput: async () => {},
      saveConfiguration: async () => {},
      datasets: { start: async () => {}, refresh: async () => {}, loadMore: async () => {}, filter: () => {}, open: async () => {}, moreSamples: async () => {}, closeDetail: () => {}, dismiss: () => {} },
      launches: { start: async () => {}, retry: async () => {}, stop: async () => {}, refresh: async () => {}, loadOptions: async () => {}, openSession: id => { state.opened.push(['launch', id]); return true } },
      publish: async () => '',
      saveCredential: async () => {},
      loadVisionModels: async () => {},
      reloadVisionModels: () => {},
      openModelSettings: () => {},
      pickLocalReferences: async () => ({}),
      listLocalReferences: async () => ({}),
      galleryRead: async () => ({}),
    },
  })
}
const root = createRoot(document.getElementById('root'))
function render() { root.render(h(React.Fragment, null, state.mode === 'conversation' && h('div', { className: 'fixture-toolbar' }, h('button', { onClick: () => { state.mode = 'workbench'; render() } }, '切换验收视图')), state.mode === 'conversation' ? h(Conversation) : h(Workbench))) }
window.feedbackFixture = {
  state,
  setMode: mode => { state.mode = mode; render() },
  setAnalysisRunning: value => { state.analysisRunning = value; render() },
  setBatchLoading: value => { state.batchLoading = value; render() },
  setScenario: (scenario, filter = 'selected') => { state.scenario = scenario; state.filter = filter; state.selectedRunId = enrichedPrimaryRun.runId; state.scopeSessionId = 'session-a'; render() },
  session: id => { state.session = id; render() },
  reset: () => store.reset(),
  theme: dark => document.body.toggleAttribute('data-ds-dark-theme', dark),
  dispose: () => { root.unmount(); store.dispose() },
}
render()
