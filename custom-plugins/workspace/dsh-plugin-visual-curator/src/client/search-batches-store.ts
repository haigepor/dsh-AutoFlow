/** A visible collection's read-only batch pages never change the workbench Session scope. */
import { searchBatchDetailSchema, searchBatchPageSchema, type SearchBatchPage } from '../shared/search-batches.ts'
import type { ClientTransport } from './store.ts'
import { workflowHistoryReceiptSchema, type workflowHistoryDeleteSchema } from '../shared/workflow-history.ts'
import { z } from 'zod'

const readFailureSchema = z.object({ code: z.string().min(1).max(128), stage: z.string().min(1).max(128).optional() })

/** Viewing state is separate from execution ownership and the active conversation. */
export interface SearchBatchesState { styleId: string; batchId: string; page: SearchBatchPage | null; loading: boolean; error: boolean; failure?: z.infer<typeof readFailureSchema> | undefined; deleting: string[] }

interface CachedView { page: SearchBatchPage; firstPageToken: string | undefined; imageFirstTokens: Map<string, string | undefined>; cachedAt: number; resourceReadAt: number; expiresAt: number; failed?: boolean }

/** @param dependencies Authenticated transport, owner scope and deployment cache/refresh limits; omitted cache policy disables reuse. @returns Cancellable observation with independent pagination and bounded, memory-only collection/filter caches. */
export function createSearchBatchesStore(dependencies: Pick<ClientTransport, 'invoke'> & { pollMs(): number; scope?(): number; cachePolicy?(): { ttlMs: number; maxViews: number; resourceTtlMs: number }; now?(): number }) {
  let state: SearchBatchesState = { styleId: '', batchId: '', page: null, loading: false, error: false, deleting: [] }
  let scopeVersion = 0
  const listeners = new Set<() => void>()
  let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined, version = 0, observers = 0, disposed = false, firstPageToken: string | undefined
  const imageFirstTokens = new Map<string, string | undefined>()
  const cache = new Map<string, CachedView>(), now = dependencies.now ?? Date.now
  let ownerScope = dependencies.scope?.(), resourceReadAt = 0
  const cacheKey = (styleId: string, batchId: string) => JSON.stringify([styleId, batchId])
  const publish = (patch: Partial<SearchBatchesState>) => { if (patch.error === false) patch.failure = undefined; if (Object.entries(patch).every(([key, value]) => Object.is(state[key as keyof SearchBatchesState], value))) return; state = { ...state, ...patch }; for (const listener of listeners) listener() }
  const publishPage = (page: SearchBatchPage) => { if (!state.page || JSON.stringify(state.page) !== JSON.stringify(page)) publish({ page }) }
  const pollDelay = () => state.error || !state.page || state.page.batches.some(batch => ['created', 'running', 'pausing', 'cancelling'].includes(batch.status) || !!batch.wallpaper && ['created', 'running', 'pausing', 'cancelling'].includes(batch.wallpaper.status) || batch.wallpaperRequested && batch.status === 'completed' && batch.matched > 0 && !batch.wallpaper && !batch.postProcessingError) ? dependencies.pollMs() : Math.max(dependencies.pollMs(), Math.min(dependencies.cachePolicy?.().ttlMs || dependencies.pollMs(), dependencies.cachePolicy?.().resourceTtlMs || dependencies.pollMs()))
  const cancel = () => { ++version; controller?.abort(); controller = undefined; if (timer) clearTimeout(timer); timer = undefined }
  const clearPages = () => { firstPageToken = undefined; imageFirstTokens.clear(); resourceReadAt = 0 }
  function syncScope() {
    if (ownerScope === dependencies.scope?.()) return
    ownerScope = dependencies.scope?.(); scopeVersion++; cancel(); cache.clear(); clearPages()
    publish({ page: null, loading: false, error: false, deleting: [] })
  }
  function pruneCache() {
    const policy = dependencies.cachePolicy?.()
    if (!policy?.ttlMs || !policy.maxViews || !policy.resourceTtlMs) { cache.clear(); return undefined }
    for (const [key, entry] of cache) if (entry.expiresAt <= now() || entry.cachedAt + policy.ttlMs <= now() || entry.resourceReadAt + policy.resourceTtlMs <= now()) cache.delete(key)
    while (cache.size > policy.maxViews) cache.delete(cache.keys().next().value!)
    return policy
  }
  function remember() {
    const policy = pruneCache()
    if (!policy || !state.page) return
    const key = cacheKey(state.styleId, state.batchId)
    cache.delete(key)
    // 旧尾页仍使用首次读取的资源授权；刷新首页不能延长这些预览地址的可复用期限。
    cache.set(key, { page: state.page, firstPageToken, imageFirstTokens: new Map(imageFirstTokens), cachedAt: now(), resourceReadAt, expiresAt: Math.min(now() + policy.ttlMs, resourceReadAt + policy.resourceTtlMs) })
    pruneCache()
  }
  function invalidateCollection(styleId: string) {
    for (const [key, entry] of cache) if (entry.page.styleId === styleId) cache.delete(key)
  }
  function selectView(styleId: string, batchId: string) {
    if (styleId !== state.styleId) scopeVersion++
    cancel(); clearPages(); pruneCache()
    const key = cacheKey(styleId, batchId), saved = cache.get(key)
    if (saved) { cache.delete(key); cache.set(key, saved); firstPageToken = saved.firstPageToken; for (const [id, token] of saved.imageFirstTokens) imageFirstTokens.set(id, token); resourceReadAt = saved.resourceReadAt }
    publish({ styleId, batchId, page: saved?.page ?? null, loading: false, error: false, deleting: [] })
    return saved
  }
  function resumeView(saved: CachedView | undefined) {
    if (!saved || saved.failed) { void read('refresh', undefined, false, !!saved); return }
    const remaining = saved.cachedAt + pollDelay() - now()
    if (remaining <= 0) { void read('refresh', undefined, false, true); return }
    if (observers) timer = setTimeout(() => { timer = undefined; void read('refresh', undefined, false, true) }, remaining)
  }
  async function read(mode: 'refresh' | 'more' | 'images' = 'refresh', runId?: string, replace = false, background = false): Promise<void> {
    syncScope()
    if (disposed || !state.styleId || controller) return
    const resourceTtl = dependencies.cachePolicy?.().resourceTtlMs
    if (state.page && resourceTtl && resourceReadAt + resourceTtl <= now()) {
      clearPages(); replace = true
      if (mode !== 'refresh') return read('refresh', undefined, true)
    }
    if (timer) clearTimeout(timer); timer = undefined
    const current = ++version, scope = ownerScope, startedAt = now(), styleId = state.styleId, batchId = state.batchId, prior = state.page
    const imageBatch = prior?.batches.find(batch => batch.runId === runId)
    const pageToken = mode === 'more' ? prior?.nextPageToken : mode === 'images' ? imageBatch?.nextImagePageToken : undefined
    if (mode !== 'refresh' && !pageToken) return
    const request = new AbortController(); controller = request; publish({ ...(!background ? { loading: true } : {}), error: false })
    try {
      const page = searchBatchPageSchema.parse(await dependencies.invoke('search-batches', { styleId, ...(mode === 'images' && runId ? { batchId: runId } : batchId ? { batchId } : {}), ...(pageToken ? { pageToken } : {}) }, request.signal))
      if (disposed || current !== version) return
      if (scope !== dependencies.scope?.()) { syncScope(); if (observers) void read(); return }
      if (page.styleId !== state.styleId) throw new Error('batch-response-mismatch')
      const requestedBatch = mode === 'images' ? runId : batchId
      if (requestedBatch && page.batches.some(batch => batch.runId !== requestedBatch)) throw new Error('batch-response-mismatch')
      if (mode === 'images' && prior && imageBatch) {
        const updated = page.batches[0]
        if (!updated || updated.runId !== runId) throw new Error('batch-response-mismatch')
        const ids = new Set(imageBatch.images.map(image => image.imageVersionId))
        publishPage({ ...prior, batches: prior.batches.map(batch => batch.runId === runId ? { ...updated, images: [...imageBatch.images, ...updated.images.filter(image => !ids.has(image.imageVersionId))] } : batch) })
      } else {
        const ids = new Set(page.batches.map(batch => batch.runId))
        const retainTail = mode === 'refresh' && !replace && prior && !!firstPageToken && firstPageToken === page.nextPageToken
        let keptResources = mode === 'more' && !!prior || !!retainTail && prior.batches.some(batch => !ids.has(batch.runId))
        const batches = page.batches.map(batch => {
          const old = prior?.batches.find(item => item.runId === batch.runId)
          // 只有真实加载过后续页才合并尾部；完整响应中移除的批次或图片不能被旧缓存补回。
          const keepImages = !replace && mode === 'refresh' && old && !!imageFirstTokens.get(batch.runId) && imageFirstTokens.get(batch.runId) === batch.nextImagePageToken
          imageFirstTokens.set(batch.runId, batch.nextImagePageToken)
          if (!keepImages) return batch
          const imageIds = new Set(batch.images.map(image => image.imageVersionId)), { nextImagePageToken, ...fields } = batch
          const tail = old.images.filter(image => !imageIds.has(image.imageVersionId))
          if (tail.length) keptResources = true
          return { ...fields, images: [...batch.images, ...tail], ...(old.nextImagePageToken ? { nextImagePageToken: old.nextImagePageToken } : {}) }
        })
        const { nextPageToken, ...fields } = page, next = retainTail ? prior.nextPageToken : nextPageToken
        if (mode === 'refresh') firstPageToken = nextPageToken
        if (!keptResources) resourceReadAt = startedAt
        publishPage({ ...fields, batches: mode === 'more' && prior ? [...prior.batches, ...batches.filter(batch => !prior.batches.some(old => old.runId === batch.runId))] : retainTail ? [...batches, ...prior.batches.filter(batch => !ids.has(batch.runId))] : batches, ...(next ? { nextPageToken: next } : {}) })
      }
      remember()
    } catch (error) {
      if (!request.signal.aborted && !disposed && current === version) {
        const key = cacheKey(styleId, batchId), saved = cache.get(key)
        if (saved) cache.set(key, { ...saved, failed: true })
        const diagnostic = readFailureSchema.safeParse(error)
        publish({ error: true, failure: diagnostic.success ? diagnostic.data : { code: error instanceof z.ZodError ? 'invalid-response' : 'connection-unavailable' } })
      }
    }
    finally {
      if (controller === request) { controller = undefined; publish({ loading: false }); if (observers) timer = setTimeout(() => { void read('refresh', undefined, false, true) }, pollDelay()) }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    watch(styleId: string) {
      const reopening = observers++ === 0
      syncScope()
      if (state.styleId !== styleId || reopening) resumeView(selectView(styleId, state.styleId === styleId ? state.batchId : ''))
      return () => { if (--observers === 0) { cancel(); publish({ loading: false }) } }
    },
    select(batchId: string, styleId = state.styleId) { syncScope(); if (styleId !== state.styleId || batchId !== state.batchId) resumeView(selectView(styleId, batchId)); else if (!state.page) void read() },
    refresh() { syncScope(); invalidateCollection(state.styleId); cancel(); publish({ loading: false }); void read() },
    async detail(runId: string, signal: AbortSignal) {
      syncScope()
      const styleId = state.styleId, owner = ownerScope
      const value = searchBatchDetailSchema.parse(await dependencies.invoke('search-batch-detail', { styleId, runId }, signal))
      if (signal.aborted || disposed || owner !== dependencies.scope?.() || styleId !== state.styleId || value.runId !== runId) throw new DOMException('Batch detail read cancelled', 'AbortError')
      return value
    },
    more: () => read('more'), moreImages: (runId: string) => read('images', runId),
    async removeWorkflow(input: z.input<typeof workflowHistoryDeleteSchema>) {
      syncScope()
      if (disposed || state.deleting.length) throw new Error('workflow-delete-in-progress')
      const styleId = state.styleId, scope = scopeVersion, owner = ownerScope
      if (input.styleId !== styleId) throw new Error('workflow-delete-scope-changed')
      invalidateCollection(styleId); cancel(); publish({ deleting: [input.target.id], loading: false })
      try {
        const receipt = workflowHistoryReceiptSchema.parse(await dependencies.invoke('workflow-delete', input))
        if (disposed || scope !== scopeVersion || owner !== dependencies.scope?.()) throw new DOMException('Workflow removal scope changed', 'AbortError')
        const ids = new Set<string>(receipt.runIds), removed = state.page?.batches.filter(batch => ids.has(batch.runId)) ?? []
        invalidateCollection(styleId); cancel(); clearPages()
        publish({ batchId: ids.has(state.batchId) ? '' : state.batchId, page: state.page ? { ...state.page, batches: state.page.batches.filter(batch => !ids.has(batch.runId)), totalBatches: Math.max(0, state.page.totalBatches - removed.length), totalMatches: Math.max(0, state.page.totalMatches - removed.reduce((total, batch) => total + batch.matched, 0)) } : null, deleting: [], loading: false })
        void read('refresh', undefined, true)
        return receipt
      } finally {
        if (!disposed && scope === scopeVersion && owner === dependencies.scope?.()) publish({ deleting: [] })
      }
    },
    async remove(runId: string): Promise<void> {
      if (disposed || state.deleting.length) return
      syncScope()
      const styleId = state.styleId, scope = scopeVersion
      const owner = ownerScope
      invalidateCollection(styleId); cancel(); publish({ deleting: [runId], loading: false })
      try {
        const result = await dependencies.invoke('run-delete', { styleId, runId, operationId: crypto.randomUUID() })
        if (!result || typeof result !== 'object' || !('runId' in result) || result.runId !== runId || !('deleted' in result) || result.deleted !== true) throw new Error('invalid-batch-delete-response')
        if (disposed || scope !== scopeVersion || owner !== dependencies.scope?.()) return
        // 回执确认后清理旧分页，防止在途刷新或尾页合并把已删除批次重新带回列表。
        invalidateCollection(styleId); cancel(); clearPages()
        const removed = state.page?.batches.find(batch => batch.runId === runId)
        publish({ batchId: state.batchId === runId ? '' : state.batchId, page: state.page ? { ...state.page, batches: state.page.batches.filter(batch => batch.runId !== runId), totalBatches: Math.max(0, state.page.totalBatches - (removed ? 1 : 0)), totalMatches: Math.max(0, state.page.totalMatches - (removed?.matched ?? 0)) } : null, deleting: [], loading: false })
        await read('refresh', undefined, true)
      } finally {
        if (!disposed && scope === scopeVersion && owner === dependencies.scope?.()) {
          publish({ deleting: state.deleting.filter(id => id !== runId) })
          if (observers && !controller && !timer) timer = setTimeout(() => { void read('refresh', undefined, false, true) }, pollDelay())
        }
      }
    },
    reset() { scopeVersion++; ownerScope = dependencies.scope?.(); cancel(); cache.clear(); clearPages(); publish({ page: null, loading: false, error: false, deleting: [] }); if (observers) void read() },
    dispose() { disposed = true; scopeVersion++; cancel(); cache.clear(); listeners.clear() },
  }
}
/** Per-plugin observation owned and disposed by the entry registration. */
export type SearchBatchesStore = ReturnType<typeof createSearchBatchesStore>
