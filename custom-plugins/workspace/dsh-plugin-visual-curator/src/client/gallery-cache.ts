/** Account-scoped metadata cache; image bytes and authorization inputs never enter persisted records. */
import type { ActionArgs } from './contract.ts'
import type { GalleryPage, GalleryPhoto, GalleryCollection } from '../shared/gallery.ts'
import type { GalleryCachePolicy } from '../shared/gallery-cache.ts'

type Page = GalleryPage<GalleryPhoto | GalleryCollection>
interface Entry { key: string; base: string; at: number; value: Page }
interface Context { namespace: string; revision: string; accounts: { id: string; userId: string; credentialRef: string }[]; policy: GalleryCachePolicy }
interface Pending { controller: AbortController; readers: Set<symbol>; promise: Promise<unknown> }
interface Dependencies {
  context(): Context
  read(operation: string, args: ActionArgs, signal: AbortSignal): Promise<unknown>
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  now?(): number
}
const storageKey = 'visual-curator.gallery-cache.v2'
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

/** Cache gallery listing pages across view remounts and same-tab reloads.
 * @param dependencies Authenticated read callback, owner context, optional session storage and deterministic clock.
 * @returns A cancellable read adapter with explicit refresh and lifetime cleanup.
 */
export function createGalleryCache(dependencies: Dependencies) {
  const entries = new Map<string, Entry>(), pending = new Map<string, Pending>(), now = dependencies.now ?? Date.now
  let identity = '', disposed = false, epoch = 0
  const persist = (context: Context) => {
    const serialize = () => JSON.stringify({ identity, entries: [...entries.values()] })
    let saved = serialize()
    // 内存与持久化共享容量上限，浏览器禁用 sessionStorage 时仍须驱逐旧分页。
    while (entries.size && (entries.size > context.policy.maxPages || new TextEncoder().encode(saved).byteLength > context.policy.maxBytes)) { entries.delete(entries.keys().next().value!); saved = serialize() }
    if (!dependencies.storage) return
    if (new TextEncoder().encode(saved).byteLength > context.policy.maxBytes) { try { dependencies.storage.removeItem(storageKey) } catch (error) { /* 浏览器可能禁止会话缓存。 */ }; return }
    try { dependencies.storage.setItem(storageKey, saved) } catch (error) { /* 缓存持久化受浏览器配额限制时，内存缓存仍可用。 */ }
  }
  const synchronize = (context: Context) => {
    const next = JSON.stringify([context.namespace, context.revision, context.accounts])
    if (next === identity) return
    identity = next; epoch++; entries.clear()
    for (const request of pending.values()) request.controller.abort()
    pending.clear()
    try {
      // 旧版本只有直连图片地址；丢弃派生缓存以重新获取 Host 预览路径，原图库数据不受影响。
      dependencies.storage?.removeItem('visual-curator.gallery-cache.v1')
      const source = dependencies.storage?.getItem(storageKey)
      if (!source || new TextEncoder().encode(source).byteLength > context.policy.maxBytes) return
      const saved: unknown = JSON.parse(source)
      if (!record(saved) || saved.identity !== identity || !Array.isArray(saved.entries)) return
      for (const item of saved.entries.slice(-context.policy.maxPages)) if (record(item) && text(item.key) && text(item.base) && typeof item.at === 'number' && Number.isFinite(item.at) && now() >= item.at && now() - item.at < context.policy.ttlMs && isPage(item.value, JSON.parse(item.base as string)[0])) entries.set(item.key as string, { key: item.key as string, base: item.base as string, at: item.at, value: item.value })
    } catch (error) { /* 只丢弃无法解析的派生缓存，不影响图库的实际读取。 */ }
  }
  const read = async (operation: string, args: ActionArgs, signal: AbortSignal, options?: { refresh?: boolean }): Promise<unknown> => {
    signal.throwIfAborted()
    if (disposed) throw new DOMException('Gallery cache disposed', 'AbortError')
    if (!['gallery-collections', 'gallery-photos'].includes(operation)) {
      const result = await dependencies.read(operation, args, signal)
      if (operation === 'gallery-login-finish') { identity = ''; epoch++; entries.clear(); for (const request of pending.values()) request.controller.abort(); pending.clear(); try { dependencies.storage?.removeItem(storageKey) } catch (error) { /* 浏览器可能禁止 sessionStorage。 */ } }
      return result
    }
    const context = dependencies.context(); synchronize(context)
    // 只保留已知的列表参数；sessionToken、Cookie 和 API Key 绝不进入缓存键或持久化内容。
    const scope = record(args.scope) ? args.scope.kind === 'collection' ? { kind: 'collection', collectionId: args.scope.collectionId } : args.scope.kind === 'search' ? { kind: 'search', query: args.scope.query } : { kind: args.scope.kind } : null
    const base = JSON.stringify([operation, args.accountId ?? 'public', scope, args.pageSize ?? null])
    const key = JSON.stringify([base, args.cursor ?? null])
    if (options?.refresh) {
      for (const [id, entry] of entries) if (entry.base === base) entries.delete(id)
      for (const [id, request] of pending) if (JSON.parse(id)[0] === base) { pending.delete(id); request.controller.abort() }
      persist(context)
    }
    const cached = entries.get(key)
    if (cached && now() >= cached.at && now() - cached.at < context.policy.ttlMs) { entries.delete(key); entries.set(key, cached); return cached.value }
    if (cached) entries.delete(key)
    let request = pending.get(key)
    if (!request) {
      const controller = new AbortController(), generation = epoch
      const created: Pending = { controller, readers: new Set(), promise: Promise.resolve(undefined) }
      created.promise = Promise.resolve().then(() => dependencies.read(operation, options?.refresh ? { ...args, refreshIdentity: true } : args, controller.signal)).then(value => {
        if (!disposed && generation === epoch && !controller.signal.aborted && isPage(value, operation)) { entries.set(key, { key, base, at: now(), value }); persist(context) }
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
  return { read, dispose: () => { disposed = true; for (const request of pending.values()) request.controller.abort(); pending.clear(); entries.clear() } }
}
