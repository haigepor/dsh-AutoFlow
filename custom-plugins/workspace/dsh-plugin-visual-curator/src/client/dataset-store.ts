/** Dataset observation outlives dialogs and never refreshes image workspace contents. */
import { z } from 'zod'
import { datasetListSchema, datasetDetailSchema, datasetDeleteReceiptSchema, type DatasetEntry, type DatasetDetail, type DatasetScope, type DatasetRoleFilter } from '../shared/datasets.ts'
import type { ClientTransport } from './store.ts'

/** A failed submission keeps its operation identity because the Host may have accepted it. */
export interface DatasetSubmission { operationId: string; profileId: string; styleId: string; sampleScope: DatasetScope; status: 'submitting' | 'unknown' | 'accepted'; runId?: string }
/** Owner-private list, read-only detail and background task observation. */
export interface DatasetClientState {
  styleId: string; entries: DatasetEntry[]; pageIds: string[]; total: number; allTotal: number; nextPageToken?: string | undefined
  versionTotal?: number | undefined; exportTotal?: number | undefined
  query: string; status: 'all' | 'active' | 'completed' | 'failed'; loading: boolean; error: boolean
  submissions: DatasetSubmission[]; watched: string[]; dismissed: string[]
  detailId: string; detail: DatasetDetail | null; detailLoading: boolean; detailError: boolean; sampleRole: DatasetRoleFilter
}

/** @param status Persisted run state. @returns Whether the task still owns unfinished work. */
export function datasetActive(status: DatasetEntry['status']): boolean { return ['created', 'running', 'pausing', 'paused', 'cancelling'].includes(status) }

interface CachedDetail { detail: DatasetDetail; at: number; resourceReadAt: number; bytes: number }

/** @param dependencies Scoped transport, live owner/collection identity and optional bounded cache policy; omitted policy disables reuse. @returns A dialog-independent store; completed pages may be reused within their original resource lifetime, while closing a view never cancels generation. */
export function createDatasetStore(dependencies: { invoke: ClientTransport['invoke']; context(): { scope: number; styleId: string; workspaceRevision?: string | undefined }; operationId?(): string; cachePolicy?(): { ttlMs: number; maxViews: number; maxBytes: number; resourceTtlMs: number }; now?(): number }) {
  const initial = (): DatasetClientState => ({ styleId: '', entries: [], pageIds: [], total: 0, allTotal: 0, query: '', status: 'all', loading: false, error: false, submissions: [], watched: [], dismissed: [], detailId: '', detail: null, detailLoading: false, detailError: false, sampleRole: 'all' })
  let state = initial(), scope = dependencies.context().scope, disposed = false, listVersion = 0, detailVersion = 0, mutationVersion = 0
  const removals = new Map<string, { operationId: string; work?: Promise<void> }>()
  let listWork: Promise<void> | undefined, listController: AbortController | undefined, detailController: AbortController | undefined
  const submissions = new Map<string, Promise<void>>(), lifetime = new AbortController(), listeners = new Set<() => void>()
  const details = new Map<string, CachedDetail>(), now = dependencies.now ?? Date.now, encoder = new TextEncoder()
  let detailReadAt = 0
  let polling: Promise<void> | undefined
  let workspaceRevision = dependencies.context().workspaceRevision, refreshRequested = false
  let scopeLifetime = new AbortController()
  function publish(update: Partial<DatasetClientState>) { if (disposed) return; state = { ...state, ...update }; for (const listener of listeners) listener() }
  const current = (captured: number) => !disposed && scope === captured && dependencies.context().scope === captured
  const merged = (rows: DatasetEntry[]) => [...new Map([...state.entries, ...rows].map(row => [row.id, row])).values()]
  const detailKey = (id: string, role: DatasetRoleFilter) => JSON.stringify([id, role])
  const entryRevision = (entry: DatasetEntry) => JSON.stringify([entry.exportId, entry.status, entry.styleId, entry.name, entry.model, entry.modelProfileId, entry.profileRevision, entry.contentDigest, entry.sampleScope, entry.counts, entry.changes, entry.duplicateExports])
  function pruneDetails() {
    const policy = dependencies.cachePolicy?.(), time = now()
    if (!policy?.ttlMs || !policy.maxViews || !policy.maxBytes || !policy.resourceTtlMs) { details.clear(); return undefined }
    for (const [key, cached] of details) if (time < cached.at || time < cached.resourceReadAt || time >= Math.min(cached.at + policy.ttlMs, cached.resourceReadAt + policy.resourceTtlMs)) details.delete(key)
    let bytes = [...details.values()].reduce((sum, cached) => sum + cached.bytes, 0)
    while (details.size > policy.maxViews || bytes > policy.maxBytes) { const key = details.keys().next().value!; bytes -= details.get(key)!.bytes; details.delete(key) }
    return policy
  }
  function invalidateChanged(rows: DatasetEntry[]) {
    const revisions = new Map(rows.map(entry => [entry.id, entryRevision(entry)]))
    for (const [key, cached] of details) { const revision = revisions.get(cached.detail.entry.id); if (revision && revision !== entryRevision(cached.detail.entry)) details.delete(key) }
  }
  function rememberDetail(detail: DatasetDetail, role: DatasetRoleFilter, page: DatasetDetail, prior: DatasetDetail | null, cached: CachedDetail | undefined) {
    if (!pruneDetails() || detail.entry.status !== 'completed' || !detail.entry.exportId) return
    const key = detailKey(detail.entry.id, role)
    // Only the new wire page is encoded; already loaded samples are not serialized again on every append.
    const bytes = encoder.encode(JSON.stringify(prior ? page.samples : page)).byteLength + (prior ? cached?.bytes ?? encoder.encode(JSON.stringify(prior)).byteLength : 0)
    details.delete(key); details.set(key, { detail, bytes, at: now(), resourceReadAt: detailReadAt }); pruneDetails()
  }

  async function readPage(more = false): Promise<void> {
    if (!state.styleId || listWork || more && !state.nextPageToken) return listWork
    const captured = scope, version = ++listVersion, styleId = state.styleId, controller = new AbortController()
    listController = controller
    const args = { styleId, query: state.query, status: state.status, ...(more ? { pageToken: state.nextPageToken! } : {}) }
    publish({ loading: true, error: false })
    const work = dependencies.invoke('datasets-list', args, controller.signal).then(raw => {
      if (!current(captured) || controller.signal.aborted || version !== listVersion) return
      const page = datasetListSchema.parse(raw)
      if (page.styleId !== styleId) throw new Error('dataset-collection-mismatch')
      invalidateChanged(page.entries)
      const entries = merged(page.entries)
      publish({ entries, pageIds: more ? [...new Set([...state.pageIds, ...page.entries.map(row => row.id)])] : page.entries.map(row => row.id), total: page.total, allTotal: page.allTotal, versionTotal: page.versionTotal, exportTotal: page.exportTotal, nextPageToken: page.nextPageToken,
        submissions: state.submissions.filter(item => !page.entries.some(row => row.runId === item.runId || row.duplicateExports?.some(copy => copy.runId === item.runId))), loading: false })
    }).catch(error => { if (current(captured) && !controller.signal.aborted && version === listVersion) publish({ loading: false, error: true }) })
    listWork = work
    try { await work } finally { if (listWork === work) { listWork = undefined; listController = undefined; refreshChanged() } }
  }

  async function readDetail(id: string, more = false, sampleRole: DatasetRoleFilter = id === state.detailId ? state.sampleRole : 'all'): Promise<void> {
    if (!id || !current(scope) || more && (state.detailLoading || !state.detail?.nextSamplePageToken)) return
    detailController?.abort()
    const policy = pruneDetails(), key = detailKey(id, sampleRole), cached = details.get(key)
    if (!more && cached && !state.detailError) {
      ++detailVersion; details.delete(key); details.set(key, cached); detailReadAt = cached.resourceReadAt
      publish({ detailId: id, detail: cached.detail, sampleRole, detailLoading: false, detailError: false }); return
    }
    const expired = more && policy && now() >= detailReadAt + policy.resourceTtlMs
    if (expired) { more = false; details.delete(key) }
    const captured = scope, version = ++detailVersion, controller = new AbortController(), prior = state.detailId === id ? state.detail : null
    const startedAt = now()
    detailController = controller
    publish({ detailId: id, detail: prior, sampleRole, detailLoading: true, detailError: false })
    try {
      const raw = await dependencies.invoke('dataset-get', { id, sampleRole, ...(more && prior?.nextSamplePageToken ? { pageToken: prior.nextSamplePageToken } : {}) }, controller.signal)
      if (!current(captured) || controller.signal.aborted || version !== detailVersion) return
      const detail = datasetDetailSchema.parse(raw)
      if (detail.entry.id !== id || detail.entry.styleId !== state.styleId) throw new Error('dataset-detail-mismatch')
      const listed = state.entries.find(entry => entry.id === id)
      if (listed?.duplicateExports) detail.entry.duplicateExports = listed.duplicateExports
      if (listed?.isFinal !== undefined) detail.entry.isFinal = listed.isFinal
      if (listed?.stale !== undefined) detail.entry.stale = listed.stale
      if (!more) detailReadAt = startedAt
      const combined = more && prior ? { ...detail, samples: [...prior.samples, ...detail.samples] } : detail
      rememberDetail(combined, sampleRole, detail, more ? prior : null, cached)
      publish({ detail: combined, entries: merged([detail.entry]), detailLoading: false })
    } catch (error) { if (current(captured) && !controller.signal.aborted && version === detailVersion) publish({ detailLoading: false, detailError: true }) }
  }

  async function submit(profile: { id: string; styleId: string; sampleScope?: DatasetScope }): Promise<void> {
    const sampleScope = profile.sampleScope ?? 'all', key = JSON.stringify([profile.id, sampleScope])
    const running = submissions.get(key)
    if (running) return running
    const prior = state.submissions.find(item => item.profileId === profile.id && item.sampleScope === sampleScope)
    const active = state.entries.find(row => row.modelProfileId === profile.id && row.sampleScope === sampleScope && datasetActive(row.status))
    if (active && !prior) { publish({ watched: [...new Set([...state.watched, active.id])], dismissed: state.dismissed.filter(id => id !== active.id) }); return }
    if (prior?.status === 'accepted') { await readPage(); return }
    const completed = state.entries.find(row => row.modelProfileId === profile.id && row.sampleScope === sampleScope && row.status === 'completed')
    if (completed && !prior) { publish({ watched: [...new Set([...state.watched, completed.id])], dismissed: state.dismissed.filter(id => id !== completed.id) }); return }
    const captured = scope, submission: DatasetSubmission = { operationId: prior?.operationId ?? dependencies.operationId?.() ?? crypto.randomUUID(), profileId: profile.id, styleId: profile.styleId, sampleScope, status: 'submitting' }
    publish({ submissions: [...state.submissions.filter(item => item.profileId !== profile.id || item.sampleScope !== sampleScope), submission] })
    const work = (async () => {
      try {
        const result = z.object({ runId: z.string().min(1) }).parse(await dependencies.invoke('export-start', { operationId: submission.operationId, kind: 'style', purpose: 'reference', releaseId: profile.id, mode: 'references-only', sampleScope }, AbortSignal.any([lifetime.signal, scopeLifetime.signal])))
        if (!current(captured)) return
        publish({ submissions: state.submissions.map(item => item.operationId === submission.operationId ? { ...item, status: 'accepted', runId: result.runId } : item), watched: [...new Set([...state.watched, result.runId])], dismissed: state.dismissed.filter(id => id !== result.runId) })
        if (listWork) await listWork
        await readPage()
      } catch (error) {
        // 网络中断不能证明 Host 未接收；重试沿用同一操作 ID，避免重复生成。
        if (current(captured)) publish({ submissions: state.submissions.map(item => item.operationId === submission.operationId ? { ...item, status: 'unknown' } : item) })
      }
    })()
    submissions.set(key, work)
    try { await work } finally { if (submissions.get(key) === work) submissions.delete(key) }
  }

  function clearReads() { ++listVersion; ++detailVersion; listController?.abort(); detailController?.abort(); listWork = undefined; listController = undefined; detailController = undefined }
  function refreshChanged() {
    if (!refreshRequested || listWork || polling || disposed) return
    refreshRequested = false
    void poll()
  }
  async function poll(): Promise<void> {
    if (polling || !state.styleId) return polling
    const captured = scope, styleId = state.styleId, version = mutationVersion
    const work = (async () => {
      try {
        const page = datasetListSchema.parse(await dependencies.invoke('datasets-list', { styleId, status: 'all', query: '' }, AbortSignal.any([lifetime.signal, scopeLifetime.signal])))
        if (!current(captured) || styleId !== state.styleId || version !== mutationVersion) return
        const entries = merged(page.entries), unfiltered = state.status === 'all' && !state.query
        invalidateChanged(page.entries)
        publish({ entries, allTotal: page.allTotal, versionTotal: page.versionTotal, exportTotal: page.exportTotal, error: false, submissions: state.submissions.filter(item => !page.entries.some(row => row.runId === item.runId || row.duplicateExports?.some(copy => copy.runId === item.runId))),
          ...(unfiltered ? { pageIds: [...new Set([...page.entries.map(row => row.id), ...state.pageIds])], total: page.total, nextPageToken: state.pageIds.length > page.entries.length ? state.nextPageToken : page.nextPageToken } : {}) })
        if (state.detail && state.detail.entry.status !== 'completed' && entries.find(row => row.id === state.detailId)?.status === 'completed') void readDetail(state.detailId)
        if (!unfiltered) await readPage()
      } catch (error) { if (current(captured) && styleId === state.styleId && version === mutationVersion) publish({ error: true }) }
    })()
    polling = work
    try { await work } finally { if (polling === work) { polling = undefined; refreshChanged() } }
  }

  async function remove(id: string): Promise<void> {
    if (!state.styleId) return
    const removal: { operationId: string; work?: Promise<void> } = removals.get(id) ?? { operationId: dependencies.operationId?.() ?? crypto.randomUUID() }
    if (removal.work) return removal.work
    removals.set(id, removal)
    const captured = scope, styleId = state.styleId
    const work = (async () => {
      const receipt = datasetDeleteReceiptSchema.parse(await dependencies.invoke('dataset-delete', { id, styleId, operationId: removal.operationId }))
      if (!current(captured) || styleId !== state.styleId) return
      if (receipt.styleId !== styleId || !receipt.ids.some(key => key === id)) throw new Error('dataset-removal-mismatch')
      ++mutationVersion; clearReads(); details.clear()
      const ids = new Set<string>(receipt.ids)
      publish({ entries: state.entries.filter(entry => !ids.has(entry.id)), pageIds: state.pageIds.filter(key => !ids.has(key)), watched: state.watched.filter(key => !ids.has(key)), submissions: state.submissions.filter(item => !item.runId || !ids.has(item.runId)), loading: false,
        ...(ids.has(state.detailId) ? { detailId: '', detail: null, detailLoading: false, detailError: false } : {}) })
      removals.delete(id)
      await readPage()
    })()
    removal.work = work
    try { await work } finally { delete removal.work }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    sync() {
      const context = dependencies.context()
      if (context.scope !== scope) { clearReads(); details.clear(); removals.clear(); detailReadAt = 0; scopeLifetime.abort(); scopeLifetime = new AbortController(); polling = undefined; refreshRequested = false; scope = context.scope; submissions.clear(); publish(initial()) }
      if (context.styleId !== state.styleId) { clearReads(); details.clear(); detailReadAt = 0; refreshRequested = false; workspaceRevision = context.workspaceRevision; publish({ styleId: context.styleId, pageIds: [], query: '', status: 'all', total: 0, allTotal: 0, versionTotal: undefined, exportTotal: undefined, nextPageToken: undefined, loading: false, error: false, detailId: '', detail: null, detailLoading: false, detailError: false, sampleRole: 'all' }); void readPage(); return }
      if (context.workspaceRevision !== workspaceRevision) { workspaceRevision = context.workspaceRevision; refreshRequested = true; refreshChanged() }
    },
    start: submit,
    remove,
    refresh: () => { details.clear(); return readPage() },
    poll,
    loadMore: () => readPage(true),
    filter(query: string, status: DatasetClientState['status']) { if (query === state.query && status === state.status) return; clearReads(); publish({ query, status, pageIds: [], nextPageToken: undefined, loading: false }); void readPage() },
    open: (id: string) => readDetail(id),
    moreSamples: () => readDetail(state.detailId, true),
    filterSamples(role: DatasetRoleFilter) { if (!state.detailId || role === state.sampleRole) return; return readDetail(state.detailId, false, role) },
    closeDetail() { ++detailVersion; detailController?.abort(); publish({ detailId: '', detail: null, detailLoading: false, detailError: false, sampleRole: 'all' }) },
    dismiss(id: string) { publish({ dismissed: [...state.dismissed, id] }) },
    needsPoll: () => state.error || refreshRequested || state.submissions.some(item => item.styleId === state.styleId && item.status === 'accepted') || state.entries.some(row => row.styleId === state.styleId && datasetActive(row.status)),
    dispose() { clearReads(); details.clear(); lifetime.abort(); scopeLifetime.abort(); disposed = true; listeners.clear() },
  }
}

/** Workbench injection keeps all event handlers stable across progress updates. */
export type DatasetStore = ReturnType<typeof createDatasetStore>
