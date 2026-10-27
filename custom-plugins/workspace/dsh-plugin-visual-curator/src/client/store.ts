import { taskPreparationSchema } from '../shared/task-preparation.ts'
import type { ActionArgs, CuratorSnapshot, ImageView, RunView, SafeFailure, Workspace, ReferencePageView, GalleryTaskView, StyleView } from './contract.ts'
import { galleryTaskActive, galleryTaskViewSchema } from '../shared/gallery-task.ts'
import { analysisActive, analysisTaskSchema, analysisDetailSchema, analysisInputSchema, type AnalysisTask, type AnalysisDetail, type AnalysisInput, type AnalysisStreamFrame } from '../shared/analysis-process.ts'
import type { ConfigurationView } from './contract.ts'

interface ReferencePageState { total: number; ids: string[]; counts: ReferencePageView['counts']; nextPageToken?: string; endPageToken: string; tailPageToken?: string; revision?: number; draftRevision?: number; taskVersion?: string; loading: boolean; error: SafeFailure | null }

/** The plugin manager supplies authentication; mutation authorship never comes from action arguments. */
export interface ClientTransport {
  invoke(operation: string, args: ActionArgs, signal?: AbortSignal): Promise<unknown>
  followAnalysis?(args: ActionArgs, receive: (frame: AnalysisStreamFrame) => void, signal: AbortSignal): Promise<void>
}

/** Viewing state survives server refreshes and is independent of durable job execution. */
export interface ClientState {
  analysisTasks: AnalysisTask[]
  analysisDetail: AnalysisDetail | null
  analysisRunId: string
  analysisLoading: boolean
  analysisStreaming: boolean
  analysisError: SafeFailure | null
  analysisInputs: Record<string, AnalysisInput>
  analysisInputLoading: string[]
  analysisInputErrors: Record<string, SafeFailure>
  configSaving: boolean
  configError: SafeFailure | null
  galleryTasks: GalleryTaskView[]
  galleryTaskError: SafeFailure | null
  referencePages: Record<string, ReferencePageState>
  snapshot: CuratorSnapshot | null
  workspace: Workspace
  styleId: string
  runId: string
  candidateId: string
  cropRunId: string
  cropSelection: number
  selectedImageIds: string[]
  previewId: string
  filter: string
  page: number
  loading: boolean
  pending: string[]
  error: SafeFailure | null
  toast: { id: number; success: boolean; code: string } | null
  sessionToken: string
  scopeSessionId: string
  runLoading: boolean
  runError: SafeFailure | null
}

function failure(error: unknown): SafeFailure {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    && 'safeMessage' in error && typeof error.safeMessage === 'string'
    && 'suggestedAction' in error && typeof error.suggestedAction === 'string') {
    return { code: error.code, stage: 'stage' in error && typeof error.stage === 'string' ? error.stage : 'client',
      retryable: 'retryable' in error && error.retryable === true, safeMessage: error.safeMessage, suggestedAction: error.suggestedAction }
  }
  return { code: 'operation-failed', stage: 'client', retryable: false, safeMessage: '', suggestedAction: '' }
}

function snapshotValue(value: unknown): CuratorSnapshot {
  if (typeof value !== 'object' || value === null || !('styles' in value) || !Array.isArray(value.styles)
    || !('images' in value) || !Array.isArray(value.images) || !('runs' in value) || !Array.isArray(value.runs)
    || !('configuration' in value) || typeof value.configuration !== 'object' || value.configuration === null) {
    throw new Error('invalid-snapshot')
  }
  // The Host validates and projects every record before serializing this private response.
  return value as CuratorSnapshot
}

/** Create the shared workbench store, with stale-response suppression and retained selections.
 * @param transport Authenticated Host action transport.
 * @returns Observable state and commands; dispose only stops Client refresh work.
 */
export function createCuratorStore(transport: ClientTransport) {
  const inputInitial = { analysisInputs: {}, analysisInputLoading: [], analysisInputErrors: {} }
  const analysisInitial = { ...inputInitial, analysisTasks: [], analysisDetail: null, analysisRunId: '', analysisLoading: false, analysisStreaming: false, analysisError: null, configSaving: false, configError: null }
  let state: ClientState = { ...analysisInitial, galleryTasks: [], galleryTaskError: null, referencePages: {}, snapshot: null, workspace: 'styles', styleId: '', runId: '', candidateId: '', cropRunId: '', cropSelection: 0, selectedImageIds: [],
    previewId: '', filter: 'all', page: 0, loading: false, pending: [], error: null, toast: null, sessionToken: '', scopeSessionId: '', runLoading: false, runError: null }
  const listeners = new Set<() => void>()
  let disposed = false, readSequence = 0, toastId = 0
  let refreshing: Promise<void> | undefined
  let scopeSequence = 0
  const runReads = new Map<string, Promise<void>>()
  const runFilters = new Map<string, 'all' | 'selected' | 'review'>()
  const runVersions = new Map<string, number>()
  const runFirstCursors = new Map<string, string | undefined>()
  let imagesFirstCursor: string | undefined
  const referenceReads = new Map<string, Promise<void>>()
  let taskRead: Promise<void> | undefined, taskReadVersion = 0
  let taskWorkspaceRevision: string | undefined
  let detailRead: Promise<void> | undefined, detailController: AbortController | undefined
  let streamController: AbortController | undefined, streamVersion = 0, followUnavailable = false
  const stopFollow = () => { streamController?.abort(); streamController = undefined; followUnavailable = false; ++streamVersion; if (state.analysisStreaming) publish({ analysisStreaming: false }) }
  const inputReads = new Map<string, { work: Promise<void>; controller: AbortController }>()
  const abortInputs = () => { for (const read of inputReads.values()) read.controller.abort(); inputReads.clear() }
  const clearCrop = () => ({ candidateId: '', cropRunId: '', cropSelection: state.cropSelection + 1 })
  const mergeImages = (fresh: ImageView[], previous: ImageView[]) => [...new Map([...previous, ...fresh].map(image => [image.referenceId ?? image.imageVersionId, image])).values()]

  function publish(update: Partial<ClientState>): void {
    if (disposed) return
    state = { ...state, ...update }
    for (const listener of listeners) listener()
  }
  const invoke = async (operation: string, args: ActionArgs, signal?: AbortSignal): Promise<unknown> => {
    const token = state.sessionToken, scope = scopeSequence
    try { return await transport.invoke(operation, token && operation !== 'session-open' ? { ...args, sessionToken: token } : args, signal) }
    catch (error) {
      if (token && token === state.sessionToken && scope === scopeSequence && failure(error).code === 'owner-denied') {
        // 授权失效先撤下私有画面，再显示错误；旧请求不能重新发布这些资源。
        ++scopeSequence; ++readSequence; runReads.clear(); runFirstCursors.clear(); runFilters.clear(); runVersions.clear(); referenceReads.clear()
        stopFollow(); detailController?.abort(); abortInputs(); refreshing = undefined; taskRead = undefined
        publish({ ...analysisInitial, ...clearCrop(), sessionToken: '', scopeSessionId: '', snapshot: null, runId: '', previewId: '', selectedImageIds: [], galleryTasks: [], referencePages: {}, error: failure(error) })
      }
      throw error
    }
  }

  async function refreshAnalysisDetail(): Promise<void> {
    if (!state.analysisRunId || detailRead) return detailRead
    const runId = state.analysisRunId, scope = scopeSequence, controller = new AbortController(), version = streamVersion
    detailController = controller
    const work = invoke('analysis-detail', { runId }, controller.signal).then(value => {
      const detail = analysisDetailSchema.parse(value)
      if (!disposed && scope === scopeSequence && state.analysisRunId === runId && !controller.signal.aborted) {
        const current = state.analysisDetail
        const retainLive = version !== streamVersion && current?.process && (!detail.process || current.process.updatedAt >= detail.process.updatedAt)
        publish({ analysisDetail: retainLive ? { ...detail, process: current.process, task: { ...detail.task, status: current.task.status, phase: current.task.phase } } : detail, analysisLoading: false, analysisError: null })
        startFollow()
      }
    }).catch(error => { if (!disposed && scope === scopeSequence && state.analysisRunId === runId && !controller.signal.aborted) publish({ analysisLoading: false, analysisError: failure(error) }) })
      .finally(() => { if (detailRead === work) detailRead = undefined })
    detailRead = work
    return work
  }

  function startFollow(): void {
    if (!transport.followAnalysis || streamController || followUnavailable || !state.analysisRunId || !state.analysisDetail || !analysisActive(state.analysisDetail.task.status)) return
    const controller = new AbortController(), runId = state.analysisRunId, scope = scopeSequence
    streamController = controller
    let settleRead: Promise<void> | undefined, readAgain = false
    const refreshSavedOutput = () => {
      readAgain = true
      if (settleRead) return
      settleRead = (async () => {
        do { readAgain = false; await detailRead; if (disposed || controller.signal.aborted || state.analysisRunId !== runId) return; await refreshAnalysisDetail() } while (readAgain)
      })().finally(() => { settleRead = undefined })
    }
    void transport.followAnalysis({ runId, ...(state.sessionToken ? { sessionToken: state.sessionToken } : {}) }, frame => {
      if (disposed || controller.signal.aborted || scope !== scopeSequence || state.analysisRunId !== runId || frame.runId !== runId || !state.analysisDetail) return
      ++streamVersion
      publish({ analysisStreaming: true, analysisDetail: { ...state.analysisDetail, ...(frame.process ? { process: frame.process } : {}), task: { ...state.analysisDetail.task, status: frame.status, phase: frame.process?.phase ?? state.analysisDetail.task.phase } } })
      if (frame.checkpoint) refreshSavedOutput()
    }, controller.signal).catch(error => {
      // 推送连接失败后继续使用已有的只读详情轮询，不重发模型请求。
      if (!disposed && !controller.signal.aborted && scope === scopeSequence) { followUnavailable = true; publish({ analysisStreaming: false }) }
    }).finally(() => {
      if (streamController === controller) { streamController = undefined; if (!disposed && scope === scopeSequence) publish({ analysisStreaming: false }) }
    })
  }

  function loadAnalysisInput(requestId: string): Promise<void> {
    if (!state.analysisRunId || state.analysisInputs[requestId]) return Promise.resolve()
    const existing = inputReads.get(requestId)
    if (existing) return existing.work
    const runId = state.analysisRunId, scope = scopeSequence, controller = new AbortController()
    const { [requestId]: previousError, ...errors } = state.analysisInputErrors
    publish({ analysisInputLoading: [...state.analysisInputLoading, requestId], analysisInputErrors: errors })
    const current = () => !disposed && scope === scopeSequence && state.analysisRunId === runId && !controller.signal.aborted
    const work = invoke('analysis-input', { runId, requestId }, controller.signal).then(value => {
      const input = analysisInputSchema.parse(value)
      if (input.requestId !== requestId) throw new Error('invalid-analysis-input')
      if (current()) publish({ analysisInputs: { ...state.analysisInputs, [requestId]: input } })
    }).catch(error => { if (current()) publish({ analysisInputErrors: { ...state.analysisInputErrors, [requestId]: failure(error) } }) })
      .finally(() => { if (inputReads.get(requestId)?.work === work) inputReads.delete(requestId); if (current()) publish({ analysisInputLoading: state.analysisInputLoading.filter(id => id !== requestId) }) })
    inputReads.set(requestId, { work, controller })
    return work
  }

  function referenceTaskVersion(styleId: string): string {
    const task = state.galleryTasks.find(item => item.styleId === styleId)
    return task ? `${task.id}:${task.completed + task.registered}:${task.failed}` : ''
  }
  function referencesCurrent(styleId: string): boolean {
    const page = state.referencePages[styleId], style = state.snapshot?.styles.find(item => item.styleId === styleId)
    return !!page && !!style && !page.error && page.revision === style.revision && page.draftRevision === style.draftRevision && page.taskVersion === referenceTaskVersion(styleId)
  }
  async function readReferences(styleId: string, append = false, changes = false): Promise<void> {
    if (!state.snapshot?.collectionPaging || referenceReads.has(styleId)) return referenceReads.get(styleId)
    const prior = state.referencePages[styleId], scope = scopeSequence, taskVersion = referenceTaskVersion(styleId)
    changes = changes && !!prior?.tailPageToken && !prior.error
    const pageToken = changes ? prior!.tailPageToken : append ? prior?.nextPageToken : undefined
    if (append && !pageToken) return
    publish({ referencePages: { ...state.referencePages, [styleId]: { total: prior?.total ?? 0, ids: prior?.ids ?? [], counts: prior?.counts ?? { all: 0, positive: 0, negative: 0, undecided: 0 }, endPageToken: prior?.endPageToken ?? '', ...prior, loading: true, error: null } } })
    const work = invoke('references-list', { styleId, ...(pageToken ? { pageToken } : {}) }).then(value => {
      if (!value || typeof value !== 'object' || !('styleId' in value) || value.styleId !== styleId || !('images' in value) || !Array.isArray(value.images) || !('referenceIds' in value) || !Array.isArray(value.referenceIds) || !('endPageToken' in value) || typeof value.endPageToken !== 'string') throw new Error('invalid-reference-page')
      if (disposed || scope !== scopeSequence || !state.snapshot) return
      const page = value as ReferencePageView
      const style = state.snapshot.styles.find(style => style.styleId === styleId)
      if (!style) return
      if (page.revision < style.revision) return
      const unchangedPrefix = (prior?.ids ?? style.referenceIds).every((id, index) => page.referenceIds[index] === id)
      const preserve = !append && prior && unchangedPrefix
      const nextPageToken = changes ? prior!.nextPageToken ?? page.nextPageToken : preserve ? prior.nextPageToken ?? (page.total > prior.total ? prior.endPageToken : undefined) : page.nextPageToken
      let endPageToken = page.endPageToken
      if (changes && prior!.nextPageToken || !changes && preserve) endPageToken = prior!.endPageToken
      const keep = state.snapshot.images.filter(image => image.styleId !== styleId || (append || preserve || changes) && !!image.referenceId && page.referenceIds.includes(image.referenceId))
      const changed = style.referenceIds.length !== page.referenceIds.length || !unchangedPrefix
      const updated = { ...style, revision: page.revision, draftRevision: page.draftRevision, referenceIds: page.referenceIds,
        ...(changed && style.modelProfile ? { modelProfile: { ...style.modelProfile, stale: true } } : {}), ...(changed && style.analysis ? { analysis: { ...style.analysis, stale: true } } : {}) }
      publish({ snapshot: { ...state.snapshot, images: mergeImages(page.images, keep), styles: state.snapshot.styles.map(item => item.styleId === styleId ? updated : item) }, referencePages: { ...state.referencePages, [styleId]: {
        total: page.total, ids: page.referenceIds, counts: page.counts, ...(nextPageToken ? { nextPageToken } : {}), endPageToken,
        ...(page.tailPageToken ? { tailPageToken: page.tailPageToken } : {}), revision: page.revision, draftRevision: page.draftRevision, taskVersion, loading: false, error: null,
      } } })
    }).catch(async error => {
      // 集合前缀被其他写入修改时，丢弃失效尾游标并只重读一次首屏。
      if (!disposed && scope === scopeSequence && changes && failure(error).code === 'invalid-input') {
        referenceReads.delete(styleId)
        return readReferences(styleId)
      }
      if (!disposed && scope === scopeSequence && state.referencePages[styleId]) publish({ referencePages: { ...state.referencePages, [styleId]: { ...state.referencePages[styleId]!, loading: false, error: failure(error) } } })
    }).finally(() => {
      if (referenceReads.get(styleId) === work) {
        referenceReads.delete(styleId)
        if (!disposed && scope === scopeSequence && state.referencePages[styleId]?.loading) publish({ referencePages: { ...state.referencePages, [styleId]: { ...state.referencePages[styleId]!, loading: false } } })
      }
    })
    referenceReads.set(styleId, work)
    return work
  }
  function loadReferences(styleId: string, append = false): Promise<void> { return readReferences(styleId, append) }

  async function refreshGalleryTasks(): Promise<void> {
    if (!state.snapshot?.collectionPaging || taskRead) return taskRead
    const scope = scopeSequence, version = taskReadVersion
    const work = invoke('gallery-reference-tasks', {}).then(async value => {
      if (!value || typeof value !== 'object' || !('tasks' in value)) throw new Error('invalid-gallery-tasks')
      const tasks = galleryTaskViewSchema.array().parse(value.tasks)
      const analyses = 'analyses' in value ? analysisTaskSchema.array().parse(value.analyses) : []
      if (disposed || scope !== scopeSequence || version !== taskReadVersion) return
      const old = state.galleryTasks
      const workspaceRevision = 'workspaceRevision' in value && typeof value.workspaceRevision === 'string' ? value.workspaceRevision : undefined
      if (workspaceRevision && workspaceRevision === taskWorkspaceRevision && !state.galleryTaskError && JSON.stringify(tasks) === JSON.stringify(old) && JSON.stringify(analyses) === JSON.stringify(state.analysisTasks)) return
      taskWorkspaceRevision = workspaceRevision
      const finished = analyses.some(task => !analysisActive(task.status) && state.analysisTasks.some(before => before.runId === task.runId && analysisActive(before.status)))
      const snapshot = state.snapshot
      publish({ galleryTasks: tasks, galleryTaskError: null, analysisTasks: analyses, ...(snapshot ? { snapshot: { ...snapshot,
        styles: snapshot.styles.map(style => {
          const task = analyses.find(item => item.styleId === style.styleId)
          if (!task) return style
          const previous = style.analysis?.runId === task.runId ? style.analysis : undefined
          return { ...style, analysis: { stale: false, samples: [], ...previous, runId: task.runId, status: task.status, stage: task.phase, observed: task.observed, total: task.total, model: task.model, ...(task.outcome ? { outcome: task.outcome } : {}), ...(task.error ? { error: task.error } : {}) } }
        }), runs: [...analyses.map(task => {
          const previous = snapshot.runs.find(run => run.runId === task.runId)
          return { taskBrief: '', results: [], warnings: [], ...previous, runId: task.runId, styleId: task.styleId, kind: 'analyze' as const, status: task.status, counts: { ...previous?.counts, observed: task.observed }, ...(task.error ? { error: task.error } : {}) }
        }), ...snapshot.runs.filter(run => !analyses.some(task => task.runId === run.runId))],
      } } : {}) })
      const current = tasks.find(task => task.styleId === state.styleId), before = old.find(task => task.id === current?.id)
      if (current && (!before || current.completed !== before.completed || current.registered !== before.registered || current.status !== before.status) && !referencesCurrent(current.styleId)) {
        await referenceReads.get(current.styleId)
        if (disposed || scope !== scopeSequence) return
        await readReferences(current.styleId, false, !!before && current.completed + current.registered > before.completed + before.registered)
      }
      const changed = state.snapshot && 'workspaceRevision' in value && value.workspaceRevision !== state.snapshot.workspaceRevision
      if (finished || changed && !tasks.some(task => galleryTaskActive(task.status)) && !analyses.some(task => analysisActive(task.status))) void reload(!state.runId, true)
      else if (changed) {
        // 分析或引用期间不重建完整快照，当前搜图和独立裁图仍需读取新检查点。
        for (const runId of new Set([state.runId, state.cropRunId])) {
          if (disposed || scope !== scopeSequence) return
          const run = state.snapshot?.runs.find(run => run.runId === runId)
          if (run && run.kind !== 'analyze' && analysisActive(run.status)) await loadRun(runId)
        }
      }
    }).catch(error => { if (!disposed && scope === scopeSequence) publish({ galleryTaskError: failure(error) }) })
      .finally(() => { if (taskRead === work) taskRead = undefined })
    taskRead = work
    return work
  }
  async function loadRun(runId: string, append = false, resultFilter = runFilters.get(runId) ?? 'all'): Promise<void> {
    if (runFilters.get(runId) !== resultFilter) { runFilters.set(runId, resultFilter); runVersions.set(runId, (runVersions.get(runId) ?? 0) + 1); runReads.delete(runId); runFirstCursors.delete(runId); append = false }
    const version = runVersions.get(runId)
    if (runReads.has(runId)) return runReads.get(runId)
    const scope = scopeSequence
    const prior = state.snapshot?.runs.find(run => run.runId === runId)
    if (!prior || append && !prior.pageToken) return
    publish({ runLoading: true, runError: null })
    const request = invoke('run-get', { runId, resultFilter, ...(append && prior.pageToken ? { pageToken: prior.pageToken } : {}) }).then(value => {
      if (typeof value !== 'object' || value === null || !('runId' in value) || value.runId !== runId || !('results' in value) || !Array.isArray(value.results)) throw new Error('invalid-run')
      if (disposed || scope !== scopeSequence || version !== runVersions.get(runId) || !state.snapshot) return
      const run = value as RunView
      const previous = state.snapshot.runs.find(item => item.runId === runId)
      const sameFirstCursor = previous?.resultFilter === resultFilter && run.pageToken === runFirstCursors.get(runId)
      const retainCursor = !append && previous && previous.results.length > run.results.length && sameFirstCursor
        && run.results.every(image => previous.results.some(old => old.imageVersionId === image.imageVersionId))
      const { pageToken, ...fields } = run
      const nextCursor = retainCursor ? previous.pageToken : pageToken
      if (!append) runFirstCursors.set(runId, pageToken)
      // 首游标更新使旧尾页失效；未变化时保留尾页，并以服务端顺序和字段刷新首屏。
      const freshIds = new Set(run.results.map(image => image.imageVersionId))
      const results = append ? mergeImages(run.results, previous?.results ?? []) : [...run.results, ...(sameFirstCursor ? previous?.results.filter(image => !freshIds.has(image.imageVersionId)) ?? [] : [])]
      const updated: RunView = { ...fields, resultFilter, results, ...(nextCursor ? { pageToken: nextCursor } : {}) }
      publish({ snapshot: { ...state.snapshot, runs: state.snapshot.runs.map(item => item.runId === runId ? updated : item) }, runLoading: false, runError: null })
    }).catch(error => { if (!disposed && scope === scopeSequence && version === runVersions.get(runId)) publish({ runLoading: false, runError: failure(error) }) })
      .finally(() => { if (runReads.get(runId) === request) runReads.delete(runId) })
    runReads.set(runId, request)
    return request
  }
  async function reload(skipSelectedRuns = false, reuseReferences = false): Promise<void> {
    if (refreshing) return refreshing
    const sequence = ++readSequence
    if (!state.snapshot) publish({ loading: true })
    const request = invoke('snapshot', {}).then(async value => {
      const snapshot = snapshotValue(value)
      if (disposed || sequence !== readSequence) return
      const previous = state.snapshot
      const retainCursor = previous && previous.images.length > snapshot.images.length && snapshot.nextPageToken === imagesFirstCursor
        && snapshot.images.every(image => previous.images.some(old => old.imageVersionId === image.imageVersionId))
      const { nextPageToken, ...fields } = snapshot
      const nextCursor = retainCursor ? previous.nextPageToken : nextPageToken
      imagesFirstCursor = nextPageToken
      const merged: CuratorSnapshot = { ...fields, images: mergeImages(snapshot.images, previous?.images ?? []),
        runs: snapshot.runs.map(run => { const old = previous?.runs.find(item => item.runId === run.runId); return old ? { ...run, ...(old.resultFilter ? { resultFilter: old.resultFilter } : {}), results: old.results, ...(old.pageToken ? { pageToken: old.pageToken } : {}) } : run }),
        ...(nextCursor ? { nextPageToken: nextCursor } : {}) }
      publish({ snapshot: merged, loading: false, error: null,
        styleId: snapshot.styles.some(style => style.styleId === state.styleId && !style.archived) ? state.styleId : snapshot.styles.find(style => !style.archived)?.styleId ?? '',
        runId: skipSelectedRuns ? state.runId : state.runId || snapshot.runs[0]?.runId || '' })
      if (snapshot.collectionPaging && state.styleId && (!reuseReferences || !referencesCurrent(state.styleId))) { await referenceReads.get(state.styleId); await loadReferences(state.styleId) }
      if (!skipSelectedRuns && state.runId) await loadRun(state.runId)
      // 独立裁图任务继续刷新，但不切走左侧的来源任务和候选列表。
      if (!skipSelectedRuns && state.cropRunId && state.cropRunId !== state.runId) await loadRun(state.cropRunId)
    }).catch(error => {
      if (!disposed && sequence === readSequence) publish({ loading: false, error: failure(error) })
    }).finally(() => { if (refreshing === request) refreshing = undefined })
    refreshing = request
    return request
  }
  async function execute(operation: string, args: ActionArgs, key = operation): Promise<unknown> {
    const controlledRun = operation === 'run-control' && typeof args.runId === 'string' ? args.runId : undefined
    const deletedRun = operation === 'run-delete' && typeof args.runId === 'string' ? args.runId : undefined
    if (deletedRun) key = `${key}:${deletedRun}`
    if (controlledRun) key = `${key}:${controlledRun}:${String(args.command)}`
    if (state.pending.includes(key)) return undefined
    const scope = scopeSequence, version = controlledRun ? (runVersions.get(controlledRun) ?? 0) + 1 : 0
    if (controlledRun) { runVersions.set(controlledRun, version); runReads.delete(controlledRun) }
    publish({ pending: [...state.pending, key] })
    try {
      const result = await invoke(operation, args)
      if (operation === 'style-create') {
        if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string') throw new Error('invalid-style-create-response')
        if (disposed || scope !== scopeSequence) return result
        // 创建回执确认后只读取当前集合，不等待全工作台的图片与历史输出投影。
        ++taskReadVersion; taskRead = undefined
        if (state.snapshot) {
          const value = await invoke('style-get', { styleId: result.id })
          if (!value || typeof value !== 'object' || !('styleId' in value) || value.styleId !== result.id || !('draftId' in value) || typeof value.draftId !== 'string' || !('referenceIds' in value) || !Array.isArray(value.referenceIds)) throw new Error('invalid-style-read-response')
          if (disposed || scope !== scopeSequence || !state.snapshot) return result
          ++readSequence; refreshing = undefined
          const style = value as StyleView
          publish({ ...clearCrop(), snapshot: { ...state.snapshot, styles: [...state.snapshot.styles.filter(item => item.styleId !== style.styleId), style] }, styleId: style.styleId, workspace: 'styles', runId: '', selectedImageIds: [], previewId: '', page: 0, toast: { id: ++toastId, success: true, code: 'saved' } })
          if (state.snapshot?.collectionPaging) await loadReferences(style.styleId)
          return result
        }
        publish({ ...clearCrop(), styleId: result.id, runId: '', selectedImageIds: [], previewId: '', page: 0 })
      }
      if (deletedRun) {
        if (!result || typeof result !== 'object' || !('runId' in result) || result.runId !== deletedRun || !('deleted' in result) || result.deleted !== true) throw new Error('invalid-run-delete-response')
        if (disposed || scope !== scopeSequence || !state.snapshot) return result
        // 旧列表和详情不能把已删除记录重新加入页面；这里只删记录，不重新加载图片。
        ++readSequence; refreshing = undefined; ++taskReadVersion; taskRead = undefined
        runVersions.set(deletedRun, (runVersions.get(deletedRun) ?? 0) + 1); runReads.delete(deletedRun)
        runFirstCursors.delete(deletedRun); runFilters.delete(deletedRun)
        const runs = state.snapshot.runs.filter(run => run.runId !== deletedRun)
        publish({ snapshot: { ...state.snapshot, runs }, runId: state.runId === deletedRun ? runs[0]?.runId ?? '' : state.runId,
          cropRunId: state.cropRunId === deletedRun ? '' : state.cropRunId,
          runLoading: state.runId === deletedRun ? false : state.runLoading, runError: state.runId === deletedRun ? null : state.runError,
          analysisTasks: state.analysisTasks.filter(task => task.runId !== deletedRun),
          toast: { id: ++toastId, success: true, code: 'saved' } })
        return result
      }
      if (controlledRun) {
        if (!result || typeof result !== 'object' || !('runId' in result) || result.runId !== controlledRun || !('results' in result) || !Array.isArray(result.results)) throw new Error('invalid-run-control-response')
        if (disposed || scope !== scopeSequence || version !== runVersions.get(controlledRun) || !state.snapshot) return result
        const run = result as RunView, previous = state.snapshot.runs.find(item => item.runId === controlledRun)
        const updated = { ...run, ...(previous ? { results: previous.results, ...(previous.resultFilter ? { resultFilter: previous.resultFilter } : {}), ...(previous.pageToken ? { pageToken: previous.pageToken } : {}) } : {}) }
        // 控制回执比此前发出的轮询新；保留已加载图片和结果，且旧暂停不能覆盖后发取消。
        ++taskReadVersion; taskRead = undefined
        publish({ snapshot: { ...state.snapshot,
          runs: previous ? state.snapshot.runs.map(item => item.runId === controlledRun ? updated : item) : [updated, ...state.snapshot.runs],
          styles: state.snapshot.styles.map(style => style.analysis?.runId === controlledRun ? { ...style, analysis: { ...style.analysis, status: run.status } } : style),
        }, analysisDetail: state.analysisDetail?.task.runId === controlledRun ? { ...state.analysisDetail, task: { ...state.analysisDetail.task, status: run.status } } : state.analysisDetail, runLoading: state.runId === controlledRun ? false : state.runLoading, analysisTasks: state.analysisTasks.map(task => task.runId === controlledRun ? { ...task, status: run.status } : task), toast: { id: ++toastId, success: true, code: 'saved' } })
        startFollow()
        return result
      }
      // 提交前启动的轮询不能代替提交后的刷新，否则下一批仍会携带旧修订号。
      ++readSequence; refreshing = undefined
      publish({ toast: { id: ++toastId, success: true, code: 'saved' } })
      await reload(operation === 'style-create')
      return result
    } catch (error) {
      const safe = failure(error)
      publish({ toast: { id: ++toastId, success: false, code: safe.code } })
      throw safe
    } finally { publish({ pending: state.pending.filter(value => value !== key) }) }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    reload, execute,
    async ensureLoaded(): Promise<void> { if (!state.snapshot || state.error) await reload() },
    prepareTask: async (args: ActionArgs) => taskPreparationSchema.parse(await invoke('task-prepare', args)),
    loadReferences, refreshGalleryTasks, refreshAnalysisDetail,
    async saveConfiguration(args: ActionArgs, beforeSave?: () => Promise<void>): Promise<void> {
      if (state.configSaving) return
      const scope = scopeSequence
      publish({ configSaving: true, configError: null })
      try {
        await beforeSave?.()
        const result = await invoke('config-save', args)
        if (!result || typeof result !== 'object' || !('configuration' in result) || !result.configuration || typeof result.configuration !== 'object' || !('revision' in result.configuration)) throw new Error('invalid-configuration-response')
        if (disposed || scope !== scopeSequence || !state.snapshot) return
        ++readSequence; refreshing = undefined
        publish({ snapshot: { ...state.snapshot, configuration: result.configuration as ConfigurationView }, toast: { id: ++toastId, success: true, code: 'saved' } })
      } catch (error) { if (!disposed && scope === scopeSequence) publish({ configError: failure(error) }); throw failure(error) }
      finally { if (scope === scopeSequence) publish({ configSaving: false }) }
    },
    async startAnalysis(args: ActionArgs): Promise<unknown> {
      const key = `analysis:${String(args.styleId)}`
      if (state.pending.includes(key)) return
      publish({ pending: [...state.pending, key], error: null })
      try {
        const result = await invoke('reference-analyze', args)
        // 启动前的旧轮询不能阻塞已接受的任务，也不能覆盖本次新状态。
        ++taskReadVersion; taskRead = undefined
        await refreshGalleryTasks()
        return result
      }
      catch (error) { publish({ error: failure(error) }); throw failure(error) }
      finally { publish({ pending: state.pending.filter(item => item !== key) }) }
    },
    async stopAnalysis(runId: string): Promise<void> {
      const key = `stop:${runId}`
      if (state.pending.includes(key)) return
      publish({ pending: [...state.pending, key], analysisError: null })
      try { await invoke('analysis-stop', { runId }); await refreshGalleryTasks(); await refreshAnalysisDetail() }
      catch (error) { publish({ analysisError: failure(error), error: failure(error) }) }
      finally { publish({ pending: state.pending.filter(item => item !== key) }) }
    },
    openAnalysis(runId: string) {
      stopFollow(); detailController?.abort(); detailRead = undefined; abortInputs()
      publish({ ...inputInitial, analysisRunId: runId, analysisDetail: null, analysisLoading: true, analysisStreaming: false, analysisError: null })
      void refreshAnalysisDetail()
    },
    closeAnalysis() { stopFollow(); detailController?.abort(); detailRead = undefined; abortInputs(); publish({ ...inputInitial, analysisRunId: '', analysisDetail: null, analysisLoading: false, analysisStreaming: false, analysisError: null }) },
    loadAnalysisInput,
    async startGalleryReferences(args: ActionArgs): Promise<GalleryTaskView> {
      const scope = scopeSequence
      const task = galleryTaskViewSchema.parse(await invoke('gallery-reference-start', args))
      if (!disposed && scope === scopeSequence) {
        ++taskReadVersion; taskRead = undefined
        publish({ galleryTasks: [task, ...state.galleryTasks.filter(item => item.id !== task.id)], galleryTaskError: null })
        void refreshGalleryTasks()
      }
      return task
    },
    async stopGalleryReferences(taskId: string): Promise<void> {
      const scope = scopeSequence
      const task = galleryTaskViewSchema.parse(await invoke('gallery-reference-stop', { taskId }))
      if (!disposed && scope === scopeSequence) {
        ++taskReadVersion; taskRead = undefined
        publish({ galleryTasks: state.galleryTasks.map(item => item.id === task.id ? task : item) })
        void refreshGalleryTasks()
      }
    },
    invoke,
    loadRun,
    selectCandidate(candidateId: string) { publish({ ...clearCrop(), candidateId }) },
    async followCrop(runId: string, selection: number) {
      // 选图、筛选或授权范围已改变时，迟到的生成响应只保留在任务历史中。
      if (disposed || selection !== state.cropSelection) return
      publish({ cropRunId: runId })
      await loadRun(runId)
    },
    async loadMoreImages() {
      if (state.snapshot?.collectionPaging) return loadReferences(state.styleId, true)
      const token = state.snapshot?.nextPageToken
      if (!token || state.pending.includes('images-page')) return
      const scope = scopeSequence
      publish({ pending: [...state.pending, 'images-page'] })
      try {
        const next = snapshotValue(await invoke('snapshot', { pageToken: token }))
        if (disposed || scope !== scopeSequence || !state.snapshot) return
        const { nextPageToken, ...fields } = state.snapshot
        publish({ snapshot: { ...fields, images: mergeImages(next.images, state.snapshot.images), ...(next.nextPageToken ? { nextPageToken: next.nextPageToken } : {}) } })
      } catch (error) { if (scope === scopeSequence) publish({ error: failure(error) }) }
      finally { publish({ pending: state.pending.filter(item => item !== 'images-page') }) }
    },
    async openSession(sessionId: string) {
      const opening = ++scopeSequence
      ++readSequence; refreshing = undefined; runReads.clear(); runFirstCursors.clear(); referenceReads.clear(); taskRead = undefined
      stopFollow(); detailController?.abort(); abortInputs()
      publish({ ...analysisInitial, ...clearCrop(), snapshot: null, sessionToken: '', scopeSessionId: '', runId: '', previewId: '', selectedImageIds: [], galleryTasks: [], referencePages: {} })
      const value = await transport.invoke('session-open', { sessionId })
      if (disposed || opening !== scopeSequence) return
      if (typeof value !== 'object' || value === null || !('sessionToken' in value) || typeof value.sessionToken !== 'string') throw failure(value)
      ++readSequence; ++scopeSequence; refreshing = undefined; runReads.clear(); runFirstCursors.clear(); imagesFirstCursor = undefined
      referenceReads.clear(); taskRead = undefined
      stopFollow(); detailController?.abort(); detailRead = undefined; abortInputs()
      publish({ ...analysisInitial, ...clearCrop(), galleryTasks: [], galleryTaskError: null, referencePages: {}, sessionToken: value.sessionToken, scopeSessionId: sessionId, snapshot: null, runId: '', selectedImageIds: [], previewId: '', page: 0, runLoading: false, runError: null })
      await reload()
    },
    closeSession() {
      ++readSequence; ++scopeSequence; refreshing = undefined; runReads.clear(); runFirstCursors.clear(); imagesFirstCursor = undefined
      referenceReads.clear(); taskRead = undefined
      stopFollow(); detailController?.abort(); detailRead = undefined; abortInputs()
      publish({ ...analysisInitial, ...clearCrop(), galleryTasks: [], galleryTaskError: null, referencePages: {}, sessionToken: '', scopeSessionId: '', snapshot: null, runId: '', selectedImageIds: [], previewId: '', page: 0, runLoading: false, runError: null })
      void reload()
    },
    selectWorkspace(workspace: Workspace) { publish({ ...clearCrop(), workspace, page: 0, filter: 'all' }) },
    selectStyle(styleId: string) { publish({ styleId, page: 0 }); if (state.snapshot?.collectionPaging && !referencesCurrent(styleId)) void readReferences(styleId, false, !!state.referencePages[styleId] && state.referencePages[styleId]!.taskVersion !== referenceTaskVersion(styleId)) },
    selectRun(runId: string) { const run = state.snapshot?.runs.find(item => item.runId === runId); publish({ ...clearCrop(), runId, ...(run?.styleId ? { styleId: run.styleId } : {}), page: 0 }); void loadRun(runId, false, run?.kind === 'search' || run?.kind === 'crop' ? 'selected' : 'all') },
    setFilter(filter: string) { publish({ ...clearCrop(), filter, page: 0 }) },
    setPage(page: number) { publish({ ...clearCrop(), page: Math.max(0, page) }) },
    preview(previewId: string) { publish({ previewId }) },
    select(imageVersionId: string) {
      publish({ selectedImageIds: state.selectedImageIds.includes(imageVersionId)
        ? state.selectedImageIds.filter(id => id !== imageVersionId) : [...state.selectedImageIds, imageVersionId] })
    },
    clearSelection() { publish({ selectedImageIds: [] }) },
    dismissToast() { publish({ toast: null }) },
    reset() {
      taskWorkspaceRevision = undefined
      ++readSequence; ++scopeSequence; refreshing = undefined; runReads.clear(); runFirstCursors.clear(); imagesFirstCursor = undefined
      referenceReads.clear(); taskRead = undefined
      stopFollow(); detailController?.abort(); detailRead = undefined; abortInputs()
      publish({ ...analysisInitial, ...clearCrop(), galleryTasks: [], galleryTaskError: null, referencePages: {}, snapshot: null, loading: false, error: null, runLoading: false, runError: null,
        ...(state.sessionToken ? { sessionToken: '', scopeSessionId: '', runId: '', selectedImageIds: [], previewId: '' } : {}) })
      void reload()
    },
    dispose() { stopFollow(); detailController?.abort(); abortInputs(); disposed = true; ++readSequence; ++scopeSequence; listeners.clear() },
  }
}

/** A resource path is usable only inside this plugin's authenticated Host route.
 * @param path Host-projected preview or export path.
 * @returns Safe same-origin path, or an empty string for any other destination.
 */
export function safeResourcePath(path: string): string {
  if (!/^\/?api\/visual-curator\/resource\?/.test(path) || /[\\\u0000-\u001f]/.test(path)) return ''
  return path.startsWith('/') ? path : `/${path}`
}

/** Encode one already-selected local file without persisting a mutable filesystem path.
 * @param bytes File bytes obtained from the browser file picker.
 * @returns Base64 payload for Host decoding and media validation.
 */
export function encodeUpload(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}

export type CuratorStore = ReturnType<typeof createCuratorStore>
