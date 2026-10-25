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
  return function TaskHistory({ runs, selected, snapshot, t, loading, errorCode, actions, onSelect, report }: {
    runs: RunView[]; selected: RunView | undefined; snapshot: CuratorSnapshot; t: WorkbenchText; loading: boolean; errorCode: string | undefined
    actions: Pick<WorkbenchProps['actions'], 'execute' | 'openAnalysis' | 'loadRun'>
    onSelect(runId: string): void; report(work: () => Promise<unknown>): void
  }) {
    const nameOf = (run: RunView) => snapshot.styles.find(style => style.analysis?.runId === run.runId || style.styleId === run.styleId)?.name ?? (run.taskBrief.trim() || t(kindKey[run.kind]))
    const valuesOf = (run: RunView) => metrics[run.kind].filter(([key]) => run.counts[key] !== undefined)
    const active = (run: RunView) => ['created', 'running', 'pausing', 'cancelling'].includes(run.status)
    const Icon = selected ? icons[selected.kind] : ui.IconClockOutlineRegular
    return <div className="vc-task-body">
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
          {['created', 'running', 'paused', 'interrupted'].includes(selected.status) && <Button size="sm" variant="outline" onClick={() => report(() => actions.execute('run-control', { runId: selected.runId, command: ['paused', 'interrupted'].includes(selected.status) ? 'resume' : 'pause' }))}>{t(['paused', 'interrupted'].includes(selected.status) ? 'resume' : 'pause')}</Button>}
          {!['completed', 'failed', 'cancelled'].includes(selected.status) && <Button size="sm" variant="ghost" disabled={selected.status === 'cancelling'} onClick={() => report(() => actions.execute('run-control', { runId: selected.runId, command: 'cancel' }))}>{t(selected.status === 'cancelling' ? 'cancelling' : 'cancel')}</Button>}
        </div></div>
        {(selected.error || errorCode) && <p className="vc-notice" role="alert">{t('error')} ({selected.error?.code ?? errorCode})</p>}
        {selected.kind === 'analyze' && <p className="vc-task-retained"><ui.IconArchiveCheckOutlineRegular size={16} />{t('analysisRetainedHint')}</p>}
        {!!selected.results.length && <div className="vc-image-grid vc-results">{selected.results.map(image => <figure key={image.imageVersionId}><a href={resource(image.previewPath)} target="_blank" rel="noreferrer"><img src={resource(image.previewPath)} alt={image.name} loading="lazy" /></a><figcaption><Tag>{image.verdict ? t(image.verdict) : t(image.kind === 'crop' ? 'cropKind' : 'source')}</Tag><small>{image.width} × {image.height}</small></figcaption>{image.reason && <p>{image.reason}</p>}</figure>)}</div>}
        {!selected.results.length && selected.kind !== 'analyze' && <p className="vc-task-empty">{t(active(selected) ? 'noResults' : 'taskNoImageResults')}</p>}
        {selected.pageToken && <Button className="vc-task-more" variant="outline" disabled={loading} onClick={() => report(() => actions.loadRun(selected.runId, true))}>{loading && <StateDot state="ongoing" />}{t('more')}</Button>}
      </section> : <div className="vc-task-empty">{t('noTasks')}</div>}
    </div>
  }
}
