/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Cross-batch task inspection uses an authorized read without selecting its Session. */
import type { SearchBatchDetail } from '../shared/search-batches.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { taskStageKeys } from './search-feedback-locale.ts'

const metrics = { candidates: 'taskCandidates', distinct: 'taskDistinct', screeningReviewed: 'taskScreeningReviewed', screeningRejected: 'taskScreeningRejected', deepReviewed: 'taskDeepReviewed', qualified: 'taskQualified', unavailable: 'taskUnavailable', technicalFailed: 'taskTechnical', retrievedUnique: 'taskDistinct', cropGenerated: 'taskCrops', finalPassed: 'taskQualified' } as const

/** @param React Shared runtime. @param ui Native dialog primitives. @returns Source-scoped task detail with bounded observation and explicit read failures. */
export function createCanvasTaskDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function CanvasTaskDialog({ open, runId, read, pollMs, t, onClose }: { open: boolean; runId: string; read(runId: string, signal: AbortSignal): Promise<SearchBatchDetail>; pollMs: number; t: WorkbenchText; onClose(): void }) {
    const [value, setValue] = React.useState<SearchBatchDetail | null>(null), [failed, setFailed] = React.useState(false), [revision, refresh] = React.useState(0)
    React.useEffect(() => {
      if (!open) return
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
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
    const phase = value?.stage && taskStageKeys[value.stage as keyof typeof taskStageKeys]
    return <ui.Modal open={open} onClose={onClose} title={t('taskRunInformation')} closeLabel={t('close')} className="vc-canvas-task-modal">
      <div className="vc-flow-result-heading"><div className="vc-flow-node-badges">{value && <><ui.Tag tone={value.status === 'failed' ? 'danger' : value.status === 'completed' ? 'success' : 'neutral'}>{t(value.status)}</ui.Tag>{phase && <span>{t(phase)}</span>}</>}</div><ui.Button size="sm" variant="outline" onClick={() => refresh(current => current + 1)}>{t('refresh')}</ui.Button></div>
      {failed ? <p className="vc-notice" role="alert">{t('taskBatchReadFailed')}<ui.Button size="sm" variant="ghost" onClick={() => refresh(current => current + 1)}>{t('retry')}</ui.Button></p> : !value && <div role="status"><ui.StateDot state="ongoing" />{t('busy')}</div>}
      {value && <><p className="vc-flow-task-brief">{value.taskBrief}</p><div className="vc-canvas-task-facts">{Object.entries(metrics).flatMap(([key, label]) => value.counts[key] === undefined ? [] : [<div key={key}><span>{t(label)}</span><strong>{value.counts[key]}</strong></div>])}<div><span>{t('workflowRequestCount')}</span><strong>{value.requests}</strong></div></div>
        {(value.errorCode || value.postProcessingError) && <p role="alert" className="vc-notice">{t(value.postProcessingError ? 'workflowHandoffFailed' : 'wallpaperTechnicalFailure')} <code>{value.postProcessingError ?? value.errorCode}</code></p>}
        {!!value.warnings.length && <details><summary>{t('workflowTaskWarnings')} · {value.warnings.length}</summary><ul>{value.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        <small className="vc-flow-muted"><time dateTime={value.createdAt}>{new Date(value.createdAt).toLocaleString()}</time> · <code>{value.runId}</code></small>
      </>}
    </ui.Modal>
  }
}
