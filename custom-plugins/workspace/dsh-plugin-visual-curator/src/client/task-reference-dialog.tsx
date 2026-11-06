/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Explicit image selection reuses completed search candidates without restarting a search. */
import type { StyleView } from './contract.ts'
import type { WorkbenchProps } from './workbench.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import { taskReferenceImportSchema, taskReferencePageSchema, type TaskReferenceImport, type TaskReferencePage } from '../shared/task-references.ts'
import { createSelectField } from './select-field.tsx'
import { createReferencePreview } from './reference-preview.tsx'
import { safeResourcePath } from './store.ts'
import { createGalleryMedia } from './gallery-media.tsx'
import { createTaskReferenceCache, type TaskReferenceCachePolicy, type TaskReferenceView } from './task-reference-cache.ts'

type Image = TaskReferencePage['images'][number]
type Choice = { runId: NonNullable<TaskReferencePage['runId']>; image: Image }
interface Props { style: StyleView; role: 'positive' | 'negative'; onRole(role: 'positive' | 'negative'): void; maxFiles: number; cachePolicy: TaskReferenceCachePolicy; t: WorkbenchText; actions: Pick<WorkbenchProps['actions'], 'readTaskReferences' | 'startGalleryReferences'>; onClose(): void }

/** @param React Shared runtime. @param ui Native dialog, selection and feedback controls. @returns A bounded, cancellable completed-task picker with retained unknown-write identity. */
export function createTaskReferenceDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const SelectField = createSelectField(React, ui), ReferencePreview = createReferencePreview(React, ui)
  const { GalleryLoadMore } = createGalleryMedia(React, ui)
  const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : '' }
  function Dialog({ style, role, onRole, maxFiles, cachePolicy, t, actions, onClose }: Props) {
    const [tasks, setTasks] = React.useState<TaskReferencePage['tasks']>([]), [taskCursor, setTaskCursor] = React.useState<string>()
    const [runId, setRunId] = React.useState(''), [filter, setFilter] = React.useState<'all' | 'selected' | 'rejected' | 'review'>('all')
    const [page, setPage] = React.useState<TaskReferencePage | null>(null), [chosen, setChosen] = React.useState<Map<Image['imageVersionId'], Choice>>(new Map())
    const [loading, setLoading] = React.useState(false), [tasksLoading, setTasksLoading] = React.useState(false), [saving, setSaving] = React.useState(false), [uncertain, setUncertain] = React.useState(false)
    const [error, setError] = React.useState<'' | 'taskReferenceReadError' | 'taskReferenceImportError' | 'taskReferenceRejected'>('')
    const [previewImage, setPreviewImage] = React.useState<Image | null>(null), [selectingAll, setSelectingAll] = React.useState(false)
    const allSelection = React.useRef<symbol | null>(null)
    const [maximized, setMaximized] = React.useState(false), [onlyChosen, setOnlyChosen] = React.useState(false), [previewRefresh, setPreviewRefresh] = React.useState(0)
    const lifetime = React.useRef<AbortController | null>(null), read = React.useRef<{ key: string; controller: AbortController } | null>(null), sequence = React.useRef(0)
    const [cache] = React.useState(() => createTaskReferenceCache(cachePolicy))
    const active = React.useRef<{ key: string; view: TaskReferenceView } | null>(null), results = React.useRef<HTMLDivElement>(null), restoreScroll = React.useRef<number | null>(null)
    const submission = React.useRef<TaskReferenceImport | null>(null), tasksReading = React.useRef<AbortSignal | null>(null)
    const locked = saving || uncertain
    const readTasks = async (cursor?: string, signal?: AbortSignal) => {
      if (tasksReading.current && !tasksReading.current.aborted) return
      const taskSignal = signal ?? lifetime.current!.signal; tasksReading.current = taskSignal
      setTasksLoading(true); setError('')
      try {
        const result = taskReferencePageSchema.parse(await actions.readTaskReferences({ styleId: style.styleId, ...(cursor ? { pageToken: cursor } : {}) }, taskSignal))
        if (taskSignal.aborted) return
        if (result.styleId !== style.styleId || result.runId !== null) throw new Error('task-reference-response-mismatch')
        setTasks(current => cursor ? [...new Map([...current, ...result.tasks].map(task => [task.runId, task])).values()] : result.tasks); setTaskCursor(result.nextPageToken)
      } catch (error) { if (!taskSignal.aborted) setError('taskReferenceReadError') }
      finally { if (tasksReading.current === taskSignal) tasksReading.current = null; if (!taskSignal.aborted) setTasksLoading(false) }
    }
    React.useEffect(() => {
      const controller = new AbortController(); lifetime.current = controller
      void readTasks(undefined, controller.signal)
      return () => { controller.abort(); read.current?.controller.abort(); sequence.current++ }
    }, [])
    React.useLayoutEffect(() => {
      // 在新任务绘制前恢复其滚动位置，避免先闪现上一任务的尾部。
      if (results.current && restoreScroll.current !== null) { results.current.scrollTop = restoreScroll.current; restoreScroll.current = null }
    }, [page, onlyChosen])
    const readImages = async (id: string, category: typeof filter, append = false, refresh = false) => {
      const key = JSON.stringify([id, category])
      if (read.current?.key === key) return
      if (!onlyChosen && active.current && results.current) active.current.view.scrollTop = results.current.scrollTop
      const previous = active.current?.key === key ? active.current.view : undefined
      const base = append && previous && previous.expiresAt > Date.now() ? previous : undefined
      if (append && base && !base.page.nextImagePageToken) return
      read.current?.controller.abort(); read.current = null
      const version = ++sequence.current, cached = !append && !refresh ? cache.get(key) : undefined
      setError('')
      if (cached) { active.current = { key, view: cached }; restoreScroll.current = cached.scrollTop; setPage(cached.page); setLoading(false); return cached }
      const controller = new AbortController(), startedAt = Date.now(); read.current = { key, controller }
      setLoading(true)
      if (!base) { active.current = null; restoreScroll.current = 0; setPage(null) }
      try {
        const result = taskReferencePageSchema.parse(await actions.readTaskReferences({ styleId: style.styleId, runId: id, resultFilter: category, ...(base?.page.nextImagePageToken ? { pageToken: base.page.nextImagePageToken } : {}) }, AbortSignal.any([controller.signal, lifetime.current!.signal])))
        if (controller.signal.aborted || lifetime.current?.signal.aborted || sequence.current !== version) return
        if (result.styleId !== style.styleId || result.runId !== id) throw new Error('task-reference-response-mismatch')
        const merged = base ? { ...result, images: [...new Map([...base.page.images, ...result.images].map(image => [image.imageVersionId, image])).values()] } : result
        const view = cache.remember(key, merged, startedAt, base)
        active.current = { key, view }; setPage(merged)
        const refreshed = new Map(result.images.map(image => [image.imageVersionId, image]))
        setChosen(current => new Map([...current].map(([imageId, choice]) => [imageId, choice.runId === id && refreshed.has(imageId) ? { ...choice, image: refreshed.get(imageId)! } : choice])))
        return view
      } catch (error) { if (!controller.signal.aborted && !lifetime.current?.signal.aborted && sequence.current === version) setError('taskReferenceReadError') }
      finally { if (read.current?.controller === controller) read.current = null; if (!controller.signal.aborted && !lifetime.current?.signal.aborted && sequence.current === version) setLoading(false) }
    }
    const cancelSelectAll = () => { allSelection.current = null; setSelectingAll(false) }
    const selectTask = (id: string) => { cancelSelectAll(); setRunId(id); setOnlyChosen(false); void readImages(id, filter) }
    const toggle = (choice: Choice, enabled: boolean) => { cancelSelectAll(); setChosen(current => { const next = new Map(current); if (!enabled) next.delete(choice.image.imageVersionId); else if (next.size < maxFiles) next.set(choice.image.imageVersionId, choice); return next }) }
    const selectAll = async () => {
      if (locked || loading || !active.current || onlyChosen) return
      const intent = Symbol(); allSelection.current = intent; setSelectingAll(true)
      const next = new Map(chosen)
      let view: TaskReferenceView | undefined = active.current.view
      try {
        while (view?.page.runId && allSelection.current === intent && !lifetime.current?.signal.aborted) {
          for (const image of view.page.images) { if (next.size >= maxFiles) break; if (!next.has(image.imageVersionId)) next.set(image.imageVersionId, { runId: view.page.runId, image }) }
          setChosen(new Map(next))
          if (next.size >= maxFiles || !view.page.nextImagePageToken) break
          view = await readImages(runId, filter, true)
        }
      } finally { if (allSelection.current === intent) { allSelection.current = null; if (!lifetime.current?.signal.aborted) setSelectingAll(false) } }
    }
    const submit = async () => {
      if (saving || selectingAll || !chosen.size || !runId) return
      const input = submission.current ?? taskReferenceImportSchema.parse({ operationId: crypto.randomUUID(), styleId: style.styleId, expectedRevision: style.revision, role, analyzeAfter: false, images: [...chosen.values()].map(choice => ({ runId: choice.runId, imageVersionId: choice.image.imageVersionId })) })
      submission.current = input; setSaving(true); setError('')
      try {
        await actions.startGalleryReferences({ ...input, analyzeAfter: input.analyzeAfter ?? false }, 'completed-search')
        if (lifetime.current?.signal.aborted) return
        submission.current = null; setUncertain(false); onClose()
      } catch (error) {
        if (lifetime.current?.signal.aborted) return
        const rejected = !uncertain && !!error && typeof error === 'object' && 'code' in error && ['invalid-input', 'owner-denied', 'revision-conflict', 'constraint-conflict', 'operation-conflict'].includes(String(error.code))
        if (rejected) { submission.current = null; setUncertain(false); setError('taskReferenceRejected') }
        else { setUncertain(true); setError('taskReferenceImportError') }
      } finally { if (!lifetime.current?.signal.aborted) setSaving(false) }
    }
    const statusKeys = { selected: 'taskPreviewMatched', rejected: 'taskRejected', review: 'taskReview', failed: 'taskTechnical', processing: 'taskProcessing', pending: 'taskPending', source: 'taskSourceImage' } as const
    const selectedTask = tasks.find(task => task.runId === runId), images: Choice[] = onlyChosen ? [...chosen.values()] : page?.runId ? page.images.map(image => ({ runId: page.runId!, image })) : []
    const selectedCounts = new Map<string, number>()
    for (const choice of chosen.values()) selectedCounts.set(choice.runId, (selectedCounts.get(choice.runId) ?? 0) + 1)
    const close = () => { if (!saving) onClose() }
    return <ui.Modal open headless onClose={close} closeOnBackdropClick={!saving} title={t('taskReferenceTitle')} className={`vc-task-reference-modal${maximized ? ' vc-task-reference-fullscreen' : ''}`}>
      <header className="vc-task-reference-header">
        <div className="vc-task-reference-heading"><h2>{t('taskReferenceTitle')}</h2><p><span>{style.name}</span><span>{t('taskReferenceHint')}</span></p></div>
        <div className="vc-task-reference-window-actions"><ui.Tooltip label={t(maximized ? 'taskReferenceRestore' : 'taskReferenceFullscreen')} portal><ui.Button className="vc-task-reference-maximize" size="sm" variant="ghost" aria-label={t(maximized ? 'taskReferenceRestore' : 'taskReferenceFullscreen')} aria-pressed={maximized} onClick={() => setMaximized(value => !value)}><ui.IconFullscreenOutlineRegular size={16} /></ui.Button></ui.Tooltip><ui.Button size="sm" variant="ghost" disabled={saving} aria-label={t('close')} onClick={close}><ui.IconCloseOutlineRegular size={18} /></ui.Button></div>
      </header>
      <div className="vc-task-reference-layout">
        <aside className="vc-task-reference-rail"><div className="vc-task-reference-rail-heading"><h3>{t('taskReferenceTask')}</h3><ui.Tag>{tasks.length}{taskCursor ? '+' : ''}</ui.Tag></div>
          <nav className="vc-task-reference-task-list" aria-label={t('taskReferenceTask')}>{tasks.map(task => <ui.Button key={task.runId} variant="ghost" className="vc-task-reference-task" aria-pressed={runId === task.runId} disabled={locked} onClick={() => selectTask(task.runId)}><span title={task.taskBrief}>{task.taskBrief || t('searchKind')}</span><time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString()}</time><small>{t('taskCandidates')} <strong>{task.candidates}</strong></small>{!!selectedCounts.get(task.runId) && <small className="vc-task-reference-task-selected">{t('taskReferenceSelected')} <strong>{selectedCounts.get(task.runId)}</strong></small>}</ui.Button>)}
            {tasksLoading && !tasks.length && <p className="vc-task-reference-rail-status" role="status"><ui.StateDot state="ongoing" /> {t('taskReading')}</p>}
            {!tasks.length && !tasksLoading && !error && <p className="vc-task-reference-rail-status">{t('taskReferenceEmpty')}</p>}
            {taskCursor && <ui.Button size="sm" variant="outline" disabled={locked || tasksLoading} onClick={() => { void readTasks(taskCursor) }}>{t('taskReferenceMoreTasks')}</ui.Button>}
          </nav>
        </aside>
        <section className="vc-task-reference-workspace" aria-label={t('taskReferenceImages')}>
          <div className="vc-task-reference-toolbar">
            <div className="vc-task-reference-mobile-task"><SelectField label={t('taskReferenceTask')} value={runId} disabled={locked || !tasks.length} options={[{ value: '', label: t('taskReferenceChoose') }, ...tasks.map(task => ({ value: task.runId, label: `${task.taskBrief || t('searchKind')} · ${task.candidates}` }))]} onChange={id => { if (id) selectTask(id) }} />{taskCursor && <ui.Button size="sm" variant="ghost" disabled={locked || loading} onClick={() => { void readTasks(taskCursor) }}>{t('taskReferenceMoreTasks')}</ui.Button>}</div>
            <div className="vc-task-reference-toolbar-heading"><div><h3 title={selectedTask?.taskBrief}>{selectedTask?.taskBrief || t('taskReferenceChoose')}</h3><p>{runId && page ? <>{t('taskReferenceLoaded')} {page.images.length} / {page.totalImages} {t('taskReferenceImages')}</> : t('taskReferenceChooseHint')}</p></div>
              <div className="vc-task-reference-role" role="group" aria-label={t('role')}><span>{t('role')}</span>{(['positive', 'negative'] as const).map(value => <ui.Button key={value} size="sm" variant="ghost" aria-pressed={role === value} disabled={locked} data-role={value} onClick={() => onRole(value)}>{t(value)}</ui.Button>)}</div>
            </div>
            <div className="vc-task-reference-filter-row"><div className="vc-task-reference-filters" role="group" aria-label={t('taskReferenceFilter')}>{(['all', 'selected', 'rejected', 'review'] as const).map(value => <ui.Button key={value} size="sm" variant="ghost" aria-pressed={!onlyChosen && filter === value} disabled={locked || !runId} onClick={() => { cancelSelectAll(); setOnlyChosen(false); setFilter(value); void readImages(runId, value) }}>{t(value === 'all' ? 'taskAll' : statusKeys[value])}</ui.Button>)}</div>
              <div className="vc-task-reference-view-actions"><ui.Tooltip label={t('taskReferenceSelectAllHint')} portal><ui.Button size="sm" variant="outline" disabled={locked || !page || !selectingAll && (loading || onlyChosen || chosen.size >= maxFiles)} onClick={() => { if (selectingAll) cancelSelectAll(); else void selectAll() }}>{selectingAll && <ui.StateDot state="ongoing" />}{t(selectingAll ? 'cancel' : 'taskReferenceSelectAll')}</ui.Button></ui.Tooltip><ui.Button size="sm" variant="ghost" aria-pressed={onlyChosen} disabled={locked || !runId} onClick={() => { cancelSelectAll(); if (!onlyChosen && active.current && results.current) active.current.view.scrollTop = results.current.scrollTop; restoreScroll.current = onlyChosen ? active.current?.view.scrollTop ?? 0 : 0; setOnlyChosen(value => !value) }}>{t('taskReferenceOnlySelected')} <span>{chosen.size}</span></ui.Button><ui.Tooltip label={t('taskReferenceRetryImages')} portal><ui.Button size="sm" variant="ghost" aria-label={t('taskReferenceRetryImages')} disabled={locked || !page} onClick={() => setPreviewRefresh(value => value + 1)}><ui.IconRefreshOutlineRegular size={14} /></ui.Button></ui.Tooltip></div>
            </div>
            <p className="vc-task-reference-click-hint">{t('taskReferenceClickHint')}</p>
          </div>
          {error && <div className="vc-task-reference-notice" role="alert"><span>{t(error)}</span>{error === 'taskReferenceReadError' && <ui.Button size="sm" variant="outline" onClick={() => { if (runId) void readImages(runId, filter, !!page?.nextImagePageToken, true); else void readTasks() }}>{t('retry')}</ui.Button>}</div>}
          <div className="vc-task-reference-results" ref={results} onScroll={() => { if (!onlyChosen && active.current && results.current) active.current.view.scrollTop = results.current.scrollTop }}>
            {loading && runId && !page && !onlyChosen && <div className="vc-task-reference-grid vc-task-reference-skeleton" role="status" aria-label={t('taskReading')}>{Array.from({ length: 6 }, (_, index) => <div key={index}><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /></div>)}</div>}
            {!!images.length && <div className="vc-task-reference-grid">{images.map(choice => { const { image } = choice; const selectionDisabled = locked || !chosen.has(image.imageVersionId) && chosen.size >= maxFiles; return <figure key={image.imageVersionId} tabIndex={-1} data-selected={chosen.has(image.imageVersionId)} onContextMenu={event => { event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); setPreviewImage(image) }} onKeyDown={event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); setPreviewImage(image) } }}>
              <div className="vc-task-reference-image"><ReferencePreview src={resource(image.thumbnailPath ?? image.previewPath)} href={resource(image.previewPath)} alt={image.name} width={image.width} height={image.height} refreshKey={previewRefresh} t={t} onSelect={() => toggle(choice, !chosen.has(image.imageVersionId))} selected={chosen.has(image.imageVersionId)} selectionDisabled={selectionDisabled} />{image.resultCategory && <ui.Tag tone={image.resultCategory === 'selected' ? 'success' : image.resultCategory === 'review' ? 'warning' : 'neutral'}>{t(statusKeys[image.resultCategory])}</ui.Tag>}</div>
              <figcaption><ui.Checkbox checked={chosen.has(image.imageVersionId)} disabled={locked || !chosen.has(image.imageVersionId) && chosen.size >= maxFiles} label={image.name} title={image.name} onChange={enabled => toggle(choice, enabled)} /><small title={onlyChosen ? tasks.find(task => task.runId === choice.runId)?.taskBrief : undefined}>{onlyChosen ? tasks.find(task => task.runId === choice.runId)?.taskBrief || t('searchKind') : `${image.width} × ${image.height}`}</small></figcaption>
            </figure> })}</div>}
            {!images.length && !loading && <div className="vc-task-reference-empty"><ui.IconSearchOutlineRegular size={36} /><h3>{t(onlyChosen ? 'taskReferenceNoSelection' : runId ? 'taskNoImageResults' : 'taskReferenceChoose')}</h3><p>{t(onlyChosen ? 'taskReferenceChooseImages' : 'taskReferenceChooseHint')}</p></div>}
            {!onlyChosen && page?.nextImagePageToken && <><GalleryLoadMore hasMore loading={loading} disabled={locked || !!error} version={`${runId}:${filter}:${page.nextImagePageToken}`} kind="photos" showSkeleton={false} label={t('taskReading')} onLoad={() => { void readImages(runId, filter, true) }} /><ui.Button className="vc-task-more" variant="outline" disabled={loading || locked} onClick={() => { void readImages(runId, filter, true) }}>{loading && <ui.StateDot state="ongoing" />}{t(error ? 'retry' : 'taskMoreResults')} · {page.images.length} / {page.totalImages}</ui.Button></>}
          </div>
        </section>
      </div>
      <footer className="vc-task-reference-footer"><div className="vc-task-reference-selection-count" aria-live="polite"><div className="vc-task-reference-selected-total"><span>{t('taskReferenceSelectedImages')}</span><div><strong>{chosen.size}</strong><small> / {maxFiles}</small></div></div><span className="vc-task-reference-selection-tasks">{t('taskReferenceAcrossTasks')} <strong>{selectedCounts.size}</strong></span>{chosen.size >= maxFiles && <ui.Tag>{t('taskReferenceLimitReached')}</ui.Tag>}<ui.Button size="sm" variant="ghost" disabled={locked || !chosen.size} onClick={() => { cancelSelectAll(); setChosen(new Map()) }}>{t('galleryClearSelection')}</ui.Button></div><div><ui.Button variant="outline" disabled={saving} onClick={close}>{t('close')}</ui.Button><ui.Button variant="primary" disabled={saving || selectingAll || !chosen.size} onClick={() => { void submit() }}>{saving && <ui.StateDot state="ongoing" />}{t(saving ? 'taskReferenceSubmitting' : uncertain ? 'retry' : role === 'negative' ? 'taskReferenceAddNegative' : 'taskReferenceAddPositive')}{!saving && chosen.size > 0 && ` ${chosen.size}`}</ui.Button></div></footer>
      {previewImage && <ui.ImageLightbox src={resource(previewImage.previewPath)} alt={previewImage.name} labels={{ dialog: t('galleryPreview'), close: t('close') }} loadingLabels={{ loading: t('galleryPreviewLoading'), error: t('galleryPreviewError'), retry: t('retry') }} onClose={() => setPreviewImage(null)} />}
    </ui.Modal>
  }
  return function TaskReferenceDialog(props: Props) { return <Dialog key={props.style.styleId} {...props} /> }
}
