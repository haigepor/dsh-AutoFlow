/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Compact task selection and results; execution and pagination remain owned by the store. */
import type { CuratorSnapshot, RunView } from './contract.ts'
import type { WorkbenchProps } from './workbench.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import { safeResourcePath } from './store.ts'

const kindKey = { analyze: 'analyzeKind', search: 'searchKind', crop: 'cropKind', evaluate: 'evaluateKind', export: 'exportKind' } as const
const metrics = {
  analyze: [['observed', 'analysisProgress'], ['suggestions', 'suggestion'], ['summarized', 'summarizedImages']],
  search: [['candidates', 'taskCandidates'], ['distinct', 'taskDistinct'], ['qualified', 'taskQualified'], ['failedQueries', 'taskFailedQueries']],
  crop: [['retrievedUnique', 'taskCandidates'], ['sourceReviewed', 'taskReviewed'], ['cropGenerated', 'taskCrops'], ['finalPassed', 'taskQualified']],
  evaluate: [['compared', 'taskCompared'], ['technicalFailed', 'taskTechnicalFailed'], ['unprocessed', 'taskPending']],
  export: [['files', 'taskFiles'], ['resources', 'taskResources']],
} as const

/** @param React Host React runtime. @param ui Existing accessible primitives. @returns Task history using saved run data and store actions. */
export function createTaskHistory(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Tag, StateDot } = ui
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
    const panel = React.useRef<HTMLDivElement>(null), drag = React.useRef<{ y: number; height: number } | null>(null)
    const panelId = React.useId(), maxHeight = Math.max(160, Math.min(720, viewportHeight * .7))
    const resizable = !onReferences, clamp = (value: number) => Math.round(Math.min(maxHeight, Math.max(160, value)))
    React.useEffect(() => {
      const resized = () => { setViewportHeight(window.innerHeight); setHeight(value => Math.min(value, Math.max(160, Math.min(720, window.innerHeight * .7)))) }
      window.addEventListener('resize', resized)
      return () => window.removeEventListener('resize', resized)
    }, [])
    const nameOf = (run: RunView) => snapshot.styles.find(style => style.analysis?.runId === run.runId || style.styleId === run.styleId)?.name ?? (run.taskBrief.trim() || t(kindKey[run.kind]))
    const valuesOf = (run: RunView) => metrics[run.kind].filter(([key]) => run.counts[key] !== undefined)
    const active = (run: RunView) => ['created', 'running', 'pausing', 'cancelling'].includes(run.status)
    const Icon = selected ? icons[selected.kind] : ui.IconClockOutlineRegular
    const requesting = (command: string) => !!selected && pending.includes(`run-control:${selected.runId}:${command}`)
    const control = (command: 'pause' | 'resume' | 'cancel') => {
      if (!selected) return
      // 控制独立于页面互斥操作；暂停尚在发送时，取消仍必须能送达 Host。
      void actions.execute('run-control', { runId: selected.runId, command, waitForCompletion: false }).catch(error => { /* 共享 store 负责保存状态并显示控制失败 Toast。 */ })
    }
    const filter = selected?.resultFilter ?? 'selected'
    const results = selected?.results.filter(image => filter === 'all' || filter === 'selected' && image.selection?.kind === 'selected' || filter === 'review' && image.verdict === 'needs-review') ?? []
    const stopKey = { 'target-met': 'taskTargetMet', 'source-exhausted': 'taskSourceExhausted', 'budget-exhausted': 'taskBudgetExhausted', 'partial-failure': 'taskPartial' } as const
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
      <div className="vc-task-body" id={panelId}>
      <nav className="vc-run-list" aria-label={t('tasks')}>{runs.length ? runs.slice(0, 12).map(run => {
        const RunIcon = icons[run.kind], metric = valuesOf(run)[0]
        return <Button key={run.runId} className="vc-run-item" variant="ghost" aria-pressed={run.runId === selected?.runId} onClick={() => onSelect(run.runId)}>
          <span className="vc-run-icon" aria-hidden="true">{active(run) ? <StateDot state="ongoing" /> : <RunIcon size={16} />}</span>
          <span className="vc-run-copy"><span className="vc-run-title" title={nameOf(run)}>{nameOf(run)}</span><span className="vc-run-caption">{t(kindKey[run.kind])}{metric && <> · {t(metric[1])} {run.counts[metric[0]]}</>}</span></span>
          <span className="vc-run-state">{run.status === 'completed' ? <ui.IconCheckCircleOutlineRegular size={14} /> : run.status === 'cancelled' ? <ui.IconStopFillRegular size={12} /> : null}<Tag>{t(run.status)}</Tag></span>
        </Button>
      }) : <p className="vc-task-empty">{t('noTasks')}</p>}</nav>
      {selected ? <section className="vc-task-detail" aria-label={t('taskDetails')}>
        <header className="vc-task-detail-header"><span className="vc-task-detail-icon" aria-hidden="true"><Icon size={18} /></span><div><h3>{nameOf(selected)}</h3><p>{t(kindKey[selected.kind])}{selected.taskBrief && selected.taskBrief !== nameOf(selected) && <> · {selected.taskBrief}</>}</p></div><Tag>{t(selected.status)}</Tag></header>
        <div className="vc-task-detail-summary"><dl className="vc-task-stats">{valuesOf(selected).map(([key, label]) => <div key={key}><dt>{t(label)}</dt><dd>{selected.counts[key]}</dd></div>)}</dl><div className="vc-task-actions">
          {selected.kind === 'analyze' && <Button size="sm" variant="outline" onClick={() => actions.openAnalysis(selected.runId)}><ui.IconListPenOutlineRegular size={14} />{t('analysisProcess')}</Button>}
          {['created', 'running', 'pausing', 'paused', 'interrupted'].includes(selected.status) && <Button size="sm" variant="outline" disabled={requesting('pause') || requesting('resume') || requesting('cancel') || selected.status === 'pausing'} aria-busy={requesting('pause') || requesting('resume') || undefined} onClick={() => control(['paused', 'interrupted'].includes(selected.status) ? 'resume' : 'pause')}>{t(requesting('pause') || selected.status === 'pausing' ? 'pausing' : ['paused', 'interrupted'].includes(selected.status) ? 'resume' : 'pause')}</Button>}
          {!['completed', 'failed', 'cancelled'].includes(selected.status) && <Button size="sm" variant="ghost" disabled={requesting('cancel') || selected.status === 'cancelling'} aria-busy={requesting('cancel') || undefined} onClick={() => control('cancel')}>{t(requesting('cancel') || selected.status === 'cancelling' ? 'cancelling' : 'cancel')}</Button>}
          <Button size="sm" variant="ghost" title={t(['completed', 'failed', 'cancelled'].includes(selected.status) ? 'taskDeleteHint' : 'taskDeleteActive')} disabled={!['completed', 'failed', 'cancelled'].includes(selected.status) || pending.includes(`run-delete:${selected.runId}`)} aria-busy={pending.includes(`run-delete:${selected.runId}`) || undefined} onClick={() => { void actions.execute('run-delete', { runId: selected.runId, operationId: crypto.randomUUID() }).catch(error => { /* 共享 store 显示失败 Toast，并保留原任务。 */ }) }}><ui.IconTrashOutlineRegular size={14} />{t('taskDelete')}</Button>
        </div></div>
        {selected.outcome && <p>{t('taskStop')}: {t(stopKey[selected.outcome as keyof typeof stopKey] ?? 'taskOutcomeUnknown')}{selected.resultSummary?.target !== null && selected.resultSummary?.target !== undefined && <> · {selected.resultSummary.selected} / {selected.resultSummary.target}</>}</p>}
        {!!selected.warnings.length && <ul className="vc-notice">{selected.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {(selected.kind === 'search' || selected.kind === 'crop') && <div className="vc-row">{(['selected', 'review', 'all'] as const).map(value => <Button key={value} variant="outline" aria-pressed={filter === value} disabled={loading} onClick={() => report(() => actions.loadRun(selected.runId, false, value))}>{t(value === 'selected' ? 'taskFinal' : value === 'review' ? 'taskReview' : 'taskAll')} · {value === 'selected' ? selected.resultSummary?.selected : value === 'review' ? selected.resultSummary?.needsReview : selected.resultSummary?.candidates}</Button>)}</div>}
        {(selected.error || errorCode) && <p className="vc-notice" role="alert">{t('error')} ({selected.error?.code ?? errorCode})</p>}
        {selected.kind === 'analyze' && <p className="vc-task-retained"><ui.IconArchiveCheckOutlineRegular size={16} />{t('analysisRetainedHint')}</p>}
        {!!results.length && <div className="vc-image-grid vc-results">{results.map(image => <figure key={image.imageVersionId}><a href={resource(image.previewPath)} target="_blank" rel="noreferrer"><img src={resource(image.previewPath)} alt={image.name} loading="lazy" /></a><figcaption><Tag>{image.selection?.kind === 'selected' ? t('taskSelected') : t(image.reviewStage === 'source' ? 'taskSourceImage' : 'taskOtherCrop')}</Tag><Tag>{image.verdict ? t(image.verdict) : t(image.kind === 'crop' ? 'cropKind' : 'source')}</Tag><small>{image.width} × {image.height}</small></figcaption>{onCrop && <Button size="sm" variant="outline" onClick={() => onCrop(image.parentImageVersionId ?? image.imageVersionId)}>{t('taskRecrop')}</Button>}{image.sourcePreviewPath && <a href={resource(image.sourcePreviewPath)} target="_blank" rel="noreferrer">{t('taskOriginal')}</a>}{image.selection?.kind === 'selected' && image.selection.warnings.map(warning => <p key={warning}>{warning}</p>)}{image.styleMatch && <p>{t('taskMatch')}: {image.styleMatch.satisfiedWeightRatio === null ? t('taskMatchUnknown') : `${Math.round(image.styleMatch.satisfiedWeightRatio * 100)}%`}{image.styleMatch.groupId && <> · {snapshot.styles.find(style => style.styleId === selected.styleId)?.modelProfile?.groups.find(group => group.groupId === image.styleMatch?.groupId)?.name || t('styleGroup')}</>}</p>}{image.reason && <p>{image.reason}</p>}</figure>)}</div>}
        {!results.length && selected.kind !== 'analyze' && <p className="vc-task-empty">{t(active(selected) ? 'noResults' : 'taskNoImageResults')}</p>}
        {selected.pageToken && <Button className="vc-task-more" variant="outline" disabled={loading} onClick={() => report(() => actions.loadRun(selected.runId, true))}>{loading && <StateDot state="ongoing" />}{t('more')}</Button>}
      </section> : <section className="vc-task-placeholder" aria-label={t('taskChooseTitle')}><span className="vc-task-placeholder-icon" aria-hidden="true"><ui.IconClockOutlineRegular size={24} /></span><h3>{t('taskChooseTitle')}</h3><p>{t('taskChooseHint')}</p></section>}
      </div>
    </div>
  }
}
