/** Full-collection selection and bounded imports share the gallery's existing authenticated commands. */
import type { GalleryPage, GalleryPhoto } from '../shared/gallery.ts'
import type { CuratorStore } from './store.ts'
import type { ActionArgs } from './contract.ts'

/** Every selected photo keeps its outcome when a later batch fails or is stopped. */
export interface GalleryImportRow { photoId: string; status: 'queued' | 'processing' | 'registered' | 'imported' | 'failed' | 'unconfirmed' | 'skipped'; errorCode?: string }
type GalleryRead = (operation: string, args: ActionArgs, signal: AbortSignal) => Promise<unknown>
/** Remote registrations expose their current stage while retaining acknowledged batch receipts. */
export interface GalleryReferenceOptions { pollIntervalMs: number; controlTimeoutMs: number; onPhase?(phase: 'verifying' | 'referencing' | 'saving' | 'cancelling'): void }

/** Match a collection's titles and photographers without escaping into a global search.
 * @param photos Every loaded page of the same collection. @param query Space-separated text terms.
 * @returns Photos containing every normalized term.
 */
export function filterGalleryPhotos(photos: GalleryPhoto[], query: string): GalleryPhoto[] {
  const terms = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return terms.length ? photos.filter(photo => { const text = `${photo.title} ${photo.photographer} ${photo.id}`.normalize('NFKC').toLocaleLowerCase(); return terms.every(term => text.includes(term)) }) : photos
}

/** Read every collection page while publishing validated snapshots for progressive previews.
 * @param read Account-bound photo listing. @param options Selection limit, lifetime, counts and independent per-page preview arrays.
 * @returns Distinct photos in provider order; a failed traversal never returns an incomplete collection.
 */
export async function readCollectionPhotos(read: (cursor: string | null, signal: AbortSignal) => Promise<GalleryPage<GalleryPhoto>>, options: { maxFiles: number; signal: AbortSignal; onProgress?(count: number): void; onPage?(photos: GalleryPhoto[]): void }): Promise<GalleryPhoto[]> {
  const photos = new Map<string, GalleryPhoto>(), cursors = new Set<string>()
  let cursor: string | null = null
  do {
    options.signal.throwIfAborted()
    const page = await read(cursor, options.signal)
    options.signal.throwIfAborted()
    const before = photos.size
    for (const photo of page.items) photos.set(photo.id, photo)
    if (photos.size > options.maxFiles) throw Object.assign(new Error('gallery-reference-limit'), { code: 'gallery-reference-limit' })
    if (page.nextCursor && (cursors.has(page.nextCursor) || photos.size === before)) throw Object.assign(new Error('source-continuation-invalid'), { code: 'source-continuation-invalid' })
    options.onProgress?.(photos.size)
    options.onPage?.([...photos.values()])
    cursor = page.nextCursor
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return [...photos.values()]
}

/** Import a fixed, explicit selection using fresh revisions for each configured batch.
 * @param actions Existing workbench command store. @param input Account, target, learning role and selected IDs.
 * @param onRows Progress for the open dialog. @param signal Stops undispatched batches; an in-flight batch can still commit.
 * @param remote URL registration and its required Host progress/cancellation protocol; omission keeps explicit byte imports.
 * @returns Per-photo results. Unknown outcomes stop subsequent batches and must not be retried automatically.
 */
export async function importGalleryReferences(actions: Pick<CuratorStore, 'execute' | 'getSnapshot'> & { galleryRead?: GalleryRead }, input: { accountId?: string; styleId: string; photoIds: string[]; role: 'positive' | 'negative'; batchSize: number }, onRows: (rows: GalleryImportRow[]) => void, signal: AbortSignal, remote?: GalleryReferenceOptions): Promise<GalleryImportRow[]> {
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1) throw new Error('invalid-gallery-batch-size')
  if (remote && !actions.galleryRead) throw new Error('gallery-control-unavailable')
  const transferId = crypto.randomUUID()
  const rows: GalleryImportRow[] = [...new Set(input.photoIds)].map(photoId => ({ photoId, status: 'queued' }))
  const emit = () => onRows(rows.map(row => ({ ...row })))
  emit()
  for (let offset = 0; offset < rows.length && !signal.aborted; offset += input.batchSize) {
    const batch = rows.slice(offset, offset + input.batchSize)
    batch.forEach(row => { row.status = 'processing' }); emit()
    const progress = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, polling: Promise<void> = Promise.resolve(), cancelling: Promise<unknown> = Promise.resolve(), submitted = false
    const controlArgs = { transferId, ...(input.accountId ? { accountId: input.accountId } : {}) }
    const poll = async () => {
      try {
        const value = await actions.galleryRead!('gallery-import-progress', controlArgs, progress.signal)
        if (progress.signal.aborted || !value || typeof value !== 'object') return
        if (!signal.aborted && 'phase' in value && ['verifying', 'referencing', 'saving'].includes(String(value.phase))) remote?.onPhase?.(value.phase as 'verifying' | 'referencing' | 'saving')
        if ('rows' in value && Array.isArray(value.rows)) for (const item of value.rows) {
          if (!item || typeof item !== 'object' || !('name' in item) || !('ok' in item) || typeof item.ok !== 'boolean') continue
          const row = batch.find(row => row.photoId === item.name)
          if (row) row.status = item.ok ? 'registered' : 'failed'
        }
        emit()
      } catch (error) { /* 进度读取失败不重放写操作；最终状态仍以原请求回执为准。 */ }
      finally { if (!progress.signal.aborted) timer = setTimeout(() => { polling = poll() }, remote!.pollIntervalMs) }
    }
    const cancel = () => {
      remote?.onPhase?.('cancelling')
      cancelling = actions.galleryRead!('gallery-import-cancel', controlArgs, AbortSignal.timeout(remote!.controlTimeoutMs)).catch(() => { /* 取消请求不可确认时仍等待当前回执，且不再提交后续批次。 */ })
    }
    if (remote) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel() }
    try {
      const style = actions.getSnapshot().snapshot?.styles.find(item => item.styleId === input.styleId && !item.archived)
      if (!style) throw Object.assign(new Error('revision-conflict'), { code: 'revision-conflict' })
      if (remote && offset === 0) {
        // 旧 Host 会忽略新增 mode 字段；写入前确认控制协议，避免静默退回下载流程。
        try {
          const ready = await actions.galleryRead!('gallery-import-progress', controlArgs, AbortSignal.any([signal, AbortSignal.timeout(remote.controlTimeoutMs)]))
          if (!ready || typeof ready !== 'object' || !('state' in ready) || !['idle', 'active', 'cancelling', 'cancelled'].includes(String(ready.state)) || !('rows' in ready) || !Array.isArray(ready.rows)) throw new Error('invalid-gallery-reference-control')
        } catch (error) { throw Object.assign(new Error('gallery-reference-control-unavailable', { cause: error }), { code: 'gallery-reference-control-unavailable' }) }
      }
      if (signal.aborted) { batch.forEach(row => { row.status = 'skipped' }); break }
      if (remote) polling = poll()
      submitted = true
      const response = await actions.execute('gallery-import', { operationId: crypto.randomUUID(), ...(remote ? { mode: 'remote-reference', transferId } : {}), ...(input.accountId ? { accountId: input.accountId } : {}), styleId: input.styleId, expectedRevision: style.revision, role: input.role, photoIds: batch.map(row => row.photoId) })
      if (!response || typeof response !== 'object' || !('results' in response) || !Array.isArray(response.results) || response.results.length !== batch.length) throw new Error('invalid-gallery-import-response')
      // 先校验整批回执，再确认成功；无法识别的回执不能触发重复引用。
      const results = response.results.map((result: unknown, index: number) => {
        if (!result || typeof result !== 'object' || !('name' in result) || result.name !== batch[index]!.photoId || !('ok' in result) || typeof result.ok !== 'boolean') throw new Error('invalid-gallery-import-response')
        const error = 'error' in result ? result.error : null
        return { ok: result.ok, errorCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined }
      })
      results.forEach((result, index) => { batch[index]!.status = result.ok ? 'imported' : result.errorCode === 'cancelled' ? 'skipped' : 'failed'; if (result.errorCode) batch[index]!.errorCode = result.errorCode })
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string' ? failure.code : 'operation-failed'
      batch.forEach(row => { row.status = !submitted && signal.aborted ? 'skipped' : !submitted || ['revision-conflict', 'owner-denied', 'invalid-input'].includes(code) ? 'failed' : 'unconfirmed'; row.errorCode = code })
      break
    } finally { progress.abort(); clearTimeout(timer); if (remote) signal.removeEventListener('abort', cancel); await Promise.allSettled([polling, cancelling]) }
    emit()
  }
  rows.forEach(row => { if (row.status === 'queued') row.status = 'skipped' })
  emit()
  return rows
}
