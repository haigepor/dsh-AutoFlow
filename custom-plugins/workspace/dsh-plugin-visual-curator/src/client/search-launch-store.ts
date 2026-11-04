/** Scoped observation of Host-owned launches; closing a dialog never cancels admission. */
import { z } from 'zod'
import { searchConversationModelSchema, searchLaunchInputSchema, searchLaunchViewSchema, type SearchLaunchView } from '../shared/search-launch.ts'
import type { DatasetEntry } from '../shared/datasets.ts'
import { searchLaunchDatasetsSchema } from '../shared/search-reference-datasets.ts'
import type { ClientTransport } from './store.ts'

export type SearchLaunchDraft = z.input<typeof searchLaunchInputSchema>
const optionsSchema = z.object({ workspaces: z.array(z.object({ id: z.string(), title: z.string(), path: z.string() })), datasetSelection: z.literal('required').optional(), automaticDatasetPreparation: z.literal(true).optional(), negativeReferenceDatasets: z.literal(true).optional(), previewSearch: z.boolean().optional(), conversationModelSelection: z.literal(true).optional(), conversationModels: z.array(searchConversationModelSchema.extend({ label: z.string() })).default([]), defaultConversationModel: searchConversationModelSchema.optional(), usages: z.array(z.object({ usageRevisionId: z.string(), name: z.string(), targetWidth: z.number().positive(), targetHeight: z.number().positive() })).default([]), usagePageToken: z.string().optional(), defaultTargetCount: z.number().int().positive(), maxTargetCount: z.number().int().positive() })
/** Owner-private launch state; unknown acknowledgements preserve the original input and identity. */
export interface SearchLaunchState {
  entries: SearchLaunchView[]; options: z.infer<typeof optionsSchema> | null; optionsLoading: boolean; loading: boolean; error: string
  failure?: NonNullable<SearchLaunchView['error']> | undefined
  submission: { input: SearchLaunchDraft; status: 'submitting' | 'unknown' | 'rejected'; error?: string; failure?: NonNullable<SearchLaunchView['error']> | undefined } | null
  /** Absent until the launch form requests this profile's eligible, owner-authorized packages. */
  datasetOptions?: { modelProfileId: string; entries: DatasetEntry[]; total: number; loading: boolean; error: string; negativeReferences: { datasets: number; references: number }; pageToken?: string } | null
}

/** @param deps Scoped transport, current collection and public native navigation. @returns Reusable launch observation and commands with lifecycle guards. */
export function createSearchLaunchStore(deps: { invoke: ClientTransport['invoke']; context(): { scope: number; styleId: string; pollMs: number; workspaceRevision?: string | undefined }; openSession(id: string): void }) {
  const initial = (): SearchLaunchState => ({ entries: [], options: null, optionsLoading: false, loading: false, error: '', failure: undefined, submission: null, datasetOptions: null })
  let state = initial(), scope = deps.context().scope, styleId = deps.context().styleId, workspaceRevision = deps.context().workspaceRevision, disposed = false, version = 0, datasetVersion = 0, epoch = 0
  const listeners = new Set<() => void>(), lifetime = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, reading: Promise<void> | undefined, submitting: Promise<SearchLaunchView | undefined> | undefined, refreshQueued = false
  const publish = (patch: Partial<SearchLaunchState>) => { if (disposed) return; state = { ...state, ...patch }; for (const listener of listeners) listener(); schedulePoll() }
  const current = (captured: number) => !disposed && captured === epoch && scope === deps.context().scope && styleId === deps.context().styleId
  const code = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'connection-unavailable'
  const diagnostic = (error: unknown) => { const parsed = searchLaunchViewSchema.shape.error.unwrap().safeParse(error); return parsed.success ? parsed.data : undefined }
  async function refresh() {
    if (disposed || reading || !styleId) return reading
    const captured = epoch, request = ++version, requestedStyle = styleId, requestedRevision = workspaceRevision
    publish({ loading: true })
    const work = (async () => {
      try {
        const entries = z.array(searchLaunchViewSchema).parse(await deps.invoke('search-launch-list', { styleId: requestedStyle }, lifetime.signal))
        if (current(captured) && request === version && requestedRevision === workspaceRevision) publish({ entries, loading: false, error: '', failure: undefined, submission: state.submission && entries.some(item => item.id === state.submission?.input.operationId) ? null : state.submission })
      } catch (error) { if (current(captured) && request === version && requestedRevision === workspaceRevision) publish({ loading: false, error: code(error), failure: diagnostic(error) }) }
    })()
    reading = work
    try { await work } finally {
      if (reading === work) {
        reading = undefined
        const again = refreshQueued && listeners.size > 0
        refreshQueued = false
        if (again) void refresh()
        else schedulePoll()
      }
    }
  }
  async function loadOptions(more = false) {
    if (state.optionsLoading || more && !state.options?.usagePageToken) return
    const captured = epoch, prior = state.options
    publish({ optionsLoading: true, error: '', failure: undefined })
    try {
      const options = optionsSchema.parse(await deps.invoke('search-launch-options', more && prior?.usagePageToken ? { usagePageToken: prior.usagePageToken } : {}, lifetime.signal))
      if (current(captured)) publish({ options: more && prior ? { ...options, usages: [...new Map([...prior.usages, ...options.usages].map(item => [item.usageRevisionId, item])).values()] } : options, optionsLoading: false })
    } catch (error) { if (current(captured)) publish({ optionsLoading: false, error: code(error), failure: diagnostic(error) }) }
  }
  async function start(input: SearchLaunchDraft): Promise<SearchLaunchView | undefined> {
    if (submitting) return submitting
    const captured = epoch, parsed = searchLaunchInputSchema.parse(input), uncertain = state.submission?.input.operationId === input.operationId && state.submission.status === 'unknown'
    publish({ submission: { input: parsed, status: 'submitting' }, error: '', failure: undefined })
    const work = (async () => {
      let dispatching = false
      try {
        if (parsed.datasetId || parsed.output.kind === 'preview' || parsed.conversationModel || parsed.autoPrepareDataset || parsed.includeNegativeDatasets) {
          // 页面资源可先于常驻 Host 更新；只读确认能力，不能向旧 Host 降级发送无数据集任务。
          const options = optionsSchema.parse(await deps.invoke('search-launch-options', {}, lifetime.signal))
          if (!current(captured)) return undefined
          if (parsed.datasetId && options.datasetSelection !== 'required' || parsed.output.kind === 'preview' && options.previewSearch === undefined || parsed.conversationModel && options.conversationModelSelection !== true || parsed.autoPrepareDataset && options.automaticDatasetPreparation !== true || parsed.includeNegativeDatasets && options.negativeReferenceDatasets !== true) {
            publish({ submission: { input: parsed, status: uncertain ? 'unknown' : 'rejected', error: 'launch-update-required' } })
            return undefined
          }
          if (parsed.output.kind === 'preview' && options.previewSearch === false) {
            publish({ submission: { input: parsed, status: uncertain ? 'unknown' : 'rejected', error: 'preview-source-unsupported' } })
            return undefined
          }
        }
        dispatching = true
        const { datasetId, conversationModel, autoPrepareDataset, includeNegativeDatasets, ...settings } = parsed
        const modelFields: Record<string, string> | undefined = conversationModel ? { provider: conversationModel.provider, model: conversationModel.model } : undefined
        if (modelFields && conversationModel?.reasoningEffort) modelFields.reasoningEffort = conversationModel.reasoningEffort
        const value = searchLaunchViewSchema.parse(await deps.invoke('search-launch-start', { ...settings, ...(datasetId ? { datasetId } : {}), ...(modelFields ? { conversationModel: modelFields } : {}), ...(autoPrepareDataset === undefined ? {} : { autoPrepareDataset }), ...(includeNegativeDatasets === undefined ? {} : { includeNegativeDatasets }) }, lifetime.signal))
        if (current(captured)) publish({ entries: [value, ...state.entries.filter(item => item.id !== value.id)], submission: null })
        return value
      } catch (error) {
        const failure = code(error), rejected = !dispatching ? !uncertain : ['invalid-input', 'configuration-required', 'owner-denied', 'constraint-conflict', 'reference-unavailable', 'capability-unavailable', 'revision-conflict'].includes(failure)
        // 新提交的只读准备失败可修改字段；已有未知回执或启动发出后的断线保留原操作。
        if (current(captured)) publish({ submission: { input: parsed, status: rejected ? 'rejected' : 'unknown', error: failure, failure: diagnostic(error) } })
        return undefined
      }
    })()
    submitting = work
    try { return await work } finally { if (submitting === work) submitting = undefined }
  }
  async function loadDatasets(modelProfileId: string, more = false): Promise<void> {
    if (disposed || !styleId || !modelProfileId) return
    const prior = state.datasetOptions?.modelProfileId === modelProfileId ? state.datasetOptions : undefined
    if (prior?.loading || more && !prior?.pageToken) return
    const captured = epoch, request = ++datasetVersion, requestedStyle = styleId
    const retained = prior?.entries ?? [], total = prior?.total ?? 0
    const negativeReferences = prior?.negativeReferences ?? { datasets: 0, references: 0 }
    publish({ datasetOptions: { modelProfileId, entries: retained, total, loading: true, error: '', negativeReferences, ...(prior?.pageToken ? { pageToken: prior.pageToken } : {}) } })
    try {
      const page = searchLaunchDatasetsSchema.parse(await deps.invoke('search-launch-datasets', { styleId: requestedStyle, modelProfileId, ...(more && prior?.pageToken ? { pageToken: prior.pageToken } : {}) }, lifetime.signal))
      if (!current(captured) || request !== datasetVersion) return
      if (page.styleId !== requestedStyle || page.entries.some(entry => entry.styleId !== requestedStyle || entry.sampleScope !== 'all' || entry.status !== 'completed' || !entry.exportId)) throw new Error('dataset-options-mismatch')
      // 数据包不可变；刷新保留已加载页，返回详情时不丢失所选旧页，跨画像或作用域则不复用。
      const entries = [...new Map([...retained, ...page.entries].map(entry => [entry.exportId, entry])).values()]
      publish({ datasetOptions: { modelProfileId, entries, total: page.total, loading: false, error: '', negativeReferences: page.negativeReferences, ...(page.nextPageToken ? { pageToken: page.nextPageToken } : {}) } })
    } catch (error) {
      if (current(captured) && request === datasetVersion) publish({ datasetOptions: { modelProfileId, entries: retained, total, loading: false, error: code(error), negativeReferences, ...(prior?.pageToken ? { pageToken: prior.pageToken } : {}) } })
    }
  }
  async function stop(id: string) {
    const captured = epoch
    try {
      const value = searchLaunchViewSchema.parse(await deps.invoke('search-launch-stop', { id }, lifetime.signal))
      if (current(captured)) publish({ entries: state.entries.map(item => item.id === id ? value : item), error: '', failure: undefined })
    } catch (error) { if (current(captured)) publish({ error: code(error), failure: diagnostic(error) }) }
  }
  function schedulePoll() {
    clearTimeout(timer); timer = undefined
    const unfinished = state.submission?.status === 'submitting' || state.submission?.status === 'unknown' || state.entries.some(entry => entry.status === 'working' || entry.status === 'accepted' && (entry.stopping || !entry.runStatus || ['created', 'running', 'pausing', 'cancelling'].includes(entry.runStatus)))
    if (disposed || !listeners.size || !styleId || reading || state.loading || !unfinished && !state.error) return
    timer = setTimeout(() => { timer = undefined; void refresh() }, deps.context().pollMs)
  }
  function sync() {
    if (disposed) return
    const next = deps.context()
    if (next.scope === scope && next.styleId === styleId) {
      if (next.workspaceRevision === workspaceRevision) return
      workspaceRevision = next.workspaceRevision
      if (listeners.size) { if (reading) refreshQueued = true; else void refresh() }
      return
    }
    scope = next.scope; styleId = next.styleId; workspaceRevision = next.workspaceRevision; ++epoch; ++version; reading = undefined; submitting = undefined; refreshQueued = false; publish(initial())
    if (listeners.size) void refresh()
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {}
      const first = !listeners.size
      listeners.add(listener)
      if (first) { const inFlight = reading; sync(); if (inFlight && reading === inFlight) refreshQueued = true; void refresh() }
      return () => { listeners.delete(listener); schedulePoll() }
    },
    sync,
    refresh, loadOptions, loadDatasets, start, stop,
    async retry(id: string) { const entry = state.entries.find(item => item.id === id); if (entry) return start(entry.input); return undefined },
    openSession(id: string) { try { deps.openSession(id); return true } catch (error) { publish({ error: 'navigation-unavailable' }); return false } },
    dispose() { disposed = true; lifetime.abort(); clearTimeout(timer); listeners.clear() },
  }
}
export type SearchLaunchStore = ReturnType<typeof createSearchLaunchStore>
