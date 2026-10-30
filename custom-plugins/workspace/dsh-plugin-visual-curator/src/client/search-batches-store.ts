/** A visible collection's read-only batch pages never change the workbench Session scope. */
import { searchBatchPageSchema, type SearchBatchPage } from '../shared/search-batches.ts'
import type { ClientTransport } from './store.ts'

/** Viewing state is separate from execution ownership and the active conversation. */
export interface SearchBatchesState { styleId: string; batchId: string; page: SearchBatchPage | null; loading: boolean; error: boolean; deleting: string[] }

interface CachedView { page: SearchBatchPage; firstPageToken: string | undefined; imageFirstTokens: Map<string, string | undefined>; cachedAt: number; resourceReadAt: number; expiresAt: number }

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
  const publish = (patch: Partial<SearchBatchesState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
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
  }
  async function read(mode: 'refresh' | 'more' | 'images' = 'refresh', runId?: string, replace = false): Promise<void> {
    syncScope()
    if (disposed || !state.styleId || controller) return
    if (timer) clearTimeout(timer); timer = undefined
    const current = ++version, scope = ownerScope, startedAt = now(), styleId = state.styleId, batchId = state.batchId, prior = state.page
    const imageBatch = prior?.batches.find(batch => batch.runId === runId)
    const pageToken = mode === 'more' ? prior?.nextPageToken : mode === 'images' ? imageBatch?.nextImagePageToken : undefined
    if (mode !== 'refresh' && !pageToken) return
    const request = new AbortController(); controller = request; publish({ loading: true, error: false })
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
        publish({ page: { ...prior, batches: prior.batches.map(batch => batch.runId === runId ? { ...updated, images: [...imageBatch.images, ...updated.images.filter(image => !ids.has(image.imageVersionId))] } : batch) } })
      } else {
        const ids = new Set(page.batches.map(batch => batch.runId))
        const retainTail = mode === 'refresh' && !replace && prior && !!firstPageToken && firstPageToken === page.nextPageToken
        let keptResources = mode === 'more' && !!prior || !!retainTail && prior.batches.some(batch => !ids.has(batch.runId))
        const batches = page.batches.map(batch => {
          const old = prior?.batches.find(item => item.runId === batch.runId)
          // 只有真实加载过后续页才合并尾部；完整响应中移除的批次或图片不能被旧缓存补回。
          const keepImages = mode === 'refresh' && old && !!imageFirstTokens.get(batch.runId) && imageFirstTokens.get(batch.runId) === batch.nextImagePageToken
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
        publish({ page: { ...fields, batches: mode === 'more' && prior ? [...prior.batches, ...batches.filter(batch => !prior.batches.some(old => old.runId === batch.runId))] : retainTail ? [...batches, ...prior.batches.filter(batch => !ids.has(batch.runId))] : batches, ...(next ? { nextPageToken: next } : {}) } })
      }
      remember()
    } catch (error) { if (!request.signal.aborted && !disposed && current === version) publish({ error: true }) }
    finally {
      if (controller === request) { controller = undefined; publish({ loading: false }); if (observers) timer = setTimeout(() => { void read() }, dependencies.pollMs()) }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    watch(styleId: string) {
      const reopening = observers++ === 0
      syncScope()
      if (state.styleId !== styleId || reopening) selectView(styleId, state.styleId === styleId ? state.batchId : '')
      void read()
      return () => { if (--observers === 0) { cancel(); publish({ loading: false }) } }
    },
    select(batchId: string, styleId = state.styleId) { syncScope(); if (styleId !== state.styleId || batchId !== state.batchId) selectView(styleId, batchId); void read() },
    refresh() { syncScope(); invalidateCollection(state.styleId); cancel(); publish({ loading: false }); void read() },
    more: () => read('more'), moreImages: (runId: string) => read('images', runId),
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
          if (observers && !controller && !timer) timer = setTimeout(() => { void read() }, dependencies.pollMs())
        }
      }
    },
    reset() { scopeVersion++; ownerScope = dependencies.scope?.(); cancel(); cache.clear(); clearPages(); publish({ page: null, loading: false, error: false, deleting: [] }); if (observers) void read() },
    dispose() { disposed = true; scopeVersion++; cancel(); cache.clear(); listeners.clear() },
  }
}
/** Per-plugin observation owned and disposed by the entry registration. */
export type SearchBatchesStore = ReturnType<typeof createSearchBatchesStore>
