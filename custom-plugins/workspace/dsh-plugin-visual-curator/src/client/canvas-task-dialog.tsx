/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Cross-batch task inspection uses an authorized read without selecting its Session. */
import type { SearchBatchDetail } from '../shared/search-batches.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { taskStageKeys } from './search-feedback-locale.ts'
import { workflowSearchStage } from './workflow-current-task.ts'

const secondaryMetrics = { distinct: 'taskDistinct', screeningReviewed: 'taskScreeningReviewed', screeningRejected: 'taskScreeningRejected', unavailable: 'taskUnavailable', technicalFailed: 'taskTechnical' } as const

/** @param React Shared runtime. @param ui Native dialog primitives. @returns Source-scoped task detail with bounded observation and explicit read failures. */
export function createCanvasTaskDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function CanvasTaskDialog({ open, runId, read, pollMs, t, onClose, onOpenResults }: { open: boolean; runId: string; read(runId: string, signal: AbortSignal): Promise<SearchBatchDetail>; pollMs: number; t: WorkbenchText; onClose(): void; onOpenResults?(): void }) {
    const [value, setValue] = React.useState<SearchBatchDetail | null>(null), [failed, setFailed] = React.useState(false), [revision, refresh] = React.useState(0)
    React.useEffect(() => {
      if (!open) return
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
      setFailed(false)
      const load = async () => {
        try {
          const task = await read(runId, controller.signal)
          if (controller.signal.aborted) return
          setValue(task); setFailed(false)
          if (['created', 'running', 'pausing', 'cancelling'].includes(task.status)) timer = setTimeout(() => { void load() }, pollMs)
        } catch (error) { if (!controller.signal.aborted) setFailed(true) }
      }
      void load(); return () => { controller.abort(); clearTimeout(timer) }
    }, [open, runId, read, pollMs, revision])
    const current = value?.runId === runId ? value : null
    const phase = current && (workflowSearchStage({ kind: current.kind, status: current.status, progress: current }) ?? (current.stage ? taskStageKeys[current.stage as keyof typeof taskStageKeys] : undefined))
    const primary = current?.kind === 'crop' ? { retrievedUnique: 'taskDistinct', cropGenerated: 'taskCrops', finalPassed: 'taskQualified' } as const : { candidates: 'taskCandidates', deepReviewed: 'taskDeepReviewed', qualified: 'taskQualified' } as const
    return <ui.Modal open={open} onClose={onClose} title={t('taskRunInformation')} closeLabel={t('close')} className="vc-canvas-task-modal" contentClassName="vc-canvas-task-shell" footer={onOpenResults ? <ui.Button variant="outline" disabled={!current || failed} onClick={onOpenResults}>{t('workflowTaskResults')}</ui.Button> : undefined}>
      <div className="vc-flow-result-heading"><div className="vc-flow-node-badges">{current && <><ui.Tag tone={current.status === 'failed' ? 'danger' : current.status === 'completed' ? 'success' : 'info'}>{t(current.status)}</ui.Tag>{phase && <span>{t(phase)}</span>}</>}</div><ui.Button size="sm" variant="outline" onClick={() => refresh(at => at + 1)}>{t('refresh')}</ui.Button></div>
      <div className="vc-canvas-task-scroll">
        {failed ? <p className="vc-notice" role="alert">{t('taskBatchReadFailed')}<ui.Button size="sm" variant="ghost" onClick={() => refresh(at => at + 1)}>{t('retry')}</ui.Button></p> : !current && <div role="status"><ui.StateDot state="ongoing" />{t('busy')}</div>}
        {current && <>
          <section className="vc-canvas-task-section"><h3>{t('workflowTaskRequirements')}</h3><p className="vc-flow-task-brief">{current.taskBrief}</p></section>
          <section className="vc-canvas-task-section"><h3>{t('workflowTaskProgress')}</h3><div className="vc-canvas-task-primary">{Object.entries(primary).map(([key, label]) => <div key={key}><span>{t(label)}</span><strong>{current.counts[key] ?? '—'}</strong></div>)}</div></section>
          <section className="vc-canvas-task-section"><h3>{t('workflowTaskDiagnostics')}</h3><dl className="vc-canvas-task-facts">{Object.entries(secondaryMetrics).flatMap(([key, label]) => current.counts[key] === undefined ? [] : [<div key={key}><dt>{t(label)}</dt><dd>{current.counts[key]}</dd></div>])}<div><dt>{t('workflowRequestCount')}</dt><dd>{current.requests}</dd></div></dl>
            {(current.errorCode || current.postProcessingError) && <p role="alert" className="vc-notice">{t(current.postProcessingError ? 'workflowHandoffFailed' : 'wallpaperTechnicalFailure')} <code>{current.postProcessingError ?? current.errorCode}</code></p>}
            {!!current.warnings.length && <details><summary>{t('workflowTaskWarnings')} · {current.warnings.length}</summary><ul>{current.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
          </section>
          <details className="vc-canvas-task-record"><summary>{t('workflowTaskRecords')}</summary><dl><div><dt>{t('workflowTaskCreatedAt')}</dt><dd><time dateTime={current.createdAt}>{new Date(current.createdAt).toLocaleString()}</time></dd></div><div><dt>{t('workflowTaskIdentifier')}</dt><dd><code>{current.runId}</code></dd></div></dl></details>
        </>}
      </div>
    </ui.Modal>
  }
}
