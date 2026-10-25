/** Local image selection and bounded upload batches, independent of component lifetime. */
import type { ImportFileInput, LocalPathFile, SafeFailure } from './contract.ts'
import type { CuratorStore } from './store.ts'
import { encodeUpload } from './store.ts'

/** Browser-selected bytes and their display-only relative path; never a Host filesystem path. */
export interface LocalImageSource { file: Pick<File, 'name' | 'size' | 'type' | 'arrayBuffer'>; path: string }
type ReferenceImportInput = { styleId: string; role: ImportFileInput['role']; limits: { maxImportFiles: number; maxImportBytes: number } }
/** Localized reason keys are distinct from server diagnostics. */
export type ImportReason = 'unsupportedFile' | 'fileTooLarge' | 'emptyFile' | 'fileReadFailed' | 'invalidFile' | 'importRevisionConflict' | 'importStorageIssue' | 'importUnknown' | 'importStopped' | 'localPathRequired'
/** Each selected file retains its own outcome, including skipped files and unknown batch outcomes. */
export interface ImportRow { id: number; name: string; size: number; status: 'queued' | 'processing' | 'imported' | 'failed' | 'skipped' | 'unconfirmed'; reason?: ImportReason; error?: SafeFailure }
/** Browser directory entries are read asynchronously and may require multiple readEntries calls. */
export interface DroppedEntry {
  name: string
  isDirectory: boolean
  file?(success: (file: File) => void, failure?: (error: DOMException) => void): void
  createReader?(): { readEntries(success: (entries: DroppedEntry[]) => void, failure?: (error: DOMException) => void): void }
}

function mimeOf(source: { path: string; file: Pick<File, 'type'> }): string | undefined {
  const type = source.file.type.toLowerCase()
  if (['image/png', 'image/jpeg', 'image/webp'].includes(type)) return type
  if (['image/jpg', 'image/pjpeg'].includes(type) || /\.jpe?g$/i.test(source.path)) return 'image/jpeg'
  if (/\.png$/i.test(source.path)) return 'image/png'
  if (/\.webp$/i.test(source.path)) return 'image/webp'
  return undefined
}

/** Resolve selected Host paths and register references; image contents never pass through the browser upload API.
 * @param actions Authenticated store. @param input Human-selected original path and intent. @param onRows Per-file outcomes.
 * @param signal Stops undispatched registrations. @returns Registered, skipped and failed original paths.
 */
export async function importLocalPaths(actions: Pick<CuratorStore, 'execute' | 'getSnapshot'>, input: { path: string; kind: 'file' | 'folder'; styleId: string; role: ImportFileInput['role']; limits: { maxImportFiles: number; maxImportBytes: number } }, onRows: (rows: ImportRow[]) => void, signal?: AbortSignal): Promise<ImportRow[]> {
  const listed = await actions.execute('local-files-list', { path: input.path, kind: input.kind })
  return await registerLocalFiles(actions, input, listed, onRows, signal)
}

/** Select original paths through the Host system dialog, then register the selection without uploads.
 * @param actions Collection commands and refreshed revision. @param input Fixed collection and import intent.
 * @param pick One cancellable system chooser. @param onRows Per-file progress; cancellation retains previous results.
 * @param signal Page lifetime; a late selection cannot register files after navigation.
 * @returns Registration results, or an empty array on cancellation.
 */
export async function importPickedReferences(actions: Pick<CuratorStore, 'execute' | 'getSnapshot'>, input: ReferenceImportInput, pick: () => Promise<unknown>, onRows: (rows: ImportRow[]) => void, signal: AbortSignal): Promise<ImportRow[]> {
  const listed = await pick()
  if (signal.aborted || listed && typeof listed === 'object' && 'cancelled' in listed && listed.cancelled === true) return []
  return await registerLocalFiles(actions, input, listed, onRows, signal)
}

async function registerLocalFiles(actions: Pick<CuratorStore, 'execute' | 'getSnapshot'>, input: ReferenceImportInput, listed: unknown, onRows: (rows: ImportRow[]) => void, signal?: AbortSignal): Promise<ImportRow[]> {
  if (signal?.aborted) return []
  if (!listed || typeof listed !== 'object' || !('files' in listed) || !Array.isArray(listed.files)) throw new Error('invalid-local-file-list')
  const files: LocalPathFile[] = listed.files.map((file: unknown) => {
    if (!file || typeof file !== 'object' || !('path' in file) || typeof file.path !== 'string' || !('name' in file) || typeof file.name !== 'string' || !('size' in file) || typeof file.size !== 'number' || !('readable' in file) || typeof file.readable !== 'boolean') throw new Error('invalid-local-file-list')
    return { path: file.path, name: file.name, size: file.size, readable: file.readable }
  })
  const rows: ImportRow[] = files.map((file, id) => ({ id, name: file.path, size: file.size, status: 'queued' }))
  const emit = () => { if (!signal?.aborted) onRows(rows.map(row => ({ ...row }))) }
  const batches: number[][] = []; let batch: number[] = [], bytes = 0
  for (const row of rows) {
    const file = files[row.id]!
    if (!file.readable) { row.status = 'failed'; row.reason = 'fileReadFailed'; continue }
    if (!mimeOf({ path: file.name, file: { type: '' } })) { row.status = 'skipped'; row.reason = 'unsupportedFile'; continue }
    if (!file.size || file.size > input.limits.maxImportBytes) { row.status = 'failed'; row.reason = file.size ? 'fileTooLarge' : 'emptyFile'; continue }
    if (batch.length && (batch.length >= input.limits.maxImportFiles || bytes + file.size > input.limits.maxImportBytes)) { batches.push(batch); batch = []; bytes = 0 }
    batch.push(row.id); bytes += file.size
  }
  if (batch.length) batches.push(batch)
  emit()
  for (const ids of batches) {
    if (signal?.aborted) break
    for (const id of ids) rows[id]!.status = 'processing'
    emit()
    try {
      const style = actions.getSnapshot().snapshot?.styles.find(style => style.styleId === input.styleId && !style.archived)
      if (!style) throw { code: 'revision-conflict' }
      const result = await actions.execute('reference-local-import', { operationId: crypto.randomUUID(), styleId: input.styleId, expectedRevision: style.revision, role: input.role, files: ids.map(id => ({ path: files[id]!.path, name: files[id]!.name })) })
      for (const [index, outcome] of batchResults(result, ids.map(id => files[id]!.path)).entries()) {
        const row = rows[ids[index]!]!; row.status = outcome.ok ? 'imported' : 'failed'
        if (outcome.error) { row.error = outcome.error; row.reason = reasonOf(outcome.error) }
      }
    } catch (failure) {
      const error = safeImportFailure(failure)
      for (const id of ids) { rows[id]!.status = ['revision-conflict', 'invalid-input', 'owner-denied'].includes(error.code) ? 'failed' : 'unconfirmed'; rows[id]!.error = error; rows[id]!.reason = reasonOf(error) }
      break
    }
    emit()
  }
  for (const row of rows) if (row.status === 'queued' || row.status === 'processing') { row.status = 'skipped'; row.reason = 'importStopped' }
  emit()
  return rows
}

function safeImportFailure(value: unknown): SafeFailure {
  if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string') {
    return { code: value.code, stage: 'stage' in value && typeof value.stage === 'string' ? value.stage : 'import', retryable: false,
      safeMessage: 'safeMessage' in value && typeof value.safeMessage === 'string' ? value.safeMessage : '', suggestedAction: 'suggestedAction' in value && typeof value.suggestedAction === 'string' ? value.suggestedAction : '' }
  }
  return { code: 'operation-failed', stage: 'import', retryable: false, safeMessage: '', suggestedAction: '' }
}
function reasonOf(error: SafeFailure): ImportReason {
  switch (error.code) {
    case 'invalid-input': return 'invalidFile'
    case 'revision-conflict': case 'operation-conflict': return 'importRevisionConflict'
    case 'budget-exhausted': case 'storage-commit-failed': case 'reference-unavailable': return 'importStorageIssue'
    default: return 'importUnknown'
  }
}
function batchResults(value: unknown, names: string[]): { ok: boolean; error?: SafeFailure }[] {
  if (!value || typeof value !== 'object' || !('results' in value) || !Array.isArray(value.results) || value.results.length !== names.length) throw new Error('invalid-import-response')
  return value.results.map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || !('name' in item) || item.name !== names[index] || !('ok' in item) || typeof item.ok !== 'boolean') throw new Error('invalid-import-response')
    return { ok: item.ok, ...(!item.ok ? { error: safeImportFailure('error' in item ? item.error : undefined) } : {}) }
  })
}

/** Traverse only user-dropped entries, retaining all subdirectories and every reader page.
 * @param entries Entries captured synchronously during drop. @param fallback Files from browsers without directory entries.
 * @param signal Component lifetime. @returns Selected files with relative paths, without reading their contents.
 */
export async function droppedImageSources(entries: readonly (DroppedEntry | null)[], fallback: readonly File[], signal?: AbortSignal): Promise<LocalImageSource[]> {
  const sources: LocalImageSource[] = []
  async function walk(entry: DroppedEntry, parent: string): Promise<void> {
    signal?.throwIfAborted()
    const path = parent ? `${parent}/${entry.name}` : entry.name
    if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader()
      while (true) {
        const children = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!children.length) break
        for (const child of children) await walk(child, path)
      }
    } else if (entry.file) sources.push({ path, file: await new Promise<File>((resolve, reject) => entry.file!(resolve, reject)) })
    else throw new Error('unreadable-drop-entry')
  }
  if (entries.length && entries.every((entry): entry is DroppedEntry => entry !== null)) for (const entry of entries) await walk(entry, '')
  else for (const file of fallback) sources.push({ file, path: file.webkitRelativePath || file.name })
  return sources
}

/** Upload bounded batches using the revision refreshed after each committed action.
 * @param actions Authenticated store commands and refreshed state. @param input Fixed selection, collection and deployment limits.
 * @param onRows Per-file progress; no callbacks occur after cancellation. @param signal Stops undispatched batches on unmount.
 * @returns All outcomes; a failed/unknown batch stops later work without retrying accepted files.
 */
export async function importLocalImages(actions: Pick<CuratorStore, 'execute' | 'getSnapshot'>, input: { styleId: string; role: ImportFileInput['role']; files: readonly LocalImageSource[]; limits: { maxImportFiles: number; maxImportBytes: number } }, onRows: (rows: ImportRow[]) => void, signal?: AbortSignal): Promise<ImportRow[]> {
  const rows: ImportRow[] = input.files.map((source, id) => ({ id, name: source.path, size: source.file.size, status: 'queued' }))
  const emit = () => { if (!signal?.aborted) onRows(rows.map(row => ({ ...row }))) }
  const batches: number[][] = []
  let batch: number[] = [], bytes = 0
  for (const row of rows) {
    const source = input.files[row.id]!
    if (!mimeOf(source)) { row.status = 'skipped'; row.reason = 'unsupportedFile'; continue }
    if (!row.size || row.size > input.limits.maxImportBytes) { row.status = 'failed'; row.reason = row.size ? 'fileTooLarge' : 'emptyFile'; continue }
    if (batch.length && (batch.length >= input.limits.maxImportFiles || bytes + row.size > input.limits.maxImportBytes)) { batches.push(batch); batch = []; bytes = 0 }
    batch.push(row.id); bytes += row.size
  }
  if (batch.length) batches.push(batch)
  emit()
  for (const ids of batches) {
    if (signal?.aborted) break
    for (const id of ids) rows[id]!.status = 'processing'
    emit()
    const payload: ImportFileInput[] = [], uploadIds: number[] = []
    for (const id of ids) {
      if (signal?.aborted) break
      const source = input.files[id]!, row = rows[id]!
      try {
        const content = await source.file.arrayBuffer()
        if (content.byteLength !== source.file.size) throw new Error('changed-file')
        payload.push({ name: source.path, mime: mimeOf(source)!, base64: encodeUpload(new Uint8Array(content)), role: input.role, intent: 'overall', dimensions: [] }); uploadIds.push(id)
      } catch (error) { row.status = 'failed'; row.reason = 'fileReadFailed' }
    }
    if (signal?.aborted) break
    if (payload.length) {
      try {
        const style = actions.getSnapshot().snapshot?.styles.find(style => style.styleId === input.styleId && !style.archived)
        if (!style) throw { code: 'revision-conflict' }
        const result = await actions.execute('reference-import', { operationId: crypto.randomUUID(), styleId: input.styleId, expectedRevision: style.revision, bytesAllowed: false, files: payload.map(file => ({ ...file })) })
        for (const [index, resultRow] of batchResults(result, payload.map(file => file.name)).entries()) {
          const row = rows[uploadIds[index]!]!
          row.status = resultRow.ok ? 'imported' : 'failed'
          if (resultRow.error) { row.error = resultRow.error; row.reason = reasonOf(resultRow.error) }
        }
      } catch (failure) {
        const error = safeImportFailure(failure)
        for (const id of uploadIds) { const row = rows[id]!; row.status = ['revision-conflict', 'owner-denied', 'invalid-input'].includes(error.code) ? 'failed' : 'unconfirmed'; row.error = error; row.reason = reasonOf(error) }
        break
      }
    }
    emit()
  }
  for (const row of rows) if (row.status === 'queued' || row.status === 'processing') { row.status = 'skipped'; row.reason = 'importStopped' }
  emit()
  return rows
}
