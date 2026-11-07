/** One Chat node per saved workflow; native projections supply its latest source checkpoints. */
/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { taskPresentationSchema, type TaskPresentation } from '../shared/task-presentation.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import type { presentationEn } from './task-presentation-locale.ts'
import type { SearchBatchDetail } from '../shared/search-batches.ts'
import { createCanvasTaskDialog } from './canvas-task-dialog.tsx'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Stable task identity; current producer data comes from the native sessionTasks projection. */
    'visual-curator-task': { readonly taskId: string }
  }
}

/** @returns A replayable anchor that never polls logs or starts background work. */
export function taskConversationDefinition(): ConversationNodeDefinition<{ taskId: string }> {
  return {
    kind: 'visual-curator-task', target: 'chat',
    match(event) {
      // A complete checkpoint can anchor a paged history window without its earlier checkpoints.
      return event.type === 'session/task' && event.data.provider === 'dsh-plugin-visual-curator' ? { id: event.data.taskId, role: 'start' } : null
    },
    start(_context, match) {
      if (match.event.type !== 'session/task') throw new Error('Expected a native task checkpoint')
      return { taskId: match.event.data.taskId }
    },
    update: context => {
      if (!context.state) throw new Error('Expected an initialized task anchor')
      return context.state
    },
    publication: () => 'animation-frame',
    buildViewNode(context) {
      const first = context.start ?? context.matches[0]
      if (!context.state || !first) return null
      return { key: context.key, kind: 'visual-curator-task', id: context.id, target: 'chat', data: context.state,
        anchorSeq: first.event.seq, location: { kind: 'session' as const }, visibility: 'visible' as const }
    },
  }
}

/** Session-scoped display sources and explicit controls supplied by the native Chat slot. */
export interface TaskConversationProps {
  node: ChatNode<'visual-curator-task'>; sessionId: string; t: WorkbenchText; useProjection: UseProjection
  operate(operation: 'stop' | 'resume' | 'sync', launchId: string, runId?: string): Promise<void>
  readTask(styleId: string, runId: string, signal: AbortSignal): Promise<SearchBatchDetail>
  openFile?(path: string): void
}
const phaseKeys: Record<string, keyof typeof presentationEn> = {
  planning: 'taskPresentationPlanning', retrieving: 'taskPresentationRetrieving', screening: 'taskPresentationScreening',
  reviewing: 'taskPresentationReviewing', cropping: 'taskPresentationCropping', finalizing: 'taskPresentationFinalizing',
}
const statusKeys: Record<string, keyof typeof presentationEn> = {
  created: 'taskPresentationWaiting', running: 'taskPresentationWorking', pausing: 'taskPresentationStopping',
  paused: 'taskPresentationPaused', interrupted: 'taskPresentationInterrupted', cancelling: 'taskPresentationStopping',
  cancelled: 'taskPresentationStopped', stopped: 'taskPresentationStopped', completed: 'taskPresentationFinished', failed: 'taskPresentationFailed',
}

/** @param React Shared runtime. @param ui Existing native primitives. @returns The registered workflow Chat renderer. */
export function createTaskConversation(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const TaskDialog = createCanvasTaskDialog(React, ui)
  type Run = Extract<TaskPresentation, { type: 'run' }>
  function RequestRows({ rows, t }: { rows: Run['requests']; t: WorkbenchText }) {
    return <ol className="vc-task-transcript-requests">{rows.map(row => <li key={row.id}>
      <div><code>{row.operation}</code><span>{t('taskPresentationAttempt')} {row.attempt}</span><ui.Tag tone={row.error ? 'warning' : row.state === 'committed' ? 'success' : 'neutral'}>{t(row.state === 'committed' ? 'taskPresentationRequestSaved' : row.state === 'reserved' ? 'taskPresentationRequestPending' : 'taskPresentationRequestUnknown')}</ui.Tag></div>
      <small>{new Date(row.createdAt).toLocaleString()}</small>
      {row.error && <p><code>{row.error.code}</code> · {row.error.safeMessage}</p>}
      {row.output && <pre aria-label={t('taskPresentationOutput')}>{row.output}</pre>}
    </li>)}</ol>
  }
  function RunSection({ run, t, operate, openTask }: { run: Run; t: WorkbenchText; operate(work: () => Promise<void>): void; openTask(id: string): Promise<void> }) {
    const [requestsOpen, setRequestsOpen] = React.useState(false), [failuresOpen, setFailuresOpen] = React.useState(false)
    const requestsId = React.useId(), failuresId = React.useId()
    const active = ['running', 'pausing', 'cancelling'].includes(run.status)
    const metrics: [string, keyof typeof presentationEn][] = [
      ['candidates', 'taskPresentationCandidates'], ['distinct', 'taskPresentationDistinct'], ['screeningReviewed', 'taskPresentationScreened'],
      ['deepReviewed', 'taskPresentationReviewed'], ['qualified', 'taskPresentationPassed'],
    ]
    return <section className="vc-task-transcript-run" data-task-run={run.runId} data-active={active || undefined}>
      <header><ui.StateDot state={active ? 'ongoing' : run.status === 'failed' ? 'error' : run.status === 'completed' ? 'done' : 'idle'} /><strong>{t(run.runKind === 'wallpaper' ? 'taskPresentationWallpaper' : 'taskPresentationSearch')}</strong><span>{t(statusKeys[run.status] ?? 'taskPresentationWorking')}</span></header>
      {active && <p role="status">{t(phaseKeys[run.stage ?? ''] ?? 'taskPresentationWorking')}</p>}
      <dl className="vc-task-transcript-metrics">{metrics.filter(([key]) => run.counts[key] !== undefined).map(([key, label]) => <div key={key}><dt>{t(label)}</dt><dd>{run.counts[key]}</dd></div>)}<div><dt>{t('taskPresentationRequests')}</dt><dd>{run.requestCount}</dd></div></dl>
      <small>{t('taskPresentationModel')} · {run.model.model}</small>
      {run.status === 'completed' && run.runKind === 'search' && (run.counts.qualified ?? 0) < run.target && <p className="vc-task-transcript-notice">{t('taskPresentationIncomplete')}</p>}
      {run.error && <p className="vc-task-transcript-notice" role="alert"><code>{run.error.code}</code> · {run.error.safeMessage}</p>}
      {!!run.warnings.length && <details className="vc-task-transcript-notice"><summary>{t('taskPresentationWarnings')} {run.warnings.length}</summary><ul>{run.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="vc-task-transcript-actions"><ui.Button size="sm" variant="ghost" aria-expanded={requestsOpen} aria-controls={requestsId} onClick={() => setRequestsOpen(!requestsOpen)}>{t('taskPresentationRequestDetails')} {run.requestCount}</ui.Button>
        {!!run.failures.length && <ui.Button size="sm" variant="ghost" aria-expanded={failuresOpen} aria-controls={failuresId} onClick={() => setFailuresOpen(!failuresOpen)}>{t('taskPresentationFailures')} {run.failures.length}</ui.Button>}
        <ui.Button size="sm" variant="outline" onClick={() => operate(() => openTask(run.runId))}>{t('taskRunInformation')}</ui.Button>
      </div>
      <ui.AnimatedCollapse id={requestsId} open={requestsOpen} keepMounted>{run.requests.length ? <RequestRows rows={run.requests} t={t} /> : <p>{t('taskPresentationNoRequests')}</p>}</ui.AnimatedCollapse>
      <ui.AnimatedCollapse id={failuresId} open={failuresOpen} keepMounted><RequestRows rows={run.failures} t={t} /></ui.AnimatedCollapse>
    </section>
  }
  return function TaskConversation({ node, sessionId, t, useProjection, operate, readTask, openFile }: TaskConversationProps) {
    const records = useProjection('sessionTasks')
    const [busy, setBusy] = React.useState(false), [failed, setFailed] = React.useState(false)
    const [detail, setDetail] = React.useState<string | null>(null)
    const pending = React.useRef(false)
    const sources = React.useMemo(() => (records ?? []).filter(record => record.provider === 'dsh-plugin-visual-curator' && record.taskId === node.data.taskId), [records, node.data.taskId])
    const rows = React.useMemo(() => sources.flatMap(record => { const parsed = taskPresentationSchema.safeParse(record.data); return parsed.success ? [parsed.data] : [] }), [sources])
    const owned = sources.length > 0 && sources.every(source => source.owner === sessionId)
    const launch = rows.find((row): row is Extract<TaskPresentation, { type: 'launch' }> => row.type === 'launch')
    const runs = rows.filter((row): row is Run => row.type === 'run'), common = launch ?? runs[0]
    const styleId = common?.styleId
    const readDetail = React.useCallback((runId: string, signal: AbortSignal) => {
      if (!styleId) return Promise.reject(new Error('Task collection is unavailable'))
      return readTask(styleId, runId, signal)
    }, [styleId, readTask])
    const openTask = React.useCallback(async (runId: string) => { setDetail(runId) }, [])
    const act = (work: () => Promise<void>) => {
      if (pending.current) return
      pending.current = true; setBusy(true); setFailed(false)
      void work().catch(() => setFailed(true)).finally(() => { pending.current = false; setBusy(false) })
    }
    if (!common) return <section className="vc-task-transcript" role={sources.length ? 'alert' : 'status'}><ui.StateDot state={sources.length ? 'error' : 'ongoing'} />{t(sources.length ? 'taskPresentationUnsupported' : 'taskPresentationLoading')}</section>
    const handoff = common.wallpaper && launch?.status === 'accepted' && !launch.stopping && !runs.some(run => run.runKind === 'wallpaper') && runs.some(run => run.runKind === 'search' && run.status === 'completed' && !run.error && (run.counts.qualified ?? 0) > 0)
    const active = handoff || launch?.status === 'working' || runs.some(run => ['created', 'running', 'pausing', 'cancelling'].includes(run.status))
    const attention = launch?.status === 'failed' || runs.some(run => !!run.error || ['failed', 'interrupted'].includes(run.status))
    const status = launch?.stopping ? 'taskPresentationStopping' : launch?.status === 'stopped' ? 'taskPresentationStopped' : handoff ? 'taskPresentationHandoff' : active ? 'taskPresentationWorking' : attention ? 'taskPresentationFailed' : runs.length ? 'taskPresentationFinished' : 'taskPresentationWaiting'
    const resumable = launch?.status !== 'stopped' && !launch?.stopping ? runs.find(run => run.continuation && !['created', 'running', 'pausing', 'cancelling'].includes(run.status)) : undefined
    const directory = launch?.directory
    return <article className="vc-task-transcript" data-conversation-workflow={node.data.taskId} aria-busy={busy}>
      <header className="vc-task-transcript-header"><ui.IconSearchOutlineRegular size={18} /><strong>{t('taskPresentationTitle')}</strong><ui.Tag>{`v${common.profileRevision}`}</ui.Tag><ui.Tag tone={active ? 'info' : attention ? 'warning' : 'neutral'}>{t(status)}</ui.Tag></header>
      <section className="vc-task-transcript-requirements"><h3>{t('taskPresentationRequirements')}</h3><p>{common.brief}</p><dl><div><dt>{t('taskPresentationTarget')}</dt><dd>{common.target}</dd></div><div><dt>{t('taskPresentationModel')}</dt><dd>{common.model.model}</dd></div>{common.datasetId && <div><dt>{t('taskPresentationDataset')}</dt><dd><code>{common.datasetId}</code></dd></div>}</dl></section>
      {!owned && <p className="vc-task-transcript-notice">{t('taskPresentationInherited')}</p>}
      {runs.map(run => <RunSection key={run.runId} run={run} t={t} operate={act} openTask={openTask} />)}
      {launch?.error && <p className="vc-task-transcript-notice" role="alert"><code>{launch.error.code}</code> · {launch.error.safeMessage}</p>}
      {directory && <section className="vc-task-transcript-delivery"><strong>{t('taskPresentationDirectory')}</strong><code>{directory}</code>{openFile && <ui.Button size="sm" variant="outline" onClick={() => openFile(directory)}>{t('taskPresentationOpenDirectory')}</ui.Button>}</section>}
      {failed && <p className="vc-task-transcript-notice" role="alert">{t('taskPresentationActionFailed')}</p>}
      {owned && <footer className="vc-task-transcript-actions">{active && <ui.Button size="sm" variant="outline" disabled={busy || launch?.stopping} onClick={() => act(() => operate('stop', common.launchId))}>{t('taskStopBackground')}</ui.Button>}
        {(resumable || launch?.status === 'failed' && !runs.length) && <ui.Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => operate('resume', common.launchId, resumable?.runKind === 'search' ? undefined : resumable?.runId))}>{t('taskPresentationContinue')}</ui.Button>}
        <ui.Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => operate('sync', common.launchId))}>{t('taskPresentationSync')}</ui.Button>
      </footer>}
      {detail && <TaskDialog key={detail} open runId={detail} read={readDetail} pollMs={common.pollMs} t={t} onClose={() => setDetail(null)} />}
    </article>
  }
}
