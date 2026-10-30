/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Compact task selection and image-first results; execution and pagination remain owned by the store. */
import type { CuratorSnapshot, ImageView, RunView } from './contract.ts'
import type { WorkbenchProps } from './workbench.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import { safeResourcePath } from './store.ts'
import { taskStageKeys } from './search-feedback-locale.ts'
import { galleryMediaUrlSchema } from '../shared/gallery.ts'

const kindKey = { analyze: 'analyzeKind', search: 'searchKind', crop: 'cropKind', evaluate: 'evaluateKind', export: 'exportKind' } as const
const metrics = {
  analyze: [['observed', 'analysisProgress'], ['suggestions', 'suggestion'], ['summarized', 'summarizedImages']],
  search: [['candidates', 'taskCandidates'], ['distinct', 'taskDistinct'], ['qualified', 'taskQualified'], ['unavailable', 'taskUnavailable'], ['technicalFailed', 'taskTechnical'], ['failedQueries', 'taskFailedQueries']],
  crop: [['retrievedUnique', 'taskDistinct'], ['sourceReviewed', 'taskReviewed'], ['cropGenerated', 'taskCrops'], ['finalPassed', 'taskQualified']],
  evaluate: [['compared', 'taskCompared'], ['technicalFailed', 'taskTechnicalFailed'], ['unprocessed', 'taskPending']],
  export: [['files', 'taskFiles'], ['resources', 'taskResources']],
} as const
const filterKeys = { selected: 'taskFinal', review: 'taskReview', rejected: 'taskRejected', failed: 'taskTechnical', processing: 'taskProcessing', pending: 'taskPending', source: 'taskSourceImage', all: 'taskAll' } as const
const stopKey = { 'target-met': 'taskTargetMet', 'source-exhausted': 'taskSourceExhausted', 'budget-exhausted': 'taskBudgetExhausted', 'partial-failure': 'taskPartial' } as const

function issueKey(issue: { code: string; category?: string | undefined; stage: string }) {
  return issue.code === 'source-original-restricted' ? 'taskSourceRestricted' : issue.category === 'unavailable' ? 'taskSourceMissing' : issue.stage === 'lookup' ? 'taskLookupFailed' : issue.stage === 'download' ? 'taskDownloadFailed' : issue.stage === 'import' ? 'taskImportFailed' : 'taskReviewFailed'
}

/** @param React Host React runtime. @param ui Existing accessible primitives. @returns Task history using saved run data and store actions. */
export function createTaskHistory(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Tag, StateDot, Modal, Menu } = ui
  const icons = { analyze: ui.IconSparkleRegular, search: ui.IconSearchOutlineRegular, crop: ui.IconListPenOutlineRegular, evaluate: ui.IconListPenOutlineRegular, export: ui.IconDownloadOutlineRegular }
  const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : '' }
  return function TaskHistory({ runs, selected, snapshot, t, loading, errorCode, actions, onSelect, onCrop, onStart, onReferences, report, pending = [] }: {
    runs: RunView[]; selected: RunView | undefined; snapshot: CuratorSnapshot; t: WorkbenchText; loading: boolean; errorCode: string | undefined
    actions: Pick<WorkbenchProps['actions'], 'execute' | 'openAnalysis' | 'loadRun'>
    pending?: string[]
    onCrop?: ((imageVersionId: string) => void) | undefined
    onStart?: (() => void) | undefined; onReferences?: (() => void) | undefined
    onSelect(runId: string): void; report(work: () => Promise<unknown>): void
  }) {
    const [height, setHeight] = React.useState(() => Math.min(260, Math.max(160, window.innerHeight * .32)))
    const [viewportHeight, setViewportHeight] = React.useState(() => window.innerHeight)
    const [navPreference, setNavPreference] = React.useState<'auto' | 'open' | 'collapsed'>('auto')
    const [switcherOpen, setSwitcherOpen] = React.useState(false)
    const [informationOpen, setInformationOpen] = React.useState(false)
    const [detailId, setDetailId] = React.useState<string | null>(null)
    const detailTrigger = React.useRef<HTMLElement | null>(null)
    const panel = React.useRef<HTMLDivElement>(null), drag = React.useRef<{ y: number; height: number } | null>(null)
    const panelId = React.useId(), maxHeight = Math.max(160, Math.min(720, viewportHeight * .7))
    const resizable = !onReferences, clamp = (value: number) => Math.round(Math.min(maxHeight, Math.max(160, value)))
    const railOpen = navPreference === 'open' || navPreference === 'auto' && (resizable ? runs.length > 0 : runs.length > 1)
    React.useEffect(() => {
      const resized = () => { setViewportHeight(window.innerHeight); setHeight(value => Math.min(value, Math.max(160, Math.min(720, window.innerHeight * .7)))) }
      window.addEventListener('resize', resized)
      return () => window.removeEventListener('resize', resized)
    }, [])
    const nameOf = (run: RunView) => snapshot.styles.find(style => style.analysis?.runId === run.runId || style.styleId === run.styleId)?.name ?? (run.taskBrief.trim() || t(kindKey[run.kind]))
    const valuesOf = (run: RunView) => metrics[run.kind].filter(([key]) => run.counts[key] !== undefined)
    const active = (run: Pick<RunView, 'status'>) => ['created', 'running', 'pausing', 'cancelling'].includes(run.status)
    const recoverable = (run: Pick<RunView, 'status'>) => ['paused', 'interrupted'].includes(run.status)
    const Icon = selected ? icons[selected.kind] : ui.IconClockOutlineRegular
    const requesting = (command: string) => !!selected && pending.includes(`run-control:${selected.runId}:${command}`)
    const control = (command: 'pause' | 'resume' | 'cancel') => {
      if (!selected) return
      // 控制独立于页面互斥操作；暂停尚在发送时，取消仍必须能送达 Host。
      void actions.execute('run-control', { runId: selected.runId, command, waitForCompletion: false }).catch(error => { /* 共享 store 负责保存状态并显示控制失败 Toast。 */ })
    }
    const filter = selected?.resultFilter ?? 'selected'
    const results = selected?.results.filter(image => filter === 'all' || image.resultCategory === filter || !image.resultCategory && (filter === 'selected' && image.selection?.kind === 'selected' || filter === 'review' && image.verdict === 'needs-review')) ?? []
    const filterCounts = selected?.resultSummary ? { selected: selected.resultSummary.selected, review: selected.resultSummary.needsReview, rejected: selected.resultSummary.rejected, failed: selected.resultSummary.failedImages, processing: selected.resultSummary.processing, pending: selected.resultSummary.pending, source: selected.resultSummary.sourceImages, all: selected.resultSummary.candidates } : undefined
    const emptyKeys = { selected: 'taskNoFinal', review: 'taskNoReview', rejected: 'taskNoRejected', failed: 'taskNoTechnical', processing: 'taskNoProcessing', pending: 'taskNoPending', source: 'taskNoSource', all: active(selected ?? { status: 'completed' }) ? 'noResults' : 'taskNoImageResults' } as const
    const stageKey = selected && active(selected) && selected.stage ? taskStageKeys[selected.stage as keyof typeof taskStageKeys] : undefined
    const goalSummary = selected && (selected.kind === 'search' || selected.kind === 'crop') ? selected.resultSummary : undefined
    const mainMetrics = selected ? valuesOf(selected).filter(([key]) => !(goalSummary && (key === 'qualified' || key === 'finalPassed'))) : []
    const legacyWarnings = selected?.warnings.filter(warning => !selected.issues?.some(issue => warning.includes(issue.candidateId) && warning.includes(issue.code))) ?? []
    const visibleFilters = (['all', 'selected', 'review', 'rejected', 'failed', 'processing', 'pending', 'source'] as const).filter(value => !filterCounts || value === 'all' || value === 'selected' || value === 'review' || value === filter || (filterCounts[value] ?? 0) > 0)
    const detailImage = selected?.results.find(item => item.imageVersionId === detailId)
    const openDetail = (imageVersionId: string, trigger: HTMLElement) => { detailTrigger.current = trigger; setDetailId(imageVersionId) }
    const closeDetail = () => {
      setDetailId(null)
      const trigger = detailTrigger.current
      if (trigger && trigger.isConnected) setTimeout(() => trigger.focus({ preventScroll: true }), 0)
    }
    const verdictLabel = (image: ImageView) => selected?.outputKind === 'preview' && image.selection?.kind === 'selected' ? t('taskPreviewMatched') : image.resultCategory && !['selected', 'source'].includes(image.resultCategory) ? t(filterKeys[image.resultCategory]) : image.verdict ? t(image.verdict) : t(image.selection?.kind === 'selected' ? 'taskSelected' : 'taskPending')
    const verdictTone = (image: ImageView) => image.resultCategory === 'selected' || image.verdict === 'pass' ? 'success' : image.resultCategory === 'review' || image.verdict === 'needs-review' ? 'warning' : image.resultCategory === 'rejected' || image.resultCategory === 'failed' || image.verdict === 'reject' ? 'danger' : 'neutral'
    const styleGroupName = (image: ImageView) => image.styleMatch?.groupId && selected ? snapshot.styles.find(style => style.styleId === selected.styleId)?.modelProfile?.groups.find(group => group.groupId === image.styleMatch?.groupId)?.name || t('styleGroup') : undefined
    const selectionWarnings = (image: ImageView) => image.selection?.kind === 'selected' ? image.selection.warnings : []
    const cardSummary = (image: ImageView) => image.reason || selectionWarnings(image)[0] || image.technicalFailure || t('taskNoReviewNote')
    const informationContent = selected && (
          <div className="vc-task-detail-summary">
            {goalSummary && selected.taskBrief && <p className="vc-task-information-brief">{selected.taskBrief}</p>}
            <dl className="vc-task-stats">
              {mainMetrics.map(([key, label]) => <div key={key}><dt>{t(selected.outputKind === 'preview' && key === 'distinct' ? 'taskUniqueLinks' : label)}</dt><dd>{selected.counts[key]}</dd></div>)}
            </dl>
            <div className="vc-task-meta-pills">
              {selected.outcome && <span className="vc-task-outcome">{t('taskStop')}: {t(stopKey[selected.outcome as keyof typeof stopKey] ?? 'taskOutcomeUnknown')}</span>}
              {selected.delivery && (selected.delivery.directory ? <details className="vc-task-diagnostics vc-task-output"><summary><ui.IconDownloadOutlineRegular size={13} />{t('taskDeliveryReady')}</summary><span className="vc-task-directory">{selected.delivery.directory}</span></details> : <span className="vc-task-feedback-note"><ui.IconDownloadOutlineRegular size={13} />{t('taskDockDeliveryPending')}</span>)}
              {!!selected.issues?.length && <details className="vc-task-diagnostics"><summary>{t('taskDiagnostics')} · {selected.issues.length}</summary><ul>{selected.issues.map((issue, index) => <li key={`${issue.candidateId}:${index}`}><code>{issue.candidateId}</code><span>{t(issueKey(issue))}</span><small>{issue.httpStatus ?? issue.code}</small></li>)}</ul></details>}
              {!!legacyWarnings.length && <details className="vc-task-diagnostics"><summary>{t('taskLegacyWarning')} · {legacyWarnings.length}</summary><ul>{legacyWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
            </div>
          </div>
    )
    if (!runs.length && !selected) return <div className="vc-task-body" data-empty="true">
      <section className="vc-task-placeholder" aria-label={t(onReferences ? 'executionEmptyTitle' : 'noTasks')}>
        <span className={onReferences ? 'vc-execution-empty-art' : 'vc-task-placeholder-icon'} aria-hidden="true">{!onReferences && <ui.IconClockOutlineRegular size={24} />}</span>
        <h3>{t(onReferences ? 'executionEmptyTitle' : 'noTasks')}</h3>
        <p>{t(onReferences ? onStart ? 'executionEmptyReady' : 'executionEmptyNeedsProfile' : 'taskHistoryEmptyHint')}</p>
        {(onStart || onReferences) && <Button variant={onStart ? 'primary' : 'outline'} className={onStart ? 'vc-primary-action' : undefined} onClick={onStart ?? onReferences}>{t(onStart ? 'newTask' : 'executionPrepareProfile')}</Button>}
      </section>
    </div>
    return <div ref={panel} className="vc-task-resizable" data-resizable={resizable} style={resizable ? { height: clamp(height) } : undefined}>
      {resizable && <div className="vc-task-resize-handle" role="separator" tabIndex={0} aria-label={t('taskResize')} aria-orientation="horizontal" aria-controls={panelId} aria-valuemin={160} aria-valuemax={Math.round(maxHeight)} aria-valuenow={clamp(height)}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { y: event.clientY, height: panel.current?.getBoundingClientRect().height ?? height }; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => { if (drag.current) setHeight(clamp(drag.current.height + drag.current.y - event.clientY)) }}
        onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
        onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
        onKeyDown={event => { const deltas: Record<string, number> = { ArrowUp: 24, ArrowDown: -24, PageUp: 80, PageDown: -80 }; const delta = deltas[event.key]; if (delta !== undefined || event.key === 'Home' || event.key === 'End') { event.preventDefault(); setHeight(value => clamp(event.key === 'Home' ? 160 : event.key === 'End' ? maxHeight : value + (delta ?? 0))) } }} />}
      <div className="vc-task-body" id={panelId} data-rail-open={railOpen}>
      <nav className="vc-run-list" hidden={!railOpen} aria-label={t('tasks')}>
        <div className="vc-run-list-header"><span>{t('tasks')} <span className="vc-task-count">{runs.length}</span></span><Button size="sm" variant="ghost" aria-label={t('collapse')} onClick={() => setNavPreference('collapsed')}>{t('collapse')}</Button></div>
        <div className="vc-run-list-items">{runs.length ? runs.slice(0, 12).map(run => {
          const RunIcon = icons[run.kind], metric = valuesOf(run)[0]
          return <Button key={run.runId} className="vc-run-item" variant="ghost" aria-pressed={run.runId === selected?.runId} onClick={() => onSelect(run.runId)}>
            <span className="vc-run-icon" aria-hidden="true">{active(run) ? <StateDot state="ongoing" /> : <RunIcon size={16} />}</span>
            <span className="vc-run-copy"><span className="vc-run-title" title={nameOf(run)}>{nameOf(run)}</span><span className="vc-run-caption">{t(kindKey[run.kind])}{metric && <> · {t(metric[1])} {run.counts[metric[0]]}</>}</span></span>
            <span className="vc-run-state">{run.status === 'completed' ? <ui.IconCheckCircleOutlineRegular size={14} /> : run.status === 'cancelled' ? <ui.IconStopFillRegular size={12} /> : null}<Tag>{t(run.status)}</Tag></span>
          </Button>
        }) : <p className="vc-task-empty">{t('noTasks')}</p>}</div>
      </nav>
      {selected ? <section className="vc-task-detail" aria-label={t('taskDetails')}>
        <div className="vc-task-top" data-compact={!!goalSummary}>
          <header className="vc-task-detail-header">
            {runs.length > 0 && <Button size="sm" variant="ghost" className="vc-run-rail-toggle" aria-label={t('taskToggleList')} aria-expanded={railOpen} onClick={() => setNavPreference(railOpen ? 'collapsed' : 'open')}><ui.IconListPenOutlineRegular size={14} /><span>{t('taskToggleList')}</span><span className="vc-task-count">{runs.length}</span></Button>}
            {runs.length > 1 && <Menu className="vc-run-switcher" open={switcherOpen} onClose={() => setSwitcherOpen(false)} portal compact autoFocus selectedId={selected.runId}
              items={runs.slice(0, 12).map(run => ({ id: run.runId, label: <span className="vc-collection-task-label"><span>{nameOf(run)}</span><Tag>{t(run.status)}</Tag></span> }))}
              onSelect={runId => { setSwitcherOpen(false); onSelect(runId) }}
              anchor={<Button size="sm" variant="outline" className="vc-run-switcher-trigger" aria-label={t('tasks')} aria-haspopup="menu" aria-expanded={switcherOpen} onClick={() => setSwitcherOpen(value => !value)}><span className="vc-run-switcher-name">{nameOf(selected)}</span><span className="vc-task-count">{runs.length}</span><ui.IconChevronDownOutlineRegular size={12} /></Button>} />}
            <span className="vc-task-detail-icon" aria-hidden="true">{active(selected) ? <StateDot state="ongoing" /> : <Icon size={16} />}</span>
            <div className="vc-task-title-block"><div className="vc-task-title-row"><h3>{nameOf(selected)}</h3><Tag tone={selected.status === 'completed' ? 'success' : selected.status === 'failed' ? 'danger' : recoverable(selected) ? 'warning' : active(selected) ? 'info' : 'neutral'}>{t(selected.status)}</Tag>{(!goalSummary || stageKey) && <span className="vc-task-phase">{!goalSummary && t(kindKey[selected.kind])}{stageKey && <>{!goalSummary && ' · '}{t(stageKey)}</>}</span>}</div>{!goalSummary && selected.taskBrief && selected.taskBrief !== nameOf(selected) && <p>{selected.taskBrief}</p>}</div>
            {goalSummary && <div className="vc-task-progress-inline"><span>{t('taskTargetProgress')}</span><strong>{goalSummary.selected}<small> / {goalSummary.target ?? '—'}</small></strong></div>}
            <div className="vc-task-actions">
              {goalSummary && <Menu className="vc-task-information" listClassName="vc-task-information-menu" open={informationOpen} onClose={() => setInformationOpen(false)} portal compact autoFocus anchor={<Button size="sm" variant="ghost" aria-haspopup="menu" aria-expanded={informationOpen} onClick={() => setInformationOpen(value => !value)}>{t('taskRunInformation')}<ui.IconChevronDownOutlineRegular size={12} /></Button>}>{informationContent}</Menu>}

              {selected.kind === 'analyze' && <Button size="sm" variant="outline" onClick={() => actions.openAnalysis(selected.runId)}><ui.IconListPenOutlineRegular size={14} />{t('analysisProcess')}</Button>}
              {['created', 'running', 'pausing', 'paused', 'interrupted'].includes(selected.status) && <Button size="sm" variant={recoverable(selected) ? 'primary' : 'outline'} className={recoverable(selected) ? 'vc-primary-action' : undefined} disabled={requesting('pause') || requesting('resume') || requesting('cancel') || selected.status === 'pausing'} aria-busy={requesting('pause') || requesting('resume') || undefined} onClick={() => control(recoverable(selected) ? 'resume' : 'pause')}>{t(requesting('pause') || selected.status === 'pausing' ? 'pausing' : recoverable(selected) ? 'resume' : 'pause')}</Button>}
              {!['completed', 'failed', 'cancelled'].includes(selected.status) && <Button size="sm" variant="ghost" disabled={requesting('cancel') || selected.status === 'cancelling'} aria-busy={requesting('cancel') || undefined} onClick={() => control('cancel')}>{t(requesting('cancel') || selected.status === 'cancelling' ? 'cancelling' : 'cancel')}</Button>}
              <Button size="sm" variant="ghost" title={t(['completed', 'failed', 'cancelled'].includes(selected.status) ? 'taskDeleteHint' : 'taskDeleteActive')} disabled={!['completed', 'failed', 'cancelled'].includes(selected.status) || pending.includes(`run-delete:${selected.runId}`)} aria-busy={pending.includes(`run-delete:${selected.runId}`) || undefined} onClick={() => { void actions.execute('run-delete', { runId: selected.runId, operationId: crypto.randomUUID() }).catch(error => { /* 共享 store 显示失败 Toast，并保留原任务。 */ }) }}><ui.IconTrashOutlineRegular size={14} />{t('taskDelete')}</Button>
            </div>
          </header>
          {(selected.error || errorCode) && <div className="vc-notice vc-task-error-banner" role="alert"><span>{t('error')} ({selected.error?.code ?? errorCode})</span>{recoverable(selected) && <Button size="sm" variant="primary" className="vc-primary-action" disabled={requesting('resume')} onClick={() => control('resume')}>{t('resume')}</Button>}</div>}
          {!goalSummary && informationContent}
          {(selected.kind === 'search' || selected.kind === 'crop') && <div className="vc-task-filters">{visibleFilters.map(value => <Button key={value} size="sm" variant={filter === value ? 'outline' : 'ghost'} aria-pressed={filter === value} disabled={loading} onClick={() => report(() => actions.loadRun(selected.runId, false, value))}><span>{t(value === 'selected' && selected.outputKind === 'preview' ? 'taskPreviewMatched' : filterKeys[value])}</span>{filterCounts?.[value] !== undefined && <>{' '}<span className="vc-task-filter-count">{filterCounts[value]}</span></>}</Button>)}</div>}
        </div>
        <div className="vc-task-results-scroll">{loading && !results.length && <div className="vc-image-grid vc-results" role="status" aria-label={t('taskBatchLoading')}>{[0, 1, 2].map(index => <div className="vc-result-card" aria-hidden="true" key={index}><span className="vc-skeleton-fill vc-search-batch-skeleton-image" /><div className="vc-result-meta"><span className="vc-skeleton-fill vc-search-batch-skeleton-tag" /></div></div>)}</div>}
          {selected.kind === 'analyze' && <p className="vc-task-retained"><ui.IconArchiveCheckOutlineRegular size={16} />{t('analysisRetainedHint')}</p>}
          {!!results.length && <div className="vc-image-grid vc-results">{results.map(image => <figure key={image.imageVersionId} className="vc-result-card">
            <button type="button" className="vc-result-preview" aria-label={`${t('taskImageDetails')} · ${image.name}`} onClick={event => openDetail(image.imageVersionId, event.currentTarget)}>
              <img src={resource(image.thumbnailPath ?? image.previewPath)} alt={image.name} loading="lazy" decoding="async" />
            </button>
            <figcaption className="vc-result-meta">
              <div className="vc-result-tags">
                <Tag tone={image.selection?.kind === 'selected' ? 'success' : 'neutral'}>{selected.outputKind === 'preview' ? t('searchLaunchPreview') : image.selection?.kind === 'selected' ? t('taskSelected') : t(image.reviewStage === 'source' ? 'taskSourceImage' : 'taskOtherCrop')}</Tag>
                <Tag tone={verdictTone(image)}>{verdictLabel(image)}</Tag>
              </div>
              <div className="vc-result-facts"><small className="vc-result-dimensions">{image.width} × {image.height}</small>{image.styleMatch && <span className="vc-result-match">{t('taskMatch')}: {image.styleMatch.satisfiedWeightRatio === null ? t('taskMatchUnknown') : `${Math.round(image.styleMatch.satisfiedWeightRatio * 100)}%`}</span>}</div>
            </figcaption>
            <p className="vc-result-summary">{cardSummary(image)}</p>
            <div className="vc-result-actions">
              <Button size="sm" variant="ghost" onClick={event => openDetail(image.imageVersionId, event.currentTarget)}>{t('taskImageDetails')}</Button>
              {selected.outputKind === 'preview' ? <Button size="sm" variant="outline" disabled={!galleryMediaUrlSchema.safeParse(image.previewUrl).success} onClick={() => { const url = galleryMediaUrlSchema.safeParse(image.previewUrl); if (url.success) window.open(url.data, '_blank', 'noopener,noreferrer') }}>{t('taskOpenPreview')}</Button> : onCrop && <Button size="sm" variant="outline" onClick={() => onCrop(image.parentImageVersionId ?? image.imageVersionId)}>{t('taskRecrop')}</Button>}
            </div>
          </figure>)}</div>}
          {!results.length && selected.kind !== 'analyze' && <p className="vc-task-empty">{t(emptyKeys[filter])}</p>}
          {selected.pageToken && <Button className="vc-task-more" variant="outline" disabled={loading} onClick={() => report(() => actions.loadRun(selected.runId, true))}>{loading && <StateDot state="ongoing" />}{t('more')}</Button>}
        </div>
        <Modal open={!!detailImage} onClose={closeDetail} title={detailImage?.name ?? t('taskImageDetails')} closeLabel={t('close')} className="vc-result-detail-modal" contentClassName="vc-result-detail-content" footer={<div className="vc-task-footer">
          {detailImage?.sourcePreviewPath && <a className="vc-detail-source-link" href={resource(detailImage.sourcePreviewPath)} target="_blank" rel="noreferrer">{t('taskOriginal')}</a>}
          {selected.outputKind === 'preview' && detailImage?.previewUrl && <Button variant="outline" onClick={() => { const url = galleryMediaUrlSchema.safeParse(detailImage.previewUrl); if (url.success) window.open(url.data, '_blank', 'noopener,noreferrer') }}>{t('taskOpenPreview')}</Button>}
          {selected.outputKind !== 'preview' && onCrop && detailImage && <Button variant="outline" onClick={() => { const targetId = detailImage.parentImageVersionId ?? detailImage.imageVersionId; closeDetail(); onCrop(targetId) }}>{t('taskRecrop')}</Button>}
          <Button variant="primary" onClick={closeDetail}>{t('close')}</Button>
        </div>}>
          {detailImage && <div className="vc-result-detail-body">
            <div className="vc-result-detail-media" data-has-source={!!detailImage.sourcePreviewPath}>
              <div className="vc-result-detail-stage">
                <a href={resource(detailImage.previewPath)} target="_blank" rel="noreferrer"><img src={resource(detailImage.previewPath)} alt={detailImage.name} /></a>
                <small>{selected.outputKind === 'preview' ? t('searchLaunchPreview') : detailImage.selection?.kind === 'selected' ? t('taskSelected') : t(detailImage.reviewStage === 'source' ? 'taskSourceImage' : 'taskOtherCrop')} · {detailImage.width} × {detailImage.height}</small>
              </div>
              {detailImage.sourcePreviewPath && <div className="vc-result-detail-stage vc-result-detail-source">
                <a href={resource(detailImage.sourcePreviewPath)} target="_blank" rel="noreferrer"><img src={resource(detailImage.sourcePreviewPath)} alt={`${detailImage.name} (${t('taskSourceImage')})`} /></a>
                <small>{t('taskSourceComparison')} · <a href={resource(detailImage.sourcePreviewPath)} target="_blank" rel="noreferrer">{t('taskOriginal')}</a></small>
              </div>}
            </div>
            <div className="vc-result-detail-facts">
              <Tag tone={detailImage.selection?.kind === 'selected' ? 'success' : 'neutral'}>{selected.outputKind === 'preview' ? t('searchLaunchPreview') : detailImage.selection?.kind === 'selected' ? t('taskSelected') : t(detailImage.reviewStage === 'source' ? 'taskSourceImage' : 'taskOtherCrop')}</Tag>
              <Tag tone={verdictTone(detailImage)}>{verdictLabel(detailImage)}</Tag>
              <span>{detailImage.width} × {detailImage.height}</span>
              {detailImage.styleMatch && <span>{t('taskMatch')}: {detailImage.styleMatch.satisfiedWeightRatio === null ? t('taskMatchUnknown') : `${Math.round(detailImage.styleMatch.satisfiedWeightRatio * 100)}%`}{styleGroupName(detailImage) && <> · {styleGroupName(detailImage)}</>}</span>}
              {detailImage.effectivePixelRect && <span>{t('taskCropGeometry')}: {detailImage.effectivePixelRect.x}, {detailImage.effectivePixelRect.y} · {detailImage.effectivePixelRect.width} × {detailImage.effectivePixelRect.height}</span>}
            </div>
            {!!(selectionWarnings(detailImage).length || detailImage.technicalFailure) && <section className="vc-result-detail-section">
              <h4>{t('taskReviewWarnings')}</h4>
              <ul>
                {selectionWarnings(detailImage).map(warning => <li key={warning}>{warning}</li>)}
                {detailImage.technicalFailure && <li><code>{detailImage.technicalFailure}</code></li>}
              </ul>
            </section>}
            <section className="vc-result-detail-section">
              <h4>{t('taskReviewNotes')}</h4>
              <p className="vc-result-detail-reason">{detailImage.reason || t('taskNoReviewNote')}</p>
            </section>
          </div>}
        </Modal>
      </section> : <section className="vc-task-placeholder" aria-label={t('taskChooseTitle')}><span className="vc-task-placeholder-icon" aria-hidden="true"><ui.IconClockOutlineRegular size={24} /></span><h3>{t('taskChooseTitle')}</h3><p>{t('taskChooseHint')}</p></section>}
      </div>
    </div>
  }
}
