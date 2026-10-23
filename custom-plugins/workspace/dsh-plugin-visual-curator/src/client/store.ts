import type { ActionArgs, CuratorSnapshot, ImageView, RunView, SafeFailure, Workspace } from './contract.ts'

/** The plugin manager supplies authentication; mutation authorship never comes from action arguments. */
export interface ClientTransport {
  invoke(operation: string, args: ActionArgs): Promise<unknown>
}

/** Viewing state survives server refreshes and is independent of durable job execution. */
export interface ClientState {
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
  let state: ClientState = { snapshot: null, workspace: 'styles', styleId: '', runId: '', candidateId: '', cropRunId: '', cropSelection: 0, selectedImageIds: [],
    previewId: '', filter: 'all', page: 0, loading: false, pending: [], error: null, toast: null, sessionToken: '', scopeSessionId: '', runLoading: false, runError: null }
  const listeners = new Set<() => void>()
  let disposed = false, readSequence = 0, toastId = 0
  let refreshing: Promise<void> | undefined
  let scopeSequence = 0
  const runReads = new Map<string, Promise<void>>()
  const runFirstCursors = new Map<string, string | undefined>()
  let imagesFirstCursor: string | undefined
  const clearCrop = () => ({ candidateId: '', cropRunId: '', cropSelection: state.cropSelection + 1 })
  const mergeImages = (fresh: ImageView[], previous: ImageView[]) => [...new Map([...previous, ...fresh].map(image => [image.referenceId ?? image.imageVersionId, image])).values()]

  function publish(update: Partial<ClientState>): void {
    if (disposed) return
    state = { ...state, ...update }
    for (const listener of listeners) listener()
  }
  const invoke = (operation: string, args: ActionArgs): Promise<unknown> => transport.invoke(operation,
    state.sessionToken && operation !== 'session-open' ? { ...args, sessionToken: state.sessionToken } : args)
  async function loadRun(runId: string, append = false): Promise<void> {
    if (runReads.has(runId)) return runReads.get(runId)
    const scope = scopeSequence
    const prior = state.snapshot?.runs.find(run => run.runId === runId)
    if (!prior || append && !prior.pageToken) return
    publish({ runLoading: true, runError: null })
    const request = invoke('run-get', { runId, ...(append && prior.pageToken ? { pageToken: prior.pageToken } : {}) }).then(value => {
      if (typeof value !== 'object' || value === null || !('runId' in value) || value.runId !== runId || !('results' in value) || !Array.isArray(value.results)) throw new Error('invalid-run')
      if (disposed || scope !== scopeSequence || !state.snapshot) return
      const run = value as RunView
      const previous = state.snapshot.runs.find(item => item.runId === runId)
      const retainCursor = !append && previous && previous.results.length > run.results.length && run.pageToken === runFirstCursors.get(runId)
        && run.results.every(image => previous.results.some(old => old.imageVersionId === image.imageVersionId))
      const { pageToken, ...fields } = run
      const nextCursor = retainCursor ? previous.pageToken : pageToken
      if (!append) runFirstCursors.set(runId, pageToken)
      const updated: RunView = { ...fields, results: mergeImages(run.results, previous?.results ?? []), ...(nextCursor ? { pageToken: nextCursor } : {}) }
      publish({ snapshot: { ...state.snapshot, runs: state.snapshot.runs.map(item => item.runId === runId ? updated : item) }, runLoading: false, runError: null })
    }).catch(error => { if (!disposed && scope === scopeSequence) publish({ runLoading: false, runError: failure(error) }) })
      .finally(() => { if (runReads.get(runId) === request) runReads.delete(runId) })
    runReads.set(runId, request)
    return request
  }
  async function reload(): Promise<void> {
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
        runs: snapshot.runs.map(run => { const old = previous?.runs.find(item => item.runId === run.runId); return old ? { ...run, results: old.results, ...(old.pageToken ? { pageToken: old.pageToken } : {}) } : run }),
        ...(nextCursor ? { nextPageToken: nextCursor } : {}) }
      publish({ snapshot: merged, loading: false, error: null,
        styleId: state.styleId || snapshot.styles[0]?.styleId || '', runId: state.runId || snapshot.runs[0]?.runId || '' })
      if (state.runId) await loadRun(state.runId)
      // 独立裁图任务继续刷新，但不切走左侧的来源任务和候选列表。
      if (state.cropRunId && state.cropRunId !== state.runId) await loadRun(state.cropRunId)
    }).catch(error => {
      if (!disposed && sequence === readSequence) publish({ loading: false, error: failure(error) })
    }).finally(() => { if (refreshing === request) refreshing = undefined })
    refreshing = request
    return request
  }
  async function execute(operation: string, args: ActionArgs, key = operation): Promise<unknown> {
    if (state.pending.includes(key)) return undefined
    publish({ pending: [...state.pending, key] })
    try {
      const result = await invoke(operation, args)
      publish({ toast: { id: ++toastId, success: true, code: 'saved' } })
      await reload()
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
      const value = await transport.invoke('session-open', { sessionId })
      if (typeof value !== 'object' || value === null || !('sessionToken' in value) || typeof value.sessionToken !== 'string') throw failure(value)
      ++readSequence; ++scopeSequence; refreshing = undefined; runReads.clear(); runFirstCursors.clear(); imagesFirstCursor = undefined
      publish({ ...clearCrop(), sessionToken: value.sessionToken, scopeSessionId: sessionId, snapshot: null, runId: '', selectedImageIds: [], previewId: '', page: 0, runLoading: false, runError: null })
      await reload()
    },
    closeSession() {
      ++readSequence; ++scopeSequence; refreshing = undefined; runReads.clear(); runFirstCursors.clear(); imagesFirstCursor = undefined
      publish({ ...clearCrop(), sessionToken: '', scopeSessionId: '', snapshot: null, runId: '', selectedImageIds: [], previewId: '', page: 0, runLoading: false, runError: null })
      void reload()
    },
    selectWorkspace(workspace: Workspace) { publish({ ...clearCrop(), workspace, page: 0, filter: 'all' }) },
    selectStyle(styleId: string) { publish({ styleId, page: 0 }) },
    selectRun(runId: string) { publish({ ...clearCrop(), runId, page: 0 }); void loadRun(runId) },
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
      ++readSequence; ++scopeSequence; refreshing = undefined; runReads.clear(); runFirstCursors.clear(); imagesFirstCursor = undefined
      publish({ ...clearCrop(), snapshot: null, loading: false, error: null, runLoading: false, runError: null,
        ...(state.sessionToken ? { sessionToken: '', scopeSessionId: '', runId: '', selectedImageIds: [], previewId: '' } : {}) })
      void reload()
    },
    dispose() { disposed = true; ++readSequence; ++scopeSequence; listeners.clear() },
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
