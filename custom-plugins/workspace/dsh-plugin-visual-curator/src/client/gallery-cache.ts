/** Account-scoped metadata cache; image bytes and authorization inputs never enter persisted records. */
import type { ActionArgs } from './contract.ts'
import type { GalleryPage, GalleryPhoto, GalleryCollection } from '../shared/gallery.ts'
import type { GalleryCachePolicy } from '../shared/gallery-cache.ts'

type Page = GalleryPage<GalleryPhoto | GalleryCollection>
interface Entry { key: string; base: string; at: number; value: Page }
interface CachedEntry extends Entry { slot: number; bytes: number }
interface Context { namespace: string; revision: string; accounts: { id: string; userId: string; credentialRef: string }[]; policy: GalleryCachePolicy }
interface Pending { controller: AbortController; readers: Set<symbol>; promise: Promise<unknown> }
interface Dependencies {
  context(): Context
  read(operation: string, args: ActionArgs, signal: AbortSignal): Promise<unknown>
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>
  now?(): number
}
const storageKey = 'visual-curator.gallery-cache.v3'
const pageKey = (slot: number) => `${storageKey}.page.${slot}`
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const url = (value: unknown) => typeof value === 'string' && /^https?:\/\//i.test(value)
const optionalUrl = (value: unknown) => value === '' || url(value)
const text = (value: unknown) => typeof value === 'string'
const optionalPath = (value: unknown) => value === undefined || text(value)
function isPage(value: unknown, operation: string): value is Page {
  if (!record(value) || !Array.isArray(value.items) || !(value.nextCursor === null || text(value.nextCursor))) return false
  if (value.total !== undefined && (!Number.isSafeInteger(value.total) || Number(value.total) < 0)) return false
  return value.items.every((item: unknown) => {
    if (!record(item) || !text(item.id) || !text(item.title)) return false
    if (operation === 'gallery-collections') return Number.isSafeInteger(item.totalPhotos) && Number(item.totalPhotos) >= 0 && text(item.description) && typeof item.private === 'boolean' && (item.coverUrl === undefined || url(item.coverUrl)) && optionalPath(item.coverPath)
    if (operation !== 'gallery-photos') return false
    return Number.isSafeInteger(item.width) && Number(item.width) > 0 && Number.isSafeInteger(item.height) && Number(item.height) > 0 && url(item.thumbnailUrl) && url(item.referenceUrl) && optionalUrl(item.pageUrl) && text(item.photographer) && optionalUrl(item.photographerUrl) && typeof item.premium === 'boolean' && (item.originalUrl === undefined || url(item.originalUrl)) && optionalPath(item.thumbnailPath) && optionalPath(item.previewPath)
  })
}

/** Cache gallery listing pages across view remounts and same-tab reloads, with bounded per-page persistence.
 * @param dependencies Authenticated read callback, owner context, optional session storage and deterministic clock. Storage key enumeration repairs orphaned pages when available.
 * @returns A cancellable read adapter with explicit refresh and lifetime cleanup.
 */
export function createGalleryCache(dependencies: Dependencies) {
  const entries = new Map<string, CachedEntry>(), pending = new Map<string, Pending>(), stored = new Set<number>(), now = dependencies.now ?? Date.now, encoder = new TextEncoder()
  let identity = '', disposed = false, epoch = 0, retainedBytes = 0
  const removeStored = (slot: number) => { stored.delete(slot); try { dependencies.storage?.removeItem(pageKey(slot)) } catch (error) { /* 浏览器可能禁止会话缓存。 */ } }
  const clearStorage = (slots: Iterable<number> = stored) => {
    for (const slot of [...slots]) removeStored(slot)
    try {
      const storage = dependencies.storage
      // 索引损坏时也清除遗留分页；只提供基本存储适配器时依赖提交索引中的槽位记录。
      if (storage?.key && storage.length !== undefined) for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index)
        if (key?.startsWith(`${storageKey}.page.`)) storage.removeItem(key)
      }
      storage?.removeItem(storageKey)
    } catch (error) { /* 缓存清理失败不影响真实图库读取。 */ }
    stored.clear()
  }
  const drop = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key); retainedBytes -= entry.bytes; removeStored(entry.slot)
  }
  const indexValue = (persistedOnly: boolean, writing?: number) => JSON.stringify({ identity, pages: [...entries.values()].filter(entry => entry.slot !== writing && (!persistedOnly || stored.has(entry.slot))).map(entry => entry.slot), ...(writing === undefined ? {} : { writing }) })
  const trim = (context: Context, writing?: number) => {
    // 逐页字节只计算一次，容量检查不再序列化所有历史页。
    while (entries.size && (entries.size > context.policy.maxPages || retainedBytes + encoder.encode(indexValue(false, writing)).byteLength > context.policy.maxBytes)) drop(entries.keys().next().value!)
  }
  const persist = (context: Context, update?: { entry: CachedEntry; serialized: string }) => {
    trim(context, update?.entry.slot)
    if (!dependencies.storage) return
    if (!entries.size) { clearStorage(); return }
    const admitted = update && entries.get(update.entry.key) === update.entry ? update : undefined
    try {
      if (admitted) {
        // 先登记待写槽位，再写单页，最后发布索引；刷新不会读取尚未提交的分页。
        dependencies.storage.setItem(storageKey, indexValue(true, admitted.entry.slot))
        dependencies.storage.setItem(pageKey(admitted.entry.slot), admitted.serialized)
        stored.add(admitted.entry.slot)
      }
      dependencies.storage.setItem(storageKey, indexValue(true))
    } catch (error) { clearStorage(admitted ? new Set([...stored, admitted.entry.slot]) : stored) /* 配额不足时仅保留有界内存缓存。 */ }
  }
  const synchronize = (context: Context) => {
    const next = JSON.stringify([context.namespace, context.revision, context.accounts])
    if (next === identity) return
    identity = next; epoch++; entries.clear(); stored.clear(); retainedBytes = 0
    for (const request of pending.values()) request.controller.abort()
    pending.clear()
    try {
      // 丢弃旧版直连地址或整包缓存；新版本只保留有界分页元数据。
      dependencies.storage?.removeItem('visual-curator.gallery-cache.v1')
      dependencies.storage?.removeItem('visual-curator.gallery-cache.v2')
      const source = dependencies.storage?.getItem(storageKey)
      if (!source) { clearStorage(); return }
      if (encoder.encode(source).byteLength > context.policy.maxBytes) { clearStorage(); return }
      const saved: unknown = JSON.parse(source)
      if (!record(saved) || !Array.isArray(saved.pages) || !saved.pages.every(slot => Number.isSafeInteger(slot) && slot >= 0) || new Set(saved.pages).size !== saved.pages.length || saved.writing !== undefined && (!Number.isSafeInteger(saved.writing) || Number(saved.writing) < 0 || saved.pages.includes(saved.writing))) { clearStorage(); return }
      const slots = saved.pages as number[]
      if (saved.identity !== identity) { clearStorage(saved.writing === undefined ? slots : [...slots, Number(saved.writing)]); return }
      if (saved.writing !== undefined) removeStored(Number(saved.writing))
      for (const slot of slots) {
        let loaded = false
        try {
          const serialized = dependencies.storage?.getItem(pageKey(slot))
          if (!serialized || encoder.encode(serialized).byteLength > context.policy.maxBytes) continue
          const item: unknown = JSON.parse(serialized)
          if (!record(item) || typeof item.key !== 'string' || typeof item.base !== 'string' || typeof item.at !== 'number' || !Number.isFinite(item.at) || now() < item.at || now() - item.at >= context.policy.ttlMs) continue
          const base: unknown = JSON.parse(item.base), key: unknown = JSON.parse(item.key)
          if (!Array.isArray(base) || typeof base[0] !== 'string' || !Array.isArray(key) || key.length !== 2 || key[0] !== item.base || key[1] !== null && typeof key[1] !== 'string' || !isPage(item.value, base[0])) continue
          drop(item.key)
          const entry = { key: item.key, base: item.base, at: item.at, value: item.value, slot, bytes: encoder.encode(serialized).byteLength }
          entries.set(entry.key, entry); retainedBytes += entry.bytes; stored.add(slot); loaded = true; trim(context)
        } catch (error) { /* 单页损坏不会丢弃同一索引中的其他有效分页。 */ }
        finally { if (!loaded) removeStored(slot) }
      }
      persist(context)
    } catch (error) { clearStorage() /* 只丢弃无法解析的派生缓存，不影响图库的实际读取。 */ }
  }
  const read = async (operation: string, args: ActionArgs, signal: AbortSignal, options?: { refresh?: boolean }): Promise<unknown> => {
    signal.throwIfAborted()
    if (disposed) throw new DOMException('Gallery cache disposed', 'AbortError')
    if (!['gallery-collections', 'gallery-photos'].includes(operation)) {
      const result = await dependencies.read(operation, args, signal)
      if (operation === 'gallery-login-finish') { clearStorage(); identity = ''; epoch++; entries.clear(); retainedBytes = 0; for (const request of pending.values()) request.controller.abort(); pending.clear() }
      return result
    }
    const context = dependencies.context(); synchronize(context)
    // 只保留已知的列表参数；sessionToken、Cookie 和 API Key 绝不进入缓存键或持久化内容。
    const scope = record(args.scope) ? args.scope.kind === 'collection' ? { kind: 'collection', collectionId: args.scope.collectionId } : args.scope.kind === 'search' ? { kind: 'search', query: args.scope.query } : { kind: args.scope.kind } : null
    const base = JSON.stringify([operation, args.accountId ?? 'public', scope, args.pageSize ?? null])
    const key = JSON.stringify([base, args.cursor ?? null])
    if (options?.refresh) {
      for (const [id, entry] of entries) if (entry.base === base) drop(id)
      for (const [id, request] of pending) if (JSON.parse(id)[0] === base) { pending.delete(id); request.controller.abort() }
      persist(context)
    }
    const cached = entries.get(key)
    if (cached && now() >= cached.at && now() - cached.at < context.policy.ttlMs) { entries.delete(key); entries.set(key, cached); return cached.value }
    if (cached) drop(key)
    let request = pending.get(key)
    if (!request) {
      const controller = new AbortController(), generation = epoch
      const created: Pending = { controller, readers: new Set(), promise: Promise.resolve(undefined) }
      created.promise = Promise.resolve().then(() => dependencies.read(operation, options?.refresh ? { ...args, refreshIdentity: true } : args, controller.signal)).then(value => {
        if (!disposed && generation === epoch && !controller.signal.aborted && isPage(value, operation)) {
          const entry: Entry = { key, base, at: now(), value }, serialized = JSON.stringify(entry), used = new Set([...entries.values()].map(item => item.slot))
          let slot = 0; while (used.has(slot)) slot++
          const cached = { ...entry, slot, bytes: encoder.encode(serialized).byteLength }
          entries.set(key, cached); retainedBytes += cached.bytes; persist(context, { entry: cached, serialized })
        }
        return value
      }).finally(() => { if (pending.get(key) === created) pending.delete(key) })
      pending.set(key, created); request = created
    }
    const active = request, reader = Symbol(); active.readers.add(reader)
    return await new Promise((resolve, reject) => {
      const detach = () => { signal.removeEventListener('abort', abort); active.readers.delete(reader) }
      const abort = () => { detach(); if (!active.readers.size) { if (pending.get(key) === active) pending.delete(key); active.controller.abort() }; reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
      signal.addEventListener('abort', abort, { once: true })
      active.promise.then(value => { detach(); if (!signal.aborted) resolve(value) }, error => { detach(); if (!signal.aborted) reject(error) })
      if (signal.aborted) abort()
    })
  }
  return { read, dispose: () => { disposed = true; for (const request of pending.values()) request.controller.abort(); pending.clear(); entries.clear(); stored.clear(); retainedBytes = 0 } }
}
