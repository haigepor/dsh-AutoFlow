/** Dataset observation outlives dialogs and never refreshes image workspace contents. */
import { z } from 'zod'
import { datasetListSchema, datasetDetailSchema, type DatasetEntry, type DatasetDetail } from '../shared/datasets.ts'
import type { ClientTransport } from './store.ts'

/** A failed submission keeps its operation identity because the Host may have accepted it. */
export interface DatasetSubmission { operationId: string; profileId: string; styleId: string; status: 'submitting' | 'unknown' | 'accepted'; runId?: string }
/** Owner-private list, read-only detail and background task observation. */
export interface DatasetClientState {
  styleId: string; entries: DatasetEntry[]; pageIds: string[]; total: number; allTotal: number; nextPageToken?: string | undefined
  query: string; status: 'all' | 'active' | 'completed' | 'failed'; loading: boolean; error: boolean
  submissions: DatasetSubmission[]; watched: string[]; dismissed: string[]
  detailId: string; detail: DatasetDetail | null; detailLoading: boolean; detailError: boolean
}

/** @param status Persisted run state. @returns Whether the task still owns unfinished work. */
export function datasetActive(status: DatasetEntry['status']): boolean { return ['created', 'running', 'pausing', 'paused', 'cancelling'].includes(status) }

/** @param dependencies Scoped authenticated transport and live owner/collection identity. @returns A dialog-independent store; closing a view never cancels submission or generation. */
export function createDatasetStore(dependencies: { invoke: ClientTransport['invoke']; context(): { scope: number; styleId: string }; operationId?(): string }) {
  const initial = (): DatasetClientState => ({ styleId: '', entries: [], pageIds: [], total: 0, allTotal: 0, query: '', status: 'all', loading: false, error: false, submissions: [], watched: [], dismissed: [], detailId: '', detail: null, detailLoading: false, detailError: false })
  let state = initial(), scope = dependencies.context().scope, disposed = false, listVersion = 0, detailVersion = 0
  let listWork: Promise<void> | undefined, listController: AbortController | undefined, detailController: AbortController | undefined
  const submissions = new Map<string, Promise<void>>(), lifetime = new AbortController(), listeners = new Set<() => void>()
  let polling: Promise<void> | undefined
  let scopeLifetime = new AbortController()
  function publish(update: Partial<DatasetClientState>) { if (disposed) return; state = { ...state, ...update }; for (const listener of listeners) listener() }
  const current = (captured: number) => !disposed && scope === captured && dependencies.context().scope === captured
  const merged = (rows: DatasetEntry[]) => [...new Map([...state.entries, ...rows].map(row => [row.id, row])).values()]

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
      const entries = merged(page.entries)
      publish({ entries, pageIds: more ? [...new Set([...state.pageIds, ...page.entries.map(row => row.id)])] : page.entries.map(row => row.id), total: page.total, allTotal: page.allTotal, nextPageToken: page.nextPageToken,
        submissions: state.submissions.filter(item => !page.entries.some(row => row.runId === item.runId)), loading: false })
    }).catch(error => { if (current(captured) && !controller.signal.aborted && version === listVersion) publish({ loading: false, error: true }) })
    listWork = work
    try { await work } finally { if (listWork === work) { listWork = undefined; listController = undefined } }
  }

  async function readDetail(id: string, more = false): Promise<void> {
    if (more && (state.detailLoading || !state.detail?.nextSamplePageToken)) return
    detailController?.abort()
    const captured = scope, version = ++detailVersion, controller = new AbortController(), prior = state.detailId === id ? state.detail : null
    detailController = controller
    publish({ detailId: id, detail: prior, detailLoading: true, detailError: false })
    try {
      const raw = await dependencies.invoke('dataset-get', { id, ...(more && prior?.nextSamplePageToken ? { pageToken: prior.nextSamplePageToken } : {}) }, controller.signal)
      if (!current(captured) || controller.signal.aborted || version !== detailVersion) return
      const detail = datasetDetailSchema.parse(raw)
      if (detail.entry.id !== id || detail.entry.styleId !== state.styleId) throw new Error('dataset-detail-mismatch')
      publish({ detail: more && prior ? { ...detail, samples: [...prior.samples, ...detail.samples] } : detail, entries: merged([detail.entry]), detailLoading: false })
    } catch (error) { if (current(captured) && !controller.signal.aborted && version === detailVersion) publish({ detailLoading: false, detailError: true }) }
  }

  async function submit(profile: { id: string; styleId: string }): Promise<void> {
    const running = submissions.get(profile.id)
    if (running) return running
    const prior = state.submissions.find(item => item.profileId === profile.id)
    const active = state.entries.find(row => row.modelProfileId === profile.id && datasetActive(row.status))
    if (active && !prior) { publish({ watched: [...new Set([...state.watched, active.id])], dismissed: state.dismissed.filter(id => id !== active.id) }); return }
    if (prior?.status === 'accepted') { await readPage(); return }
    const captured = scope, submission: DatasetSubmission = { operationId: prior?.operationId ?? dependencies.operationId?.() ?? crypto.randomUUID(), profileId: profile.id, styleId: profile.styleId, status: 'submitting' }
    publish({ submissions: [...state.submissions.filter(item => item.profileId !== profile.id), submission] })
    const work = (async () => {
      try {
        const result = z.object({ runId: z.string().min(1) }).parse(await dependencies.invoke('export-start', { operationId: submission.operationId, kind: 'style', purpose: 'reference', releaseId: profile.id, mode: 'references-only' }, AbortSignal.any([lifetime.signal, scopeLifetime.signal])))
        if (!current(captured)) return
        publish({ submissions: state.submissions.map(item => item.operationId === submission.operationId ? { ...item, status: 'accepted', runId: result.runId } : item), watched: [...new Set([...state.watched, result.runId])], dismissed: state.dismissed.filter(id => id !== result.runId) })
        if (listWork) await listWork
        await readPage()
      } catch (error) {
        // 网络中断不能证明 Host 未接收；重试沿用同一操作 ID，避免重复生成。
        if (current(captured)) publish({ submissions: state.submissions.map(item => item.operationId === submission.operationId ? { ...item, status: 'unknown' } : item) })
      }
    })()
    submissions.set(profile.id, work)
    try { await work } finally { if (submissions.get(profile.id) === work) submissions.delete(profile.id) }
  }

  function clearReads() { ++listVersion; ++detailVersion; listController?.abort(); detailController?.abort(); listWork = undefined; listController = undefined; detailController = undefined }
  async function poll(): Promise<void> {
    if (polling || !state.styleId) return polling
    const captured = scope, styleId = state.styleId
    const work = (async () => {
      try {
        const page = datasetListSchema.parse(await dependencies.invoke('datasets-list', { styleId, status: 'all', query: '' }, AbortSignal.any([lifetime.signal, scopeLifetime.signal])))
        if (!current(captured) || styleId !== state.styleId) return
        const entries = merged(page.entries), unfiltered = state.status === 'all' && !state.query
        publish({ entries, allTotal: page.allTotal, error: false, submissions: state.submissions.filter(item => !page.entries.some(row => row.runId === item.runId)),
          ...(unfiltered ? { pageIds: [...new Set([...page.entries.map(row => row.id), ...state.pageIds])], total: page.total, nextPageToken: state.pageIds.length > page.entries.length ? state.nextPageToken : page.nextPageToken } : {}) })
        if (state.detail && state.detail.entry.status !== 'completed' && entries.find(row => row.id === state.detailId)?.status === 'completed') void readDetail(state.detailId)
        if (!unfiltered) await readPage()
      } catch (error) { if (current(captured) && styleId === state.styleId) publish({ error: true }) }
    })()
    polling = work
    try { await work } finally { if (polling === work) polling = undefined }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    sync() {
      const context = dependencies.context()
      if (context.scope !== scope) { clearReads(); scopeLifetime.abort(); scopeLifetime = new AbortController(); polling = undefined; scope = context.scope; submissions.clear(); publish(initial()) }
      if (context.styleId !== state.styleId) { clearReads(); publish({ styleId: context.styleId, pageIds: [], query: '', status: 'all', total: 0, allTotal: 0, nextPageToken: undefined, loading: false, error: false, detailId: '', detail: null, detailLoading: false, detailError: false }); void readPage() }
    },
    start: submit,
    refresh: () => readPage(),
    poll,
    loadMore: () => readPage(true),
    filter(query: string, status: DatasetClientState['status']) { if (query === state.query && status === state.status) return; clearReads(); publish({ query, status, pageIds: [], nextPageToken: undefined, loading: false }); void readPage() },
    open: (id: string) => readDetail(id),
    moreSamples: () => readDetail(state.detailId, true),
    closeDetail() { ++detailVersion; detailController?.abort(); publish({ detailId: '', detail: null, detailLoading: false, detailError: false }) },
    dismiss(id: string) { publish({ dismissed: [...state.dismissed, id] }) },
    needsPoll: () => state.submissions.some(item => item.styleId === state.styleId && item.status === 'accepted') || state.entries.some(row => row.styleId === state.styleId && datasetActive(row.status)),
    dispose() { clearReads(); lifetime.abort(); scopeLifetime.abort(); disposed = true; listeners.clear() },
  }
}

/** Workbench injection keeps all event handlers stable across progress updates. */
export type DatasetStore = ReturnType<typeof createDatasetStore>
