/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** A collection-free page owns direct batches, explicit original selection and exact image navigation. */
import { z } from 'zod'
import { CuratorError } from '../shared/errors.ts'
import type { WorkbenchProps } from './workbench.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import type { ConfigurationView, Json } from './contract.ts'
import { directCropBatchSchema, type DirectCropBatch, type DirectCropStart } from '../shared/direct-crop.ts'
import { createServerQueue } from './server-queue.tsx'
import { createGalleryReferenceDialog } from './gallery-reference-dialog.tsx'
import { createDirectCropCanvas } from './direct-crop-canvas.tsx'
import { serverImportViewSchema, type ServerImportView } from '../shared/server-queue.ts'
import { defaultImageModel, imageModelsForRoute, imageOptionsSchema, imageRouteReady, type ImageOptions } from './image-sources.ts'
import { createSelectField } from './select-field.tsx'

/** Direct UI operations remain authenticated native actions, not a public server API. */
export type DirectCropInvoke = (operation: string, args: Record<string, Json>, signal?: AbortSignal) => Promise<unknown>
type DirectSelection = Exclude<DirectCropStart['source'], { kind: 'server' }>
type RemovalRow = DirectCropBatch | (ServerImportView & { importOnly: true })
type Removal = { mode: 'single' | 'selected' | 'all'; rows: RemovalRow[]; removed: number }
const routeSchema = z.object({ runId: z.string(), imageVersionId: z.string().optional() })
const listSchema = z.object({ batches: z.array(directCropBatchSchema), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().optional(), imports: z.array(serverImportViewSchema).default([]) })
const pickedSchema = z.object({ files: z.array(z.object({ path: z.string().min(1), name: z.string().min(1), size: z.number().int().nonnegative().optional(), readable: z.boolean().optional() })), cancelled: z.boolean().optional() })
const failureSchema = z.object({ code: z.string(), stage: z.string() })
const sizeLabel = (bytes: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1_048_576) + ' MiB'
function directCropFailure(t: WorkbenchText, failure: unknown, fallback: 'directCropPickError' | 'directCropStartError' | 'directCropExportError' | 'directCropReadError' | 'directCropDeleteError' | 'directCropDeletePrepareError'): string {
  const parsed = failureSchema.safeParse(failure)
  if (!parsed.success) return t(fallback)
  const { code, stage } = parsed.data
  if (fallback === 'directCropDeletePrepareError') return t(stage === 'direct-crop-delete-preview' && code === 'constraint-conflict' ? 'directCropListChanged' : fallback)
  if (fallback === 'directCropDeleteError') return t(code === 'constraint-conflict' ? 'directCropDeleteStopFirst' : fallback)
  if (code === 'invalid-input' && stage === 'media') return t('directCropInvalidImage')
  if (code === 'configuration-required') return t('directCropModelRequired')
  if (code === 'capability-unavailable') return t('directCropPickerUnavailable')
  if (code === 'reference-unavailable' || code === 'owner-denied') return t('directCropUnreadable')
  if (code === 'budget-exhausted') return t('directCropBudgetError')
  if (code === 'cancelled') return t('directCropCancelled')
  return t(fallback)
}
const settled = (batch: DirectCropBatch) => batch.removable
const running = (status: string) => ['created', 'running', 'pausing', 'cancelling'].includes(status)

/** @param scope Current profile identity. @returns Profile-local page preference key. */
export function directCropWorkspaceKey(scope: string): string { return `visual-curator:workspace-mode:${scope}` }
/** @param scope Current profile identity. @returns Saved page preference without any task or network side effect. */
export function directCropVisible(scope: string): boolean {
  try { return window.localStorage.getItem(directCropWorkspaceKey(scope)) === 'direct' }
  catch (error) { return false }
}

/** @param React Shared Host runtime. @param ui Existing project primitives. @returns Direct workbench and source picker. */
export function createDirectCropPage(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const ServerQueue = createServerQueue(React, ui), Canvas = createDirectCropCanvas(React, ui), GalleryPicker = createGalleryReferenceDialog(React, ui)
  const SelectField = createSelectField(React, ui)
  const { Button, Modal, Input, Tag, StateDot, Checkbox, Menu } = ui
  return function DirectCropPage({ configuration, actions, t, onBack, onManageAccounts }: { configuration: ConfigurationView; actions: WorkbenchProps['actions']; t: WorkbenchText; onBack(): void; onManageAccounts(): void }) {
    const scope = actions.directScope!(), key = `visual-curator:direct-route:${scope}`, invoke = actions.directCrop!
    const [route, setRoute] = React.useState<z.infer<typeof routeSchema>>(() => {
      try { return routeSchema.parse(JSON.parse(window.localStorage.getItem(key) ?? '{}')) }
      catch (error) { return { runId: '' } }
    })
    const [batches, setBatches] = React.useState<DirectCropBatch[]>([]), [nextOffset, setNextOffset] = React.useState<number | undefined>(), [loading, setLoading] = React.useState(true), [readError, setReadError] = React.useState(''), [error, setError] = React.useState('')
    const [imports, setImports] = React.useState<ServerImportView[]>([])
    const [localDetails, setLocalDetails] = React.useState(new Map<string, z.infer<typeof pickedSchema>['files'][number]>())
    const retryAction = React.useRef<'local' | 'export' | 'more' | null>(null)
    const [selection, setSelection] = React.useState<DirectSelection | null>(null), [importMenuOpen, setImportMenuOpen] = React.useState(false), [serverOpen, setServerOpen] = React.useState(false), [galleryOpen, setGalleryOpen] = React.useState(false), [name, setName] = React.useState(''), [busy, setBusy] = React.useState(false)
    const [imageRoute, setImageRoute] = React.useState(configuration.wallpaperImage), [imageOptions, setImageOptions] = React.useState<ImageOptions | null>(null)
    const [exported, setExported] = React.useState<{ directory: string; files: number; excluded: number } | null>(null), [revision, refresh] = React.useState(0)
    const alive = React.useRef(true), lifetime = React.useRef(new AbortController()), request = React.useRef<{ value: string; operationId: string } | null>(null)
    const [checkedIds, setCheckedIds] = React.useState(new Set<string>()), [batchTotal, setBatchTotal] = React.useState(0)
    const [deleteTarget, setDeleteTarget] = React.useState<Removal | null>(null), [deleteError, setDeleteError] = React.useState(''), [deleteNotice, setDeleteNotice] = React.useState('')
    const [preparingAll, setPreparingAll] = React.useState(false), [deleteProgress, setDeleteProgress] = React.useState({ done: 0, total: 0 })
    const [deleteFailures, setDeleteFailures] = React.useState<{ runId: string; name: string; message: string }[]>([])
    const deleteRequests = React.useRef(new Map<string, string>()), listVersion = React.useRef(0)
    const loadedPages = React.useRef(new Set<number>())
    const selectedId = React.useRef(route.runId); selectedId.current = route.runId
    const batch = batches.find(item => item.runId === route.runId)
    const currentImport = imports.find(item => item.runId === route.runId)
    const savedImports = imports.reduce((sum, item) => sum + item.saved, 0), totalImports = imports.reduce((sum, item) => sum + item.total, 0)
    React.useEffect(() => { if (currentImport) { setRoute({ runId: '' }) } }, [currentImport?.runId])
    React.useEffect(() => { try { window.localStorage.setItem(key, JSON.stringify(route)) } catch (failure) { /* Saved tasks remain available when view preferences cannot be stored. */ } }, [key, route])
    React.useEffect(() => {
      const controller = new AbortController(); lifetime.current = controller; alive.current = true
      return () => { alive.current = false; controller.abort() }
    }, [])
    React.useEffect(() => {
      if (!selection) return
      const controller = new AbortController()
      void invoke('wallpaper-options', {}, controller.signal).then(value => { if (!controller.signal.aborted) setImageOptions(imageOptionsSchema.parse(value)) }).catch(() => { if (!controller.signal.aborted) setImageOptions(null) })
      return () => controller.abort()
    }, [!!selection, invoke])
    React.useEffect(() => {
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, reading = false
      const read = async () => {
        if (reading || document.hidden || controller.signal.aborted) return
        reading = true
        const version = listVersion.current
        try {
          const reply = listSchema.parse(await invoke('direct-crop-list', {}, controller.signal))
          let rows = reply.batches
          if (selectedId.current && !rows.some(item => item.runId === selectedId.current)) {
            const selected = listSchema.parse(await invoke('direct-crop-list', { runId: selectedId.current }, controller.signal))
            rows = [...rows, ...selected.batches]
          }
          if (controller.signal.aborted || version !== listVersion.current) return
          setBatches(previous => { const merged = loadedPages.current.size ? [...rows, ...previous.filter(item => !rows.some(row => row.runId === item.runId))] : rows; return JSON.stringify(previous) === JSON.stringify(merged) ? previous : merged }); setNextOffset(previous => loadedPages.current.size ? previous : reply.nextOffset); setReadError(''); setLoading(false); setBatchTotal(reply.total)
          setImports(previous => JSON.stringify(previous) === JSON.stringify(reply.imports) ? previous : reply.imports)
          if (reply.imports.some(item => item.status === 'importing') || rows.some(item => running(item.wallpaper?.status ?? item.status))) timer = setTimeout(() => { void read() }, configuration.limits.pollIntervalMs)
        } catch (failure) { if (!controller.signal.aborted) { setReadError(directCropFailure(t, failure, 'directCropReadError')); setLoading(false) } }
        finally { reading = false }
      }
      const visible = () => { clearTimeout(timer); if (!document.hidden) void read() }
      document.addEventListener('visibilitychange', visible); void read()
      return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
    }, [invoke, revision, configuration.limits.pollIntervalMs, t])
    const choose = (source: DirectSelection) => { request.current = null; retryAction.current = null; setLocalDetails(new Map()); setImageRoute(configuration.wallpaperImage); setImageOptions(null); setSelection(source); setName(`${t('directCropDefaultName')} ${new Date().toLocaleString()}`); setGalleryOpen(false); setError('') }
    const local = async () => {
      if (busy) return
      setBusy(true); setError(''); retryAction.current = 'local'
      try {
        const picked = pickedSchema.parse(await actions.pickLocalReferences('file', lifetime.current.signal, t('directCropChoosePhotos')))
        if (!alive.current || picked.cancelled || !picked.files.length) return
        if (picked.files.length > configuration.limits.maxImportFiles) { setError(t('directCropLimit').replace('{count}', String(configuration.limits.maxImportFiles))); return }
        choose({ kind: 'local', files: picked.files.map(({ path, name }) => ({ path, name })) }); setLocalDetails(new Map(picked.files.map(file => [file.path, file])))
      } catch (failure) { if (alive.current) setError(directCropFailure(t, failure, 'directCropPickError')) }
      finally { if (alive.current) setBusy(false) }
    }
    const start = async () => {
      if (!selection || busy || !name.trim() || files.some(file => !!file.issue)) return
      const input = { name: name.trim(), source: selection, imageRoute }, value = JSON.stringify(input)
      if (request.current?.value !== value) request.current = { value, operationId: `direct-crop:${crypto.randomUUID()}` }
      setBusy(true); setError('')
      try {
        const accepted = z.object({ runId: z.string() }).parse(await invoke('direct-crop-start', { ...input, operationId: request.current.operationId }, lifetime.current.signal))
        if (!alive.current) return
        setRoute({ runId: accepted.runId }); setSelection(null); refresh(current => current + 1)
      } catch (failure) { if (alive.current) setError(directCropFailure(t, failure, 'directCropStartError')) }
      finally { if (alive.current) setBusy(false) }
    }
    const exportBatch = async () => {
      if (!batch?.wallpaper || busy) return
      setBusy(true); setError(''); retryAction.current = 'export'
      try {
        const reply = z.union([z.object({ cancelled: z.literal(true) }), z.object({ directory: z.string(), files: z.number(), excluded: z.number() })]).parse(await invoke('direct-crop-export', { runId: batch.wallpaper.runId, title: t('directCropExportTitle') }, lifetime.current.signal))
        if (alive.current && 'directory' in reply) setExported(reply)
      } catch (failure) { if (alive.current) setError(directCropFailure(t, failure, 'directCropExportError')) }
      finally { if (alive.current) setBusy(false) }
    }
    const retryImport = async (runId: string) => {
      if (busy) return
      setBusy(true); setError('')
      try { await invoke('server-queue-import-retry', { runId }, lifetime.current.signal); if (alive.current) { setLoading(true); refresh(value => value + 1) } }
      catch (failure) { if (alive.current) setError(t('serverImportRetryFailed')) }
      finally { if (alive.current) setBusy(false) }
    }
    const reloadBatches = () => { loadedPages.current.clear(); setNextOffset(undefined); refresh(current => current + 1) }
    const importRows = imports.map(item => ({...item,importOnly:true as const})), allRows:RemovalRow[]=[...batches,...importRows]
    const canRemove = (row: RemovalRow) => {
      if ('importOnly' in row) return (imports.find(item=>item.runId===row.runId)?.status ?? row.status)!=='importing'
      const current = batches.find(item => item.runId === row.runId)
      return settled(row) && (!current || settled(current))
    }
    const checkedRows = allRows.filter(row => checkedIds.has(row.runId)), selectable = allRows.filter(row=>!('importOnly' in row)||canRemove(row)), allChecked = selectable.length > 0 && selectable.every(row=>checkedIds.has(row.runId))
    React.useEffect(() => { setCheckedIds(current => { const next = new Set([...current].filter(id => allRows.some(row => row.runId === id))); return next.size === current.size ? current : next }) }, [batches, imports])
    const checkRow = (runId: string, checked: boolean) => setCheckedIds(current => { const next = new Set(current); if (checked) next.add(runId); else next.delete(runId); return next })
    const checkVisible = (checked: boolean) => setCheckedIds(current => { const next = new Set(current); for (const row of selectable) { if (checked) next.add(row.runId); else next.delete(row.runId) } return next })
    const openRemoval = (mode: Removal['mode'], rows: RemovalRow[]) => { setDeleteTarget({ mode, rows, removed: 0 }); setDeleteError(''); setDeleteNotice(''); setDeleteFailures([]); setDeleteProgress({ done: 0, total: 0 }) }
    const closeDelete = () => { if (!busy) { setDeleteTarget(null); setDeleteError(''); setDeleteFailures([]) } }
    const prepareAll = async () => {
      if (busy) return
      setBusy(true); setPreparingAll(true); setDeleteError(''); setDeleteNotice('')
      const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(configuration.limits.deadlineMs)])
      try {
        const read = async (offset: number) => listSchema.parse(await invoke('direct-crop-list', { offset }, signal))
        const first = await read(0), rows = [...first.batches], cursors = new Set([0])
        let offset = first.nextOffset
        while (offset !== undefined) {
          if (cursors.has(offset)) throw new CuratorError('constraint-conflict', 'direct-crop-delete-preview', 'The batch list changed during removal preparation.')
          cursors.add(offset)
          const page = await read(offset)
          if (page.total !== first.total || page.nextOffset !== undefined && page.nextOffset <= offset) throw new CuratorError('constraint-conflict', 'direct-crop-delete-preview', 'The batch list changed during removal preparation.')
          rows.push(...page.batches); offset = page.nextOffset
        }
        const unique = [...new Map(rows.map(row => [row.runId, row])).values()], latest = await read(0)
        if (unique.length !== first.total || latest.total !== first.total || latest.batches.map(row => row.runId).join(':') !== first.batches.map(row => row.runId).join(':')) throw new CuratorError('constraint-conflict', 'direct-crop-delete-preview', 'The batch list changed during removal preparation.')
        if (alive.current) { if (unique.length || first.imports.length) openRemoval('all', [...unique,...first.imports.map(item=>({...item,importOnly:true as const}))]); else { setDeleteError(t('directCropDeleteNone')); reloadBatches() } }
      } catch (failure) { if (alive.current) setDeleteError(directCropFailure(t, failure, 'directCropDeletePrepareError')) }
      finally { if (alive.current) { setBusy(false); setPreparingAll(false) } }
    }
    const removableRows = deleteTarget?.rows.filter(canRemove) ?? [], retainedRows = deleteTarget?.rows.filter(row => !canRemove(row)) ?? []
    const removeBatch = async () => {
      const target = deleteTarget
      if (!target || busy) return
      const eligible = target.rows.filter(canRemove)
      if (!eligible.length) { setDeleteError(t('directCropDeleteStopFirst')); return }
      ++listVersion.current; setBusy(true); setDeleteError(''); setDeleteFailures([]); setDeleteProgress({ done: 0, total: eligible.length })
      const removed = new Set<string>(), blocked = new Set<string>(), failures: { runId: string; name: string; message: string }[] = []
      try {
        for (const row of eligible) {
          lifetime.current.signal.throwIfAborted()
          let operationId = deleteRequests.current.get(row.runId)
          if (!operationId) { operationId = 'direct-crop-delete:' + crypto.randomUUID(); deleteRequests.current.set(row.runId, operationId) }
          try {
            z.strictObject({ runId: z.literal(row.runId), deleted: z.literal(true) }).parse(await invoke('importOnly' in row ? 'server-queue-import-delete' : 'direct-crop-delete', { runId: row.runId, operationId }, lifetime.current.signal))
            removed.add(row.runId)
          } catch (failure) {
            failures.push({ runId: row.runId, name: row.name, message: directCropFailure(t, failure, 'directCropDeleteError') })
            const parsed = failureSchema.safeParse(failure)
            if (parsed.success && parsed.data.code === 'constraint-conflict' && parsed.data.stage === 'direct-crop-delete') blocked.add(row.runId)
            if (!parsed.success || parsed.data.code !== 'constraint-conflict') break
          } finally { if (alive.current) setDeleteProgress(current => ({ ...current, done: current.done + 1 })) }
        }
        if (!alive.current) return
        setImports(current=>current.filter(row=>!removed.has(row.runId))); setBatches(current => current.filter(row => !removed.has(row.runId)).map(row => blocked.has(row.runId) ? { ...row, removable: false } : row)); setCheckedIds(current => new Set([...current].filter(id => !removed.has(id)))); setRoute(current => removed.has(current.runId) ? { runId: '' } : current)
        const remaining = target.rows.filter(row => !removed.has(row.runId)).map(row => !('importOnly' in row) && blocked.has(row.runId) ? { ...row, removable: false } : row), totalRemoved = target.removed + removed.size
        setDeleteNotice(t('directCropDeleteSummary').replace('{removed}', String(totalRemoved)).replace('{remaining}', String(remaining.length)))
        if (failures.length) { setDeleteTarget({ ...target, rows: remaining, removed: totalRemoved }); setDeleteFailures(failures); setDeleteError(failures[0]!.message) }
        else setDeleteTarget(null)
      } catch (failure) { if (alive.current) setDeleteError(directCropFailure(t, failure, 'directCropDeleteError')) }
      finally { if (alive.current) { setBusy(false); reloadBatches() } }
    }
    const more = async () => {
      if (nextOffset === undefined || busy) return
      setBusy(true); setError(''); retryAction.current = 'more'
      const version = listVersion.current
      try { const reply = listSchema.parse(await invoke('direct-crop-list', { offset: nextOffset }, lifetime.current.signal)); if (alive.current && version === listVersion.current) { setBatchTotal(reply.total); loadedPages.current.add(nextOffset); setBatches(previous => [...previous, ...reply.batches.filter(row => !previous.some(old => old.runId === row.runId))]); setNextOffset(reply.nextOffset) } }
      catch (failure) { if (alive.current) setError(directCropFailure(t, failure, 'directCropReadError')) }
      finally { if (alive.current) setBusy(false) }
    }
    const onImage = React.useCallback((id: string) => setRoute(current => current.imageVersionId === id ? current : { ...current, imageVersionId: id }), [])
    const observedTask = React.useRef('')
    const onTask = React.useCallback((id: string) => { if (observedTask.current !== id) { observedTask.current = id; refresh(current => current + 1) } }, [])
    const files = selection?.kind === 'local' ? selection.files.map(file => {
      const details = localDetails.get(file.path)
      const issue = details?.readable === false ? t('directCropUnreadable') : details?.size === 0 ? t('directCropEmptyFile') : details?.size !== undefined && details.size > configuration.limits.maxImportBytes ? t('directCropTooLarge').replace('{limit}', sizeLabel(configuration.limits.maxImportBytes)) : ''
      return { id: file.path, name: file.name, size: details?.size, issue }
    }) : selection?.photos.map(photo => ({ id: photo.id, name: photo.title || photo.id, size: undefined, issue: '' })) ?? []
    const closeImport = () => { if (!busy) { setSelection(null); setError(''); retryAction.current = null } }
    const pageId = React.useId()
    return <section className="vc-direct-page" data-vc-direct-crop aria-label={t('directCrop')}>
      <header className="vc-direct-pagebar" data-batch-open={!!batch || undefined}><div><Button size="sm" variant="ghost" onClick={() => batch ? setRoute({ runId: '' }) : onBack()}><ui.IconChevronLeftOutlineRegular size={16} />{t(batch ? 'directCropBatches' : 'directCropBack')}</Button><span className="vc-direct-page-title" title={batch?.name}>{batch ? batch.name : t('directCrop')}</span><Tag tone="neutral">{t('directCropTemplate')}</Tag>{totalImports>0&&<div className="vc-direct-header-progress" role="status" title={t(imports.some(item=>item.status==='importing')?'serverImportRunning':'serverImportFailed')}><StateDot state={imports.some(item=>item.status==='importing')?'ongoing':'warning'}/><progress max={totalImports} value={savedImports} aria-label={t('serverImportProgress')}/><small>{savedImports}/{totalImports}</small></div>}</div><div>
        {batch ? batch && <Button size="sm" variant="outline" disabled={busy || !batch.wallpaper?.passed} onClick={() => { void exportBatch() }}>{t('directCropExport')}</Button> : <Menu className="vc-import-picker" listClassName="vc-menu" open={importMenuOpen} onClose={() => setImportMenuOpen(false)} portal autoFocus align="end" items={[{ id: 'local', label: t('directCropLocal'), icon: <ui.IconPlusOutlineRegular size={16} />, disabled: busy }, { id: 'gallery', label: t('directCropGallery'), icon: <ui.IconFolderOpenOutlineRegular size={16} />, disabled: busy }, { id: 'server', label: t('serverQueue'), icon: <ui.IconBrowseOutlineRegular size={16} />, disabled: busy }]} onSelect={value => { setImportMenuOpen(false); if (value === 'local') void local(); else if (value === 'gallery') setGalleryOpen(true); else if (value === 'server') setServerOpen(true) }} anchor={<Button variant="primary" disabled={busy} aria-haspopup="menu" aria-expanded={importMenuOpen} onClick={() => setImportMenuOpen(value => !value)}><ui.IconPlusOutlineRegular size={16} />{t('directCropAddImages')}<ui.IconChevronDownOutlineRegular size={12} /></Button>} />}
        {batch?.origin === 'server' && <Button size="sm" variant="outline" onClick={() => setServerOpen(true)}>{t('serverQueue')}</Button>}
        <Button variant="ghost" size="sm" disabled={loading || busy} onClick={reloadBatches}><ui.IconRefreshOutlineRegular size={14} />{t('refresh')}</Button>
      </div></header>
      {readError && <div className="vc-notice" role="alert">{readError}<Button size="sm" onClick={() => refresh(value => value + 1)}>{t('retry')}</Button></div>}
      {error && !selection && <div className="vc-notice" role="alert">{error}{retryAction.current && <Button size="sm" disabled={busy} onClick={() => { if (retryAction.current === 'local') void local(); else if (retryAction.current === 'export') void exportBatch(); else if (retryAction.current === 'more') void more() }}>{t('retry')}</Button>}</div>}
      {exported && <div className="vc-direct-export-status" role="status"><span>{t('directCropExported').replace('{count}', String(exported.files))} · {t('directCropExcluded').replace('{count}', String(exported.excluded))}</span><code>{exported.directory}</code></div>}
      {!configuration.visionConfigured && <div className="vc-notice">{t('directCropModelRequired')}</div>}
      {batch ? <Canvas key={batch.runId} refreshKey={revision} onServer={() => setServerOpen(true)} batch={batch} invoke={invoke} scope={scope} pollMs={configuration.limits.pollIntervalMs} pageSize={configuration.limits.pageSize} t={t} imageVersionId={route.imageVersionId} onImage={onImage} onTask={onTask} /> : <div className="vc-direct-batches">
        <div className="vc-direct-table-toolbar"><div><Checkbox checked={allChecked} label={t('directCropSelectVisible')} disabled={busy || !selectable.length} onChange={checkVisible} /><span role="status">{t('directCropSelectionCount').replace('{selected}', String(checkedRows.length)).replace('{total}', String(batchTotal + imports.length))}</span>{checkedRows.length > 0 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCheckedIds(new Set())}>{t('directCropClearSelection')}</Button>}</div><div><Button size="sm" variant="outline" disabled={busy || !checkedRows.length} onClick={() => openRemoval('selected', checkedRows)}><ui.IconTrashOutlineRegular size={14} />{t('directCropDeleteSelected')}</Button><Button size="sm" variant="ghost" className="vc-direct-delete-all" disabled={busy || !batchTotal && !imports.length} onClick={() => { void prepareAll() }}>{preparingAll && <StateDot state="ongoing" />}{t(preparingAll ? 'directCropDeletePreparing' : 'directCropDeleteAll')}</Button></div></div>
        {deleteNotice && !deleteTarget && <p className="vc-direct-delete-notice" role="status">{deleteNotice}</p>}
        {deleteError && !deleteTarget && <p className="vc-notice" role="alert">{deleteError}</p>}
        {loading && !batches.length && !imports.length ? <div className="vc-empty"><StateDot state="ongoing" /></div> : batches.length || imports.length ? <>
          <div className="vc-direct-table-scroll"><table className="vc-direct-batch-table"><colgroup><col className="vc-direct-col-check" /><col /><col className="vc-direct-col-source" /><col className="vc-direct-col-state" /><col className="vc-direct-col-count" /><col className="vc-direct-col-count" /><col className="vc-direct-col-time" /><col className="vc-direct-col-actions" /></colgroup><thead><tr><th scope="col">{t('directCropSelectColumn')}</th><th scope="col">{t('directCropName')}</th><th scope="col">{t('directCropSourceColumn')}</th><th scope="col">{t('directCropStatus')}</th><th scope="col">{t('directCropQuality')}</th><th scope="col">{t('directCropAttention')}</th><th scope="col">{t('directCropCreatedColumn')}</th><th scope="col">{t('directCropActionsColumn')}</th></tr></thead><tbody>{imports.map(item=><tr key={item.runId} data-server-import={item.runId} data-selected={checkedIds.has(item.runId)||undefined}><td className="vc-direct-select-cell"><Checkbox className="vc-direct-row-checkbox" label={t('directCropSelectBatch')+' '+item.name} checked={checkedIds.has(item.runId)} disabled={busy || item.status==='importing'} onChange={checked=>checkRow(item.runId,checked)} /></td><td><strong className="vc-direct-import-name">{item.name}</strong>{item.status!=='importing'&&<small className="vc-direct-import-issue" title={t(item.status==='interrupted'?'serverImportInterrupted':item.errorCode==='source-protocol-error'?'serverImportChanged':'serverImportFailed')}>{t(item.status==='interrupted'?'serverImportInterrupted':item.errorCode==='source-protocol-error'?'serverImportChanged':'serverImportFailed')}</small>}</td><td><Tag tone="neutral">{t('serverQueue')}</Tag></td><td><Tag tone={item.status==='importing'?'info':'warning'}>{t(item.status==='importing'?'serverImportPhaseRunning':item.status==='interrupted'?'serverImportPhaseInterrupted':'serverImportPhaseFailed')}</Tag></td><td>—</td><td>—</td><td>—</td><td><div className="vc-direct-row-actions">{item.status!=='importing'&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>{void retryImport(item.runId)}}>{t('serverImportResume')}</Button>}<Button size="sm" variant="ghost" onClick={()=>setServerOpen(true)}>{t('serverImportDetails')}</Button><ui.Tooltip label={t('directCropDelete')}><span><Button size="sm" variant="ghost" disabled={busy||item.status==='importing'} aria-label={t('directCropDelete')+' '+item.name} onClick={()=>openRemoval('single',[{...item,importOnly:true}])}><ui.IconTrashOutlineRegular size={14}/></Button></span></ui.Tooltip></div></td></tr>)}{batches.map(row => {
            const status = row.wallpaper?.status ?? row.status, attention = row.wallpaper?.attention ?? 0, passed = row.wallpaper?.passed ?? 0, live = running(status)
            return <tr key={row.runId} className="vc-direct-batch" data-run-id={row.runId} data-selected={checkedIds.has(row.runId) || undefined}>
              <td className="vc-direct-select-cell"><Checkbox className="vc-direct-row-checkbox" checked={checkedIds.has(row.runId)} label={t('directCropSelectBatch') + ' ' + row.name} disabled={busy} onChange={checked => checkRow(row.runId, checked)} /></td>
              <td><Button variant="ghost" className="vc-direct-batch-open" aria-label={t('directCropOpenBatch') + ' ' + row.name} disabled={busy} onClick={() => { setExported(null); setRoute({ runId: row.runId }) }}><span className="vc-direct-batch-name" title={row.name}>{row.name}</span></Button></td>
              <td><Tag tone="neutral">{t(row.origin === 'local' ? 'directCropLocalSource' : row.origin === 'server' ? 'serverSource' : 'directCropGallerySource')}</Tag></td>
              <td><span className="vc-direct-batch-state"><StateDot state={live ? 'ongoing' : status === 'failed' ? 'error' : attention ? 'warning' : status === 'completed' && passed === row.matched ? 'done' : 'idle'} />{t(status === 'completed' && attention ? 'wallpaperAttention' : status)}</span></td>
              <td className="vc-direct-count"><strong>{passed}</strong><span> / {row.matched}</span></td><td className="vc-direct-count" data-attention={attention > 0 || undefined}>{attention}</td>
              <td><time dateTime={row.createdAt} title={new Date(row.createdAt).toLocaleString()}>{new Date(row.createdAt).toLocaleString()}</time></td>
              <td><div className="vc-direct-row-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => { setExported(null); setRoute({ runId: row.runId }) }}>{t('directCropOpenBatch')}</Button><ui.Tooltip label={t(settled(row) ? 'directCropDeleteHintShort' : 'directCropDeleteStopFirst')}><span><Button size="sm" variant="ghost" className="vc-direct-batch-delete" aria-label={t('directCropDelete') + ' ' + row.name} disabled={busy || !settled(row)} onClick={() => openRemoval('single', [row])}><ui.IconTrashOutlineRegular size={16} /></Button></span></ui.Tooltip></div></td>
            </tr>
          })}</tbody></table></div>
          {nextOffset !== undefined && <div className="vc-direct-table-more"><Button variant="outline" disabled={busy} onClick={() => { void more() }}>{t('directCropLoadMore')}</Button></div>}
        </> : imports.length ? null : <div className="vc-empty vc-direct-empty"><ui.IconBrowseOutlineRegular size={36} /><h2>{t('directCropEmpty')}</h2><p>{t('directCropEmptyHint')}</p><p>{t('directCropHint')}</p><Button variant="primary" disabled={busy} onClick={() => { void local() }}>{t('directCropLocal')}</Button></div>}
      </div>}
      <Modal open={!!deleteTarget} onClose={closeDelete} title={t(deleteTarget?.mode === 'all' ? 'directCropDeleteAllTitle' : deleteTarget?.mode === 'selected' ? 'directCropDeleteSelected' : 'directCropDelete')} closeLabel={t('close')} className="vc-direct-delete-modal" footer={<div className="vc-direct-dialog-actions"><Button variant="outline" disabled={busy} onClick={closeDelete}>{t('cancel')}</Button><Button variant="primary" disabled={busy || !removableRows.length} onClick={() => { void removeBatch() }}>{busy ? <StateDot state="ongoing" /> : <ui.IconTrashOutlineRegular size={16} />}{t('directCropDeleteConfirm')}</Button></div>}>
        <div className="vc-direct-delete-content">
        <section className="vc-direct-delete-explanation"><ui.IconFolderOpenOutlineRegular size={18} /><div><p>{t('directCropDeleteHint')}</p>{deleteTarget?.mode === 'all' && <p className="vc-direct-delete-scope-note">{t('directCropDeleteAllHint')}</p>}</div></section>
        <div className="vc-direct-delete-summary"><div><span>{t('directCropDeleteScope')}</span><strong>{(deleteTarget?.rows.length ?? 0) + (deleteTarget?.removed ?? 0)}</strong></div><div data-removable={removableRows.length > 0 || undefined}><span>{t('directCropDeleteEligible')}</span><strong>{removableRows.length}</strong></div><div data-retained={retainedRows.length > 0 || undefined}><span>{t('directCropDeleteRetained')}</span><strong>{retainedRows.length}</strong></div></div>
        <section className="vc-direct-delete-records"><h3>{t('directCropDeleteListTitle')}</h3><ul className="vc-direct-delete-list">{deleteTarget?.rows.slice(0, configuration.limits.pageSize).map(row => <li key={row.runId} data-retained={!canRemove(row) || undefined}><ui.IconBrowseOutlineRegular size={16} /><span className="vc-direct-delete-row-name" title={row.name}>{row.name}</span><Tag tone={canRemove(row) ? 'neutral' : 'warning'}>{t(canRemove(row) ? 'directCropDeleteWillRemove' : 'directCropDeleteKeep')}</Tag></li>)}</ul></section>
        {(deleteTarget?.rows.length ?? 0) > configuration.limits.pageSize && <p className="vc-flow-muted">{t('directCropDeleteMore').replace('{count}', String(deleteTarget!.rows.length - configuration.limits.pageSize))}</p>}
        {busy && <p className="vc-direct-delete-progress" role="status">{t('directCropDeleteProgress').replace('{done}', String(deleteProgress.done)).replace('{total}', String(deleteProgress.total))}</p>}
        {deleteNotice && <p role="status">{deleteNotice}</p>}{deleteError && <p className="vc-notice" role="alert">{deleteError}</p>}
        {deleteFailures.length > 1 && <ul className="vc-direct-delete-failures">{deleteFailures.map(failure => <li key={failure.runId}>{failure.name} · {failure.message}</li>)}</ul>}
        </div>
      </Modal>
      {serverOpen && <ServerQueue saveCredential={actions.saveCredential} ready={configuration.visionConfigured} invoke={invoke} t={t} pollMs={configuration.limits.pollIntervalMs} limit={configuration.limits.maxImportFiles} onClose={() => { setServerOpen(false); refresh(value => value + 1) }} onStarted={runId => { setServerOpen(false); setLoading(true);  setRoute({ runId: '' }); refresh(value => value + 1) }} />}
      {galleryOpen && <GalleryPicker purpose="originals" config={configuration} actions={actions} t={t} onClose={() => setGalleryOpen(false)} onManageAccounts={() => { setGalleryOpen(false); onManageAccounts() }} onSelect={(accountId, photos) => choose({ kind: 'gallery', accountId, photos: photos.map(photo => ({ id: photo.id, title: photo.title, width: photo.width, height: photo.height, referenceUrl: photo.referenceUrl, thumbnailUrl: photo.thumbnailUrl })) })} />}
      <Modal open={!!selection} onClose={closeImport} title={t('directCropImport')} closeLabel={t('close')} className="vc-direct-import-modal" footer={<div className="vc-direct-dialog-actions"><Button variant="outline" disabled={busy} onClick={closeImport}>{t('cancel')}</Button><Button variant="primary" disabled={busy || !files.length || files.some(file => !!file.issue) || !name.trim() || !configuration.visionConfigured || !imageRouteReady(imageOptions, imageRoute)} onClick={() => { void start() }}>{busy && <StateDot state="ongoing" />}{t('directCropStart')}</Button></div>}>
        <div className="vc-direct-import-body">
          <label className="vc-direct-name" htmlFor={pageId + '-name'}>{t('directCropName')}<Input id={pageId + '-name'} value={name} disabled={busy} maxLength={160} onChange={event => setName(event.currentTarget.value)} /></label>
          <section className="vc-import-section" aria-labelledby={`${pageId}-originals-heading`}>
            <div className="vc-import-heading"><h3 id={`${pageId}-originals-heading`}>{t('directCropSelected')}</h3><Tag tone="neutral">{files.length}</Tag></div>
            <div className="vc-direct-import-list" role="list" aria-label={t('directCropSelected')}>{files.map(file => <div role="listitem" key={file.id} data-invalid={!!file.issue}><ui.IconBrowseOutlineRegular size={16} /><div className="vc-direct-file"><span title={file.name}>{file.name}</span>{file.size !== undefined && <small>{sizeLabel(file.size)}</small>}{file.issue && <p role="alert">{file.issue}</p>}</div><Button size="sm" variant="ghost" disabled={busy} aria-label={t('directCropRemove') + ' ' + file.name} onClick={() => setSelection(previous => previous?.kind === 'local' ? { ...previous, files: previous.files.filter(item => item.path !== file.id) } : previous ? { ...previous, photos: previous.photos.filter(item => item.id !== file.id) } : null)}><ui.IconTrashOutlineRegular size={14} /></Button></div>)}</div>
            <p className="vc-settings-description">{selection?.kind === 'local' ? t('directCropFileHint').replace('{limit}', sizeLabel(configuration.limits.maxImportBytes)) : t('directCropOriginalHint')}</p>
          </section>
          <section className="vc-import-section vc-import-generation" aria-labelledby={`${pageId}-generation-heading`}>
            <div className="vc-import-heading"><h3 id={`${pageId}-generation-heading`}>{t('imageGenerationBatchTitle')}</h3></div>
            <div className="vc-image-route-fields">
              <label>{t('imageGenerationSource')}<SelectField matchAnchorWidth label={t('imageGenerationSource')} value={imageRoute.imageProvider} disabled={busy || !imageOptions} options={(imageOptions?.providers ?? []).map(provider => ({ value: provider.id, label: provider.name }))} onChange={imageProvider => setImageRoute({ imageProvider, imageSourceId: '', imageModel: '' })} /></label>
              <label>{t(imageRoute.imageProvider === 'visual-curator-openai' ? 'imageGenerationApiKey' : 'imageGenerationCodexAccount')}<SelectField matchAnchorWidth label={t('imageGenerationAccount')} value={imageRoute.imageSourceId} disabled={busy || !imageOptions} options={[...(imageRoute.imageProvider === 'autoflow-codex' ? [{ value: '', label: t('imageGenerationAutomaticAccount') }] : []), ...(imageOptions?.providers.find(provider => provider.id === imageRoute.imageProvider)?.sources ?? []).map(source => ({ value: source.id, label: `${source.name}${!source.available ? ` · ${t('unconfigured')}` : source.modelError ? ` · ${t('modelsLoadError')}` : ''}` }))]} onChange={imageSourceId => { const route = { imageProvider: imageRoute.imageProvider, imageSourceId }; setImageRoute({ ...route, imageModel: defaultImageModel(imageOptions, route) }) }} /></label>
              <label className="vc-image-model-field">{t('wallpaperImageModel')}<SelectField matchAnchorWidth label={t('wallpaperImageModel')} value={imageRoute.imageModel} disabled={busy || !imageOptions} options={[{ value: '', label: t('wallpaperAutomaticModel') }, ...imageModelsForRoute(imageOptions, imageRoute).map(model => ({ value: model.id, label: model.name }))]} onChange={imageModel => setImageRoute({ ...imageRoute, imageModel })} /></label>
            </div>
          </section>
          {error && <p className="vc-notice" role="alert">{error}</p>}
        </div>
      </Modal>
    </section>
  }
}
