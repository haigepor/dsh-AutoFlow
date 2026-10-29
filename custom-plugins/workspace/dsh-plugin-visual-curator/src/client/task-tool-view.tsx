/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Session-scoped native tool cards read committed facts through their own observer. */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { WorkbenchText } from './workbench-locale.ts'
import type { ConversationFeedbackState } from './conversation-feedback.ts'
import { conversationRunSchema } from './conversation-feedback.ts'
import { safeResourcePath } from './store.ts'
import { taskStageKeys } from './search-feedback-locale.ts'
import { z } from 'zod'

export interface TaskFeedbackProps {
  openTask(runId: string): Promise<void>; t: WorkbenchText
  useFeedback<T>(selector: (state: ConversationFeedbackState) => T): T
  watch(runId: string): () => void; refresh(runId: string): void
}

/** @param React Shared runtime. @param ui Shared controls. @returns Native tool renderer with Session-scoped reads and navigation. */
export function createTaskToolView(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function TaskToolView({ phase, block, toolName, openTask, t, useFeedback, watch, refresh }: ToolCallViewProps & TaskFeedbackProps) {
    const [error, setError] = React.useState<'taskScopeFailed' | 'taskPanelUnavailable' | null>(null), [pending, setPending] = React.useState(false)
    const text = phase === 'result' ? block.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : ''
    const resultError = phase === 'result' && block.isError
    const value = React.useMemo(() => {
      if (phase !== 'result' || block.isError) return undefined
      try { return z.object({ runId: z.string().min(1).max(256) }).passthrough().parse(JSON.parse(text)) }
      catch (failure) { return undefined /* 历史错误和截断结果不能用于推断任务身份。 */ }
    }, [phase, text, resultError])
    const runId = value?.runId, entry = useFeedback(state => runId ? state.runs[runId] : undefined)
    React.useEffect(() => runId ? watch(runId) : undefined, [runId, watch])
    const saved = conversationRunSchema.safeParse(value)
    const run = entry?.run ?? (saved.success ? saved.data : undefined)
    const active = !!run && ['created', 'running', 'pausing', 'cancelling'].includes(run.status)
    const failed = phase === 'result' && block.isError || run?.status === 'failed'
    const title = t(toolName === 'visual_run_get' ? 'taskReadProgress' : toolName === 'visual_crop_start' ? 'cropKind' : 'searchKind')
    const stageKey = run?.stage ? taskStageKeys[run.stage as keyof typeof taskStageKeys] : undefined
    const categoryKey = { selected: 'taskFinal', review: 'taskReview', rejected: 'taskRejected', failed: 'taskTechnical', processing: 'taskProcessing', pending: 'taskPending', source: 'taskSourceImage' } as const
    const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : undefined }
    return <section className="vc-task-tool" data-task-tool={toolName} data-task-run={runId}>
      <div className="vc-task-tool-heading"><ui.StateDot state={failed ? 'error' : phase !== 'result' || active ? 'ongoing' : run?.status === 'completed' ? 'done' : 'idle'} /><span>{title}</span><span className="vc-task-tool-state">{run ? t(run.status) : t(failed ? 'failed' : phase === 'result' ? 'taskReading' : 'running')}{stageKey && <> · {t(stageKey)}</>}</span></div>
      {run && <dl className="vc-task-tool-metrics">
        {run.counts.candidates !== undefined && <div><dt>{t('taskCandidates')}</dt><dd>{run.counts.candidates}</dd></div>}
        {run.counts.distinct !== undefined && <div><dt>{t('taskDistinct')}</dt><dd>{run.counts.distinct}</dd></div>}
        {run.resultSummary && <><div data-result="selected"><dt>{t('taskFinal')}</dt><dd>{run.resultSummary.selected}{run.resultSummary.target !== null && <> / {run.resultSummary.target}</>}</dd></div><div><dt>{t('taskReview')}</dt><dd>{run.resultSummary.needsReview}</dd></div></>}
        {!!run.resultSummary?.technicalFailed && <div><dt>{t('taskTechnical')}</dt><dd>{run.resultSummary.technicalFailed}</dd></div>}
        {!!run.resultSummary?.unavailable && <div><dt>{t('taskUnavailable')}</dt><dd>{run.resultSummary.unavailable}</dd></div>}
      </dl>}
      {run && <small className="vc-task-feedback-note" data-feedback-freshness={entry?.freshness ?? 'saved'}>{t(entry?.freshness === 'current' && active ? 'taskLive' : 'taskSaved')}</small>}
      {!!run?.results.length && entry?.freshness !== 'stale' && <div className="vc-task-tool-previews" aria-label={t('taskPreview')}>{run.results.slice(0, 4).map(image => {
        const path = resource(image.previewPath)
        return path ? <a key={image.imageVersionId} href={path} target="_blank" rel="noreferrer"><img src={path} alt={image.name} loading="lazy" /><span>{t(categoryKey[image.resultCategory ?? 'processing'])}</span></a> : null
      })}</div>}
      {entry?.error && <p className="vc-task-feedback-note" role="status">{t('taskReadFailed')} <ui.Button size="sm" variant="ghost" onClick={() => runId && refresh(runId)}>{t('taskRefresh')}</ui.Button></p>}
      {run?.delivery && <p className="vc-task-feedback-note">{t(run.delivery.status === 'delivered' ? 'taskDeliveryReady' : 'taskDeliveryPending')}{run.delivery.directory && <span className="vc-task-directory">{run.delivery.directory}</span>}</p>}
      <div className="vc-task-tool-actions">{runId && <ui.Button variant="ghost" size="sm" disabled={pending} onClick={() => { setPending(true); setError(null); void openTask(runId).catch(failure => setError(failure instanceof Error && failure.message === 'panel-disabled' ? 'taskPanelUnavailable' : 'taskScopeFailed')).finally(() => setPending(false)) }}>{t('taskOpen')}</ui.Button>}
      {text && <details><summary>{t('taskRawDetails')}</summary><pre>{text}</pre></details>}</div>
      {error && <p role="alert">{t(error)}</p>}
    </section>
  }
}
