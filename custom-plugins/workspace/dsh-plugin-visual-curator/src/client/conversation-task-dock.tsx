/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** One upper-right conversation card switches saved launch requirements to actual Run feedback. */
import type { PointerEvent } from 'react'
import type { ConversationFeedbackState } from './conversation-feedback.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { createSelectField } from './select-field.tsx'
import { safeResourcePath } from './store.ts'
import type { RunResultFilter } from '../shared/search-feedback.ts'

export interface ConversationTaskDockProps {
  sessionId: string; t: WorkbenchText
  useFeedback<T>(selector: (state: ConversationFeedbackState) => T): T
  selectTask(runId: string): void; refreshTask(runId?: string): void; openTask(runId: string): Promise<void>
  stopTask?(runId: string): Promise<void>
  stopLaunch?(launchId: string): Promise<void>
  filterTask(runId: string, resultFilter: RunResultFilter): void
  loadMoreTask(runId: string): void
}

const DEFAULT_WIDTH = 300, MIN_WIDTH = 280, MAX_WIDTH = 640

/** @param React Shared runtime. @param ui Native accessible controls. @returns One Session-keyed task card with bounded pointer and keyboard width adjustment. */
export function createConversationTaskDock(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const SelectField = createSelectField(React, ui)
  function TaskDock({ t, useFeedback, selectTask, refreshTask, openTask, stopTask, stopLaunch, filterTask, loadMoreTask }: ConversationTaskDockProps) {
    const state = useFeedback(value => value), tasks = state.tasks
    const runId = state.selectedRunId, task = tasks?.items.find(item => item.runId === runId)
    const entry = runId ? state.runs[runId] : undefined, run = entry?.run
    const launch = !task ? tasks?.launch : undefined
    const [metric, setMetric] = React.useState<{ runId: string; key: 'selected' | 'candidates' | 'unique' | 'review' }>()
    const [expanded, setExpanded] = React.useState(false), [opening, setOpening] = React.useState(false), [openFailed, setOpenFailed] = React.useState(false)
    const [transitioning, setTransitioning] = React.useState(false)
    const [stopping, setStopping] = React.useState(false), [stopFailed, setStopFailed] = React.useState(false)
    const [width, setWidth] = React.useState<number | null>(null), [resizing, setResizing] = React.useState(false)
    const card = React.useRef<HTMLElement>(null), toggle = React.useRef<HTMLButtonElement>(null)
    const drag = React.useRef<{ pointerId: number; x: number; width: number; previous: number | null; max: number } | null>(null)
    const detailsId = React.useId()
    const visible = !!task || !!launch || !!tasks?.error
    React.useLayoutEffect(() => {
      const node = card.current
      if (!node) return
      // 当前 React 版本没有过渡取消回调，使用原生事件处理反向点击、隐藏及减少动态效果。
      const settle = (event: TransitionEvent) => {
        if (event.target === node && event.propertyName === 'flex-grow') setTransitioning(event.type === 'transitionrun')
      }
      const events = ['transitionrun', 'transitionend', 'transitioncancel'] as const
      for (const name of events) node.addEventListener(name, settle)
      return () => { for (const name of events) node.removeEventListener(name, settle) }
    }, [visible])
    const changeExpanded = (next: boolean) => {
      // 高度尚未稳定时先关闭滚动，避免内外滚动条在过渡中交替出现；零时长不等待结束事件。
      setTransitioning(!!card.current && getComputedStyle(card.current).transitionDuration.split(',').some(value => Number.parseFloat(value) > 0))
      setExpanded(next)
    }
    const maxWidth = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (card.current?.closest<HTMLElement>('[data-conversation-content]')?.clientWidth ?? DEFAULT_WIDTH + 608) - 608))
    const clamp = (value: number, maximum = maxWidth()) => Math.round(Math.min(maximum, Math.max(MIN_WIDTH, value)))
    const finishResize = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
      const current = drag.current
      if (!current || current.pointerId !== event.pointerId) return
      drag.current = null; setResizing(false)
      setWidth(cancelled ? current.previous : clamp(current.width + current.x - event.clientX, current.max))
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!task && launch) {
      const active = launch.status === 'working' || launch.status === 'accepted'
      const badge = launch.status === 'failed' ? 'failed' : launch.status === 'stopped' ? 'searchLaunchBadgeStopped' : launch.status === 'accepted' ? 'taskLaunchAwaitingSearch' : 'searchLaunchBadgePreparing'
      return <section ref={card} className="vc-conversation-task vc-conversation-launch" data-conversation-task="" data-conversation-launch={launch.id} data-expanded={expanded || undefined} aria-label={t('taskConversation')}
        onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}>
        <header className="vc-conversation-task-header"><span className="vc-conversation-task-title"><ui.IconSearchOutlineRegular size={16} />{t('searchKind')}</span><ui.Tag className="vc-conversation-task-status" tone={launch.status === 'failed' ? 'danger' : active ? 'info' : 'neutral'}><ui.StateDot state={active ? 'ongoing' : launch.status === 'failed' ? 'error' : 'idle'} />{t(badge)}</ui.Tag></header>
        <p className="vc-conversation-task-brief" title={launch.input.taskBrief}>{launch.input.taskBrief}</p>
        <div className="vc-conversation-launch-target"><span>{t('taskLaunchTarget')}</span><strong>{launch.input.targetCount}</strong></div>
        {active && <p className="vc-conversation-launch-phase" role="status">{t(launch.status === 'accepted' ? 'taskLaunchAcceptedHint' : launch.stage === 'preparing-dataset' ? 'searchLaunchDatasetPreparing' : launch.stage === 'submitting' ? 'taskLaunchSubmittingHint' : 'taskLaunchAttachingHint')}</p>}
        {launch.error && <p className="vc-conversation-task-notice" role="alert">{launch.error.safeMessage}</p>}
        {tasks?.error && <p className="vc-conversation-task-notice" role="alert">{t('taskReadFailed')}</p>}
        {stopFailed && <p className="vc-conversation-task-notice" role="alert">{t('taskStopFailed')}</p>}
        <footer className="vc-conversation-task-actions"><ui.Button ref={toggle} size="sm" variant="ghost" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'taskLaunchCollapse' : 'taskRunInformation')}<ui.IconChevronDownOutlineRegular size={12} /></ui.Button>
          {active && stopLaunch && <ui.Button size="sm" variant="outline" disabled={stopping} onClick={async () => { if (stopping) return; setStopping(true); setStopFailed(false); try { await stopLaunch(launch.id) } catch (error) { setStopFailed(true) } finally { setStopping(false) } }}>{stopping && <ui.StateDot state="ongoing" />}{t('taskStopBackground')}</ui.Button>}
        </footer>
        <ui.AnimatedCollapse id={detailsId} open={expanded} keepMounted><div className="vc-conversation-launch-body"><p className="vc-conversation-launch-brief">{launch.input.taskBrief}</p>{active && <p className="vc-conversation-task-notice">{t('taskLaunchPendingHint')}</p>}<ui.Button size="sm" variant="ghost" onClick={() => refreshTask()}>{t('taskRefresh')}</ui.Button></div></ui.AnimatedCollapse>
      </section>
    }
    if (!task && !tasks?.error) return null
    // 目录先收到终态时不能继续显示较旧详情中的运行状态。
    const newerTask = task?.revision !== undefined && (run?.revision === undefined || task.revision > run.revision)
    const status = newerTask ? task.status : run?.status ?? task?.status
    const active = !!status && ['created', 'running', 'pausing', 'cancelling'].includes(status)
    const categoryKey = { selected: run?.outputKind === 'preview' ? 'taskPreviewMatched' : 'taskFinal', review: 'taskReview', rejected: 'taskRejected', failed: 'taskTechnical', processing: 'taskProcessing', pending: 'taskPending', source: 'taskSourceImage' } as const
    const categoryTone = { selected: 'success', review: 'warning', rejected: 'quiet', failed: 'danger', processing: 'info', pending: 'neutral', source: 'info' } as const
    const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : undefined }
    const refresh = () => { refreshTask(); if (runId) refreshTask(runId) }
    const resultCount = run?.results.length ?? 0
    const resultFilter = entry?.resultFilter ?? 'all'
    const selectedMetric = metric && metric.runId === runId ? metric.key : resultFilter === 'selected' ? 'selected' : resultFilter === 'review' ? 'review' : 'candidates'
    const chooseMetric = (key: 'selected' | 'candidates' | 'unique' | 'review', filter: RunResultFilter) => {
      if (!runId) return
      setMetric({ runId, key }); filterTask(runId, filter); if (!expanded) changeExpanded(true)
    }
    const resultTotal = resultFilter === 'selected' ? run?.resultSummary?.selected : resultFilter === 'review' ? run?.resultSummary?.needsReview : run?.resultSummary?.candidates
    return <section ref={card} className="vc-conversation-task" data-conversation-task="" data-task-run={runId} data-expanded={expanded || undefined} data-transitioning={transitioning || undefined} data-resizing={resizing || undefined}
      style={width === null ? undefined : { width }} aria-label={t('taskConversation')}
      onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.stopPropagation(); changeExpanded(false); toggle.current?.focus() } }}>
      <ui.Tooltip label={t('taskResizeWidthHint')} side="left" portal>
        <div className="vc-conversation-task-resize" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t('taskResizeWidth')}
          aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth()} aria-valuenow={Math.min(width ?? DEFAULT_WIDTH, maxWidth())}
          onBlur={event => { if (getComputedStyle(event.currentTarget).display === 'none') toggle.current?.focus() }}
          onPointerDown={event => {
            if (event.button !== 0) return
            event.preventDefault(); event.currentTarget.focus()
            // 手势开始时读取所属会话的尺寸，右边缘保持不动，向左拖动增加宽度。
            drag.current = { pointerId: event.pointerId, x: event.clientX, width: card.current?.getBoundingClientRect().width ?? DEFAULT_WIDTH, previous: width, max: maxWidth() }
            event.currentTarget.setPointerCapture(event.pointerId); setResizing(true)
          }}
          onPointerMove={event => { const current = drag.current; if (current?.pointerId === event.pointerId) setWidth(clamp(current.width + current.x - event.clientX, current.max)) }}
          onPointerUp={event => finishResize(event)} onPointerCancel={event => finishResize(event, true)} onLostPointerCapture={event => finishResize(event, true)}
          onDoubleClick={() => setWidth(null)}
          onKeyDown={event => {
            if (event.key === 'Escape' && drag.current) {
              const current = drag.current; drag.current = null; setResizing(false); setWidth(current.previous)
              if (event.currentTarget.hasPointerCapture(current.pointerId)) event.currentTarget.releasePointerCapture(current.pointerId)
              event.preventDefault(); event.stopPropagation(); return
            }
            const delta = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : undefined
            if (delta !== undefined || event.key === 'Home' || event.key === 'End') {
              event.preventDefault(); const current = card.current?.getBoundingClientRect().width ?? DEFAULT_WIDTH
              setWidth(clamp(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maxWidth() : current + (delta ?? 0)))
            }
          }} />
      </ui.Tooltip>
      <header className="vc-conversation-task-header">
        <span className="vc-conversation-task-title">{task?.kind === 'crop' ? <ui.IconListPenOutlineRegular size={16} /> : <ui.IconSearchOutlineRegular size={16} />}{t(task?.kind === 'crop' ? 'cropKind' : 'searchKind')}</span>
        <ui.Tag className="vc-conversation-task-status" tone={status === 'failed' ? 'danger' : active ? 'info' : status === 'completed' ? 'success' : status === 'paused' || status === 'interrupted' ? 'warning' : 'neutral'}><ui.StateDot state={status === 'failed' ? 'error' : active ? 'ongoing' : status === 'completed' ? 'done' : 'idle'} />{status ? t(status) : t('taskReading')}</ui.Tag>
      </header>
      {tasks && tasks.items.length > 1
        ? <div className="vc-conversation-task-selector"><SelectField label={t('taskSwitch')} value={runId ?? ''} options={tasks.items.map(item => ({ value: item.runId, label: item.taskBrief || t(item.kind === 'crop' ? 'cropKind' : 'searchKind') }))} onChange={selectTask} /></div>
        : task?.taskBrief && <p className="vc-conversation-task-brief" title={task.taskBrief}>{task.taskBrief}</p>}
      {run && <div className="vc-conversation-task-metrics" role="group" aria-label={t('taskRunInformation')}>
        {run.resultSummary && <button type="button" data-result="selected" aria-pressed={selectedMetric === 'selected'} onClick={() => chooseMetric('selected', 'selected')}>
          <span className="vc-conversation-task-metric-label" title={t(run.outputKind === 'preview' ? 'taskPreviewMatched' : 'taskFinal')}>{t(run.outputKind === 'preview' ? 'taskPreviewMatched' : 'taskFinal')}</span>
          <span className="vc-conversation-task-stat"><strong>{run.resultSummary.selected}</strong>{run.resultSummary.target !== null && <small> / {run.resultSummary.target}</small>}</span>
        </button>}
        {run.counts.candidates !== undefined && <button type="button" data-result="candidates" aria-pressed={selectedMetric === 'candidates'} onClick={() => chooseMetric('candidates', 'all')}>
          <span className="vc-conversation-task-metric-label" title={t('taskCandidates')}>{t('taskCandidates')}</span>
          <span className="vc-conversation-task-stat"><strong>{run.counts.candidates}</strong></span>
        </button>}
        {run.counts.distinct !== undefined && <button type="button" data-result="unique" aria-pressed={selectedMetric === 'unique'} onClick={() => chooseMetric('unique', 'all')}>
          <span className="vc-conversation-task-metric-label" title={t(run.outputKind === 'preview' ? 'taskUniqueLinks' : 'taskDistinct')}>{t(run.outputKind === 'preview' ? 'taskUniqueLinks' : 'taskDistinct')}</span>
          <span className="vc-conversation-task-stat"><strong>{run.counts.distinct}</strong></span>
        </button>}
        {run.resultSummary && <button type="button" data-result="review" aria-pressed={selectedMetric === 'review'} onClick={() => chooseMetric('review', 'review')}>
          <span className="vc-conversation-task-metric-label" title={t('taskReview')}>{t('taskReview')}</span>
          <span className="vc-conversation-task-stat"><strong>{run.resultSummary.needsReview}</strong></span>
        </button>}
      </div>}
      {(tasks?.error || entry?.error) && <p className="vc-conversation-task-notice" role="status">{t('taskReadFailed')} <ui.Button size="sm" variant="ghost" onClick={refresh}>{t('taskRefresh')}</ui.Button></p>}
      <div className="vc-conversation-task-actions">
        {runId && <ui.Button size="sm" variant="outline" disabled={opening} onClick={() => { setOpening(true); setOpenFailed(false); void openTask(runId).catch(() => setOpenFailed(true)).finally(() => setOpening(false)) }}>{t('taskOpen')}</ui.Button>}
        {active && runId && stopTask && <ui.Button size="sm" variant="ghost" disabled={stopping || status === 'cancelling'} onClick={() => { setStopping(true); setStopFailed(false); void stopTask(runId).catch(() => setStopFailed(true)).finally(() => setStopping(false)) }}>{t(stopping || status === 'cancelling' ? 'cancelling' : 'taskStopBackground')}</ui.Button>}
        <ui.Button ref={toggle} size="sm" variant="ghost" aria-expanded={expanded} aria-controls={detailsId} onClick={() => changeExpanded(!expanded)}>{t(expanded ? 'taskCollapse' : 'taskExpand')}<ui.IconChevronDownOutlineRegular size={12} /></ui.Button>
      </div>
      {openFailed && <p className="vc-conversation-task-notice" role="alert">{t('taskScopeFailed')}</p>}
      {stopFailed && <p className="vc-conversation-task-notice" role="alert">{t('taskStopFailed')}</p>}
      <ui.AnimatedCollapse id={detailsId} open={expanded} keepMounted className="vc-conversation-task-collapse" contentClassName="vc-conversation-task-collapse-content"><div className="vc-conversation-task-details">
        <div className="vc-conversation-task-results-heading"><span>{t(resultFilter === 'selected' ? run?.outputKind === 'preview' ? 'taskPreviewMatched' : 'taskFinal' : resultFilter === 'review' ? 'taskReview' : selectedMetric === 'unique' ? run?.outputKind === 'preview' ? 'taskUniqueLinks' : 'taskDistinct' : 'taskPreview')}</span><small>{resultCount} / {resultTotal ?? resultCount}</small></div>
        {run && resultCount > 0 && entry?.error !== 'owner-denied' && <div className="vc-conversation-task-previews">{run.results.map(image => {
          const path = resource(image.previewPath)
          return path ? <a key={image.imageVersionId} href={path} target="_blank" rel="noreferrer"><span className="vc-conversation-task-media"><img src={path} alt={image.name} loading="lazy" /></span><ui.Tag tone={categoryTone[image.resultCategory ?? 'processing']}>{t(categoryKey[image.resultCategory ?? 'processing'])}</ui.Tag></a> : null
        })}</div>}
        {!resultCount && <p className="vc-conversation-task-notice">{t(!run || entry?.freshness === 'loading' ? 'taskReading' : 'taskDockNoResults')}</p>}
        {run?.pageToken && runId && <ui.Button className="vc-conversation-task-more" size="sm" variant="outline" disabled={entry?.loadingMore} onClick={() => loadMoreTask(runId)}>{entry?.loadingMore && <ui.StateDot state="ongoing" />}{t('taskMoreResults')}</ui.Button>}
        {!!(run?.resultSummary?.technicalFailed || run?.resultSummary?.unavailable) && <p className="vc-conversation-task-notice">{!!run?.resultSummary?.technicalFailed && <span>{t('taskTechnical')} {run.resultSummary.technicalFailed}</span>}{!!run?.resultSummary?.unavailable && <span>{t('taskUnavailable')} {run.resultSummary.unavailable}</span>}</p>}
        {run?.delivery && <div className="vc-conversation-task-delivery"><ui.IconDownloadOutlineRegular size={14} /><div><span>{t(run.delivery.status === 'delivered' ? 'taskDeliveryReady' : 'taskDockDeliveryPending')}</span>{run.delivery.directory && <small className="vc-task-directory">{run.delivery.directory}</small>}</div></div>}
      </div></ui.AnimatedCollapse>
    </section>
  }
  return function ConversationTaskDock(props: ConversationTaskDockProps) { return <TaskDock key={props.sessionId} {...props} /> }
}
