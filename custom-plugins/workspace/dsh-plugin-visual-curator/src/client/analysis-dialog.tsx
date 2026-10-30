/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Model conversation and independent task controls, composed with the Host's primitives. */
import { analysisActive, type AnalysisTask, type AnalysisMessage, type AnalysisDetail } from '../shared/analysis-process.ts'
import { analysisAnswer, observationsMarkdown, providerMarkdown } from './analysis-markdown.ts'
import type { ClientState } from './store.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { createAnalysisInput } from './analysis-input.tsx'
import { createAnalysisIcon } from './analysis-icons.tsx'
import { safeResourcePath } from './store.ts'
import type { AnalysisInput as SavedInput } from '../shared/analysis-process.ts'
import { analysisNavigation } from './analysis-navigation.ts'
import { createSelectField } from './select-field.tsx'
import { analysisContextUsage, type AnalysisContextUsage } from './analysis-context.ts'
import sidebarArtwork from '../../assets/analysis-sidebar-accent-v1.webp'
import { createAnalysisDiagnostics, analysisIssues, analysisCanContinue, analysisContinuationHint, analysisFailureSummary } from './analysis-diagnostics.tsx'

/** @param t Plugin locale. @param phase Task phase. @returns Localized phase name. */
export function analysisPhaseLabel(t: WorkbenchText, phase: AnalysisTask['phase']): string {
  const keys = { queued: 'analysisQueued', preparing: 'analysisPreparing', analyzing: 'analyzingImages', receiving: 'analysisReceiving', validating: 'analysisValidating', retrying: 'analysisRetrying', summarizing: 'summarizingStyle', saving: 'analysisSaving', completed: 'completed', interrupted: 'interrupted', cancelled: 'cancelled', paused: 'paused', failed: 'failed' } as const
  return t(keys[phase])
}
/** @param React Host React instance. @param ui Existing accessible primitives. @returns Process dialog with independent output and activity views. */
export function createAnalysisDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Modal, Button, StateDot, DisclosureRow, SegmentedTabs, Tag } = ui
  const SelectField = createSelectField(React, ui)
  const AnalysisInput = createAnalysisInput(React, ui)
  const AnalysisIcon = createAnalysisIcon(React)
  const AnalysisDiagnostics = createAnalysisDiagnostics(React, ui)
  function ContextUsage({ value, t }: { value: AnalysisContextUsage; t: WorkbenchText }) {
    const { usedTokens, contextWindow, percent } = value
    const reading = percent === undefined ? '—' : `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    const used = usedTokens?.toLocaleString() ?? '—', capacity = contextWindow?.toLocaleString() ?? '—'
    const hint = t(value.retained ? 'analysisContextUpdating' : contextWindow === undefined ? 'analysisContextUnrecorded' : usedTokens === undefined ? 'analysisContextPending' : 'analysisContextIncludes')
    return <section className="vc-context-usage" aria-label={t('analysisContextUsage')}>
      <div className="vc-context-heading"><h3>{t('analysisContextUsage')}</h3><small>{t(value.retained ? 'analysisContextRetained' : 'analysisContextLatest')}</small></div>
      <div className="vc-context-body"><div className="vc-context-ring" role="progressbar" aria-label={t('analysisContextUsage')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${reading} · ${used} / ${capacity} · ${hint}`}>
        <svg viewBox="0 0 56 56" aria-hidden="true"><circle className="vc-context-track" cx="28" cy="28" r="24" /><circle className="vc-context-fill" cx="28" cy="28" r="24" pathLength="100" strokeDasharray={`${percent ?? 0} 100`} transform="rotate(-90 28 28)" /></svg><span aria-hidden="true">{reading}</span>
      </div><dl className="vc-context-details"><div><dt>{t('analysisContextUsed')}</dt><dd>{used}</dd></div><div><dt>{t('modelContextWindow')}</dt><dd>{capacity}</dd></div></dl></div>
      <p className="vc-context-hint">{hint}</p>
    </section>
  }
  function ContextSkeleton() {
    return <section className="vc-context-usage vc-context-skeleton" aria-hidden="true"><div className="vc-context-heading"><span className="vc-skeleton-fill vc-skeleton-title" /><span className="vc-skeleton-fill vc-skeleton-short" /></div><div className="vc-context-body"><span className="vc-skeleton-fill vc-context-skeleton-ring" /><div className="vc-context-skeleton-details"><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /></div></div><span className="vc-skeleton-fill vc-skeleton-caption" /></section>
  }
  function InformationSkeleton() {
    return <><section className="vc-process-model vc-model-skeleton" aria-hidden="true"><span className="vc-skeleton-fill vc-skeleton-title" /><div className="vc-model-skeleton-controls"><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /></div></section><ContextSkeleton /><section className="vc-process-usage vc-usage-skeleton" aria-hidden="true"><span className="vc-skeleton-fill vc-skeleton-title" /><div><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /></div><span className="vc-skeleton-fill vc-skeleton-caption" /></section></>
  }
  function NavigationSkeleton() {
    return <section className="vc-process-navigation vc-navigation-skeleton" aria-hidden="true"><span className="vc-skeleton-fill vc-skeleton-title" /><span className="vc-skeleton-fill vc-skeleton-caption" /><div>{['first', 'second', 'third', 'fourth'].map(slot => <div className="vc-navigation-skeleton-row" key={slot}><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /></div>)}</div></section>
  }
  const unavailableAttachment = async () => { throw new Error('Only authorized preview references are supplied by this view.') }
  type EvidenceProps = { images: SavedInput['images']; onReadInput(requestId: string): void }
  function Evidence({ imageId, images, onReadInput, detail, t, renderFactorySlot }: { imageId: string; detail: AnalysisDetail; t: WorkbenchText } & EvidenceProps & PropsRenderFactories) {
    const image = images.find(item => item.imageVersionId === imageId)
    const path = image && safeResourcePath(image.previewPath)
    const thumbnail = image?.thumbnailPath && safeResourcePath(image.thumbnailPath)
    const name = image?.name ?? detail.images.find(item => item.imageVersionId === imageId)?.name ?? t('chatImage')
    const element = React.useRef<HTMLDivElement>(null), requested = React.useRef<string | null>(null)
    const request = detail.requests.find(item => item.available && item.imageIds.includes(imageId))
    // 归纳可能引用其他批次的图片；只从本任务对应请求读取，复用现有缓存与请求去重。
    React.useEffect(() => {
      if (path || !request || !element.current || requested.current === request.requestId) return
      const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); requested.current = request.requestId; onReadInput(request.requestId) } }, { root: element.current.closest('.vc-chat-feed') })
      observer.observe(element.current)
      return () => observer.disconnect()
    }, [path, request?.requestId, onReadInput])
    return <div ref={element} className="vc-evidence-image">{path ? renderFactorySlot('conversation.images.content', { images: [{ preview: { url: new URL(path.slice(1), document.baseURI).href, ...(thumbnail ? { thumbnailUrl: new URL(thumbnail.slice(1), document.baseURI).href } : {}), name } }], loadImage: unavailableAttachment, align: 'start', thumbnail: true }) : <span className="vc-evidence-placeholder" role="img" aria-label={t('outputPreviewUnavailable')}><AnalysisIcon kind="image" size={24} /></span>}</div>
  }
  function Observations({ rows, detail, images, onReadInput, imageIds, t, renderFactorySlot }: { rows: AnalysisDetail['observations']; detail: AnalysisDetail; images: SavedInput['images']; onReadInput(requestId: string): void; imageIds?: string[]; t: WorkbenchText } & PropsRenderFactories) {
    return <section>{renderFactorySlot('conversation.chat.assistant.content', { text: observationsMarkdown(rows, detail, t, imageIds), streaming: false })}<div className="vc-answer-evidence">{rows.map(row => <Evidence key={row.imageVersionId} imageId={row.imageVersionId} images={images} onReadInput={onReadInput} detail={detail} t={t} renderFactorySlot={renderFactorySlot} />)}</div></section>
  }
  function ModelMessage({ message, detail, images, onReadInput, t, renderFactorySlot, hideAnswer = false }: { message: AnalysisMessage; detail: AnalysisDetail; images: SavedInput['images']; onReadInput(requestId: string): void; t: WorkbenchText; hideAnswer?: boolean } & PropsRenderFactories) {
    const [reasoningOpen, setReasoningOpen] = React.useState<boolean | null>(null), [rawOpen, setRawOpen] = React.useState(false)
    const streaming = message.state === 'streaming'
    const preparing = streaming && detail.process?.phase === 'preparing'
    const stateLabel = message.state === 'streaming' ? preparing ? 'analysisPreparing' : message.reasoning && !message.content ? 'modelThinking' : message.content ? 'modelWriting' : 'modelWaiting' : message.state === 'complete' ? 'completed' : message.state
    const answer = React.useMemo(() => analysisAnswer(message, detail, t), [message, detail, t])
    return <article className="vc-chat-message" data-message-sequence={message.sequence} aria-busy={streaming}>
      <header className="vc-chat-message-header"><span className="vc-model-status">{streaming && <StateDot state="ongoing" />}{t(stateLabel)}</span><span className="vc-chat-batch-label">{t(message.kind === 'summary' ? 'processSummary' : 'batchObservations')}{message.kind === 'analysis' && <> · {message.batch}</>}</span><span className="vc-chat-message-spacer" /><span title={detail.task.model}>{detail.task.model}</span></header>
      <div className="vc-chat-message-body">
        {message.reasoning && <DisclosureRow className="vc-chat-reasoning" icon={<ui.IconThinkOutlineRegular size={14} />} title={t('processReasoning')} running={streaming && !message.content} open={reasoningOpen ?? streaming} expandable expandOnRowClick onToggle={() => setReasoningOpen(value => !(value ?? streaming))}>{renderFactorySlot('conversation.chat.reasoning.content', { text: message.reasoning, running: streaming && !message.content })}</DisclosureRow>}
        {!hideAnswer && answer.text && <div className="vc-native-answer" data-structured={answer.structured}>{renderFactorySlot('conversation.chat.assistant.content', { text: answer.text, streaming, interrupted: message.state !== 'complete' && !streaming })}</div>}
        {!hideAnswer && !answer.text && (!streaming || !message.reasoning) && <p className="vc-chat-waiting" role="status">{t(preparing ? 'analysisPreparing' : streaming ? 'modelFirstOutputHint' : message.state === 'complete' ? 'analysisOutputBounded' : 'processBatchUnfinished')}</p>}
        {!hideAnswer && answer.evidence.length > 0 && <div className="vc-answer-evidence" aria-label={t('inputImagesHeading')}>{answer.evidence.map(id => <Evidence key={id} imageId={id} images={images} onReadInput={onReadInput} detail={detail} t={t} renderFactorySlot={renderFactorySlot} />)}</div>}
        {message.content && (answer.structured || streaming || hideAnswer) && <DisclosureRow className="vc-chat-raw" icon={<ui.IconCodeOutlineRegular size={14} />} title={t('providerOutput')} open={rawOpen} expandable expandOnRowClick onToggle={() => setRawOpen(value => !value)}>{renderFactorySlot('conversation.chat.assistant.content', { text: providerMarkdown(message.content), streaming })}</DisclosureRow>}
      </div>
    </article>
  }
  return function AnalysisDialog({ state, t, onClose, onStop, onPause, onResume, onReanalyze, reanalysisDisabled, onRetry, onReadInput, renderFactorySlot }: { state: ClientState; t: WorkbenchText; onClose(): void; onStop(runId: string): void; onPause?(runId: string): void; onResume?(runId: string): void; onReanalyze?(styleId: string): void; reanalysisDisabled?: boolean; onRetry(): void; onReadInput(requestId: string): void; renderFactorySlot: PropsRenderFactories['renderFactorySlot'] }) {
    const [view, setView] = React.useState<'output' | 'activity' | 'requests' | 'diagnostics'>('output'), [following, setFollowing] = React.useState(true)
    const [navigation, setNavigation] = React.useState<number | null>(null)
    const [selectedSequence, setSelectedSequence] = React.useState<number | null>(null)
    const [processDisclosure, setProcessDisclosure] = React.useState<{ runId: string; final: boolean; open: boolean } | null>(null)
    const feed = React.useRef<HTMLDivElement>(null), follow = React.useRef(true), outputScroll = React.useRef(0), tabId = React.useId()
    const detail = state.analysisDetail, task = detail?.task ?? state.analysisTasks.find(item => item.runId === state.analysisRunId), process = detail?.process
    const initialLoading = state.analysisLoading && !detail
    const active = !!task && analysisActive(task.status), stopping = task?.status === 'cancelling' || state.pending.includes(`stop:${state.analysisRunId}`)
    const pausing = task?.status === 'pausing' || state.pending.includes(`pause:${state.analysisRunId}`), resuming = state.pending.includes(`resume:${state.analysisRunId}`)
    const images = detail?.requests.flatMap(request => state.analysisInputs[request.requestId]?.images ?? []) ?? []
    const messages = process?.messages ?? []
    const navigationEntries = analysisNavigation(messages)
    const issues = detail ? analysisIssues(detail) : []
    const canContinue = !!task && analysisCanContinue(task)
    const recovered = task?.status === 'completed' && task.outcome !== 'budget-exhausted'
    const messageStateLabel = (value: AnalysisMessage['state']) => t(value === 'streaming' ? 'running' : value === 'complete' ? 'completed' : recovered && value === 'failed' ? 'analysisHistoricalFailure' : recovered && value === 'interrupted' ? 'analysisHistoricalInterrupted' : value)
    const nativeCalls = detail?.requests.flatMap(request => request.native ? [request.native] : []) ?? []
    const contextUsage = analysisContextUsage(detail?.requests ?? [])
    const usage = nativeCalls.flatMap(call => call.usage ? [call.usage] : [])
    const cacheAvailable = usage.length > 0 && usage.every(item => item.cacheReadTokens !== undefined)
    const inputTokens = usage.reduce((sum, item) => sum + item.inputTokens + (item.cacheReadTokens ?? 0) + (item.cacheWriteTokens ?? 0), 0)
    const cacheReadTokens = usage.reduce((sum, item) => sum + (item.cacheReadTokens ?? 0), 0)
    const summaryMessage = messages.filter(message => message.kind === 'summary' && message.state === 'complete').at(-1)
    const finalAnswer = detail && summaryMessage && task?.status === 'completed' && task.outcome !== 'budget-exhausted' ? analysisAnswer(summaryMessage, detail, t) : undefined
    const hasFinal = finalAnswer?.structured === true
    // 成功归纳后切换到收起的默认值；手动展开保留到当前任务或完成状态改变。
    const processOpen = processDisclosure?.runId === state.analysisRunId && processDisclosure.final === hasFinal ? processDisclosure.open : !hasFinal
    const setProcessOpen = (open: boolean) => setProcessDisclosure({ runId: state.analysisRunId, final: hasFinal, open })
    const linked = new Set(messages.flatMap(message => message.requestId ? [message.requestId] : []))
    const unlinked = detail?.requests.filter(request => !linked.has(request.requestId)) ?? []
    const tabs = React.useMemo(() => [{ value: 'output', label: t('processModelOutput'), id: `${tabId}-output-tab`, panelId: `${tabId}-output` }, { value: 'activity', label: t('analysisTimeline'), id: `${tabId}-activity-tab`, panelId: `${tabId}-activity` }, { value: 'requests', label: `${t('analysisRequestsTab')}${detail?.requests.length ? ` · ${detail.requests.length}` : ''}`, id: `${tabId}-requests-tab`, panelId: `${tabId}-requests` }, { value: 'diagnostics', label: `${t('analysisDiagnosticsTab')}${issues.length ? ` · ${issues.length}` : ''}`, id: `${tabId}-diagnostics-tab`, panelId: `${tabId}-diagnostics` }] as const, [tabId, t, detail?.requests.length, issues.length])
    React.useLayoutEffect(() => { follow.current = true; outputScroll.current = 0; setFollowing(true); setView('output'); setNavigation(null); setSelectedSequence(null) }, [state.analysisRunId])
    // 只有输出页处于末尾时跟随；切换到日志不会丢失模型正文的阅读位置。
    React.useLayoutEffect(() => { if (view === 'output' && feed.current) feed.current.scrollTop = follow.current ? feed.current.scrollHeight : outputScroll.current }, [view, state.analysisRunId, process?.updatedAt, detail?.observations.length])
    React.useLayoutEffect(() => {
      if (navigation === null || view !== 'output' || !feed.current) return
      const scroller = feed.current
      const target = scroller.querySelector<HTMLElement>(hasFinal && navigation === summaryMessage?.sequence ? '.vc-final-summary' : `[data-exchange-sequence="${navigation}"]`)
      if (!target) return
      let cancelled = false
      const anchor = target.querySelector<HTMLElement>('.vc-chat-message') ?? target
      const align = () => { scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16; outputScroll.current = scroller.scrollTop }
      const frame = requestAnimationFrame(() => {
        align(); target.focus({ preventScroll: true })
        // 原生折叠组件展开会改变可滚动高度；结束后再次定位，避免目标被提前截断。
        const collapse = target.closest('.vc-process-disclosure')?.querySelector(':scope > [data-expanded]')
        void Promise.allSettled((collapse?.getAnimations() ?? []).map(animation => animation.finished)).then(() => { if (!cancelled) { align(); setNavigation(null) } })
      })
      return () => { cancelled = true; cancelAnimationFrame(frame) }
    }, [navigation, view, processOpen, hasFinal, summaryMessage?.sequence])
    const navigate = (sequence: number) => { follow.current = false; setFollowing(false); setSelectedSequence(sequence); setProcessOpen(!(hasFinal && sequence === summaryMessage?.sequence)); setView('output'); setNavigation(sequence) }
    const latest = () => { follow.current = true; setFollowing(true); setSelectedSequence(null); if (feed.current) feed.current.scrollTop = feed.current.scrollHeight }
    const inspectInput = (requestId: string) => { follow.current = false; setFollowing(false); outputScroll.current = feed.current?.scrollTop ?? 0; onReadInput(requestId) }
    const latestMessage = messages.at(-1)
    const phase = task?.outcome === 'budget-exhausted' ? t('budgetExhausted') : task ? ['pausing', 'cancelling', 'paused'].includes(task.status) ? t(task.status === 'pausing' ? 'pausing' : task.status === 'cancelling' ? 'cancelling' : 'paused') : active && task.phase === 'paused' ? t('analysisQueued') : active && task.phase === 'receiving' ? t(latestMessage?.reasoning && !latestMessage.content ? 'modelThinking' : latestMessage?.content ? 'modelWriting' : 'modelWaiting') : analysisPhaseLabel(t, task.phase) : t('busy')
    const processError = state.analysisError ?? (task?.status === 'failed' ? task.error : undefined)
    return <Modal open={!!state.analysisRunId} onClose={onClose} title={`${t('analysisProcess')}${task ? ` · ${task.name}` : ''}`} headless className="vc-analysis-modal">
      <header className="vc-process-dialog-header"><div className="vc-process-title"><h2>{t('analysisProcess')}</h2>{task && <p title={task.name}>{task.name}</p>}</div>{task && <div className="vc-process-summary"><div className="vc-analysis-status" role="status" aria-live="polite"><StateDot state={active ? 'ongoing' : task.status === 'completed' && task.outcome !== 'budget-exhausted' ? 'done' : 'warning'} /><strong>{phase}</strong></div><div className="vc-chat-count"><span>{t(active ? 'analysisProgress' : 'processSaved')}</span><strong>{task.observed}</strong><span>/ {task.total}</span></div></div>}<Button size="sm" variant="ghost" className="vc-process-close" aria-label={t('close')} onClick={onClose}><ui.IconCloseOutlineRegular size={16} /></Button></header>
      {task && active && <div className="vc-chat-progress"><progress className="vc-analysis-progress" max={Math.max(1, task.total)} value={task.observed} aria-label={t('analysisProgress')} /></div>}
      {processError && <div className="vc-process-error" role="alert"><span title={processError.safeMessage}>{analysisFailureSummary(processError, t)}</span><div className="vc-dataset-actions"><Button size="sm" variant="ghost" onClick={() => setView('diagnostics')}>{t('analysisDiagnosticsTab')}</Button><Button size="sm" onClick={onRetry}>{t('refresh')}</Button></div></div>}
      <div className="vc-process-toolbar"><SegmentedTabs className="vc-process-tabs" variant="underline" label={t('analysisProcess')} items={tabs} value={view} onChange={setView} />
      {navigationEntries.length > 0 && <div className="vc-process-mobile-nav"><SelectField label={t('analysisBatches')} value={selectedSequence === null ? '' : String(selectedSequence)} options={navigationEntries.map(entry => ({ value: String(entry.sequence), label: `${t(entry.kind === 'summary' ? 'processSummary' : 'analysisBatch')}${entry.batch === undefined ? '' : ` ${entry.batch}`} · ${messageStateLabel(entry.state)}${entry.attempts > 1 ? ` · ${t('analysisRequestAttempt')} ${entry.attempt}/${entry.attempts}` : ''}` }))} onChange={value => { const entry = navigationEntries.find(entry => String(entry.sequence) === value); if (entry) navigate(entry.sequence) }} /></div>}
      </div>
      {(initialLoading || detail) && <div className="vc-process-mobile-context" aria-busy={initialLoading}>{initialLoading ? <ContextSkeleton /> : <ContextUsage value={contextUsage} t={t} />}</div>}
      <div className="vc-process-layout"><div className="vc-chat-panels">
        <div ref={feed} id={`${tabId}-output`} role="tabpanel" aria-labelledby={`${tabId}-output-tab`} hidden={view !== 'output'} className="vc-chat-feed" onScroll={() => { const element = feed.current; if (!element || view !== 'output') return; outputScroll.current = element.scrollTop; const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 64; follow.current = nearEnd; setFollowing(nearEnd) }}>
          <div role="log" aria-live="off" aria-label={t('modelConversation')}>
            {detail && (messages.length > 0 || detail.observations.length > 0) && <DisclosureRow className="vc-process-disclosure" icon={<ui.IconThinkOutlineRegular size={14} />} title={t('processDetails')} open={processOpen} running={active} expandable expandOnRowClick onToggle={() => setProcessOpen(!processOpen)} collapsedContent={<span className="vc-process-disclosure-count">{task?.observed} / {task?.total}</span>}>
            {unlinked.length > 0 && <section className="vc-input-history"><h3>{t('inputHistory')}</h3><p>{t('inputHistoryHint')}</p>{unlinked.map(request => <AnalysisInput key={request.requestId} request={request} state={state} t={t} onRead={onReadInput} onInspect={inspectInput} renderFactorySlot={renderFactorySlot} />)}</section>}
            {detail && messages.map(message => {
              const request = detail.requests.find(item => item.requestId === message.requestId)
              return <div key={message.sequence} id={`${tabId}-message-${message.sequence}`} className="vc-request-exchange" data-exchange-sequence={message.sequence} data-selected-batch={selectedSequence === message.sequence || undefined} tabIndex={-1}>{request && <AnalysisInput request={request} state={state} t={t} onRead={onReadInput} onInspect={inspectInput} renderFactorySlot={renderFactorySlot} />}<ModelMessage message={message} detail={detail} images={images} onReadInput={onReadInput} t={t} renderFactorySlot={renderFactorySlot} hideAnswer={hasFinal && message.sequence === summaryMessage?.sequence} /></div>
            })}
            {detail && !messages.length && detail.observations.length > 0 && <article className="vc-chat-message"><header className="vc-chat-message-header"><strong>{t('sampleObservations')}</strong></header><Observations rows={detail.observations} detail={detail} images={images} onReadInput={onReadInput} t={t} renderFactorySlot={renderFactorySlot} /></article>}
            {detail && !messages.length && process?.reasoning && renderFactorySlot('conversation.chat.reasoning.content', { text: process.reasoning, running: active && !process.content })}
            {process?.truncated && <p className="vc-chat-retention">{t('analysisOutputBounded')}</p>}
            </DisclosureRow>}
            {hasFinal && finalAnswer && <article id={`${tabId}-final-summary`} className="vc-final-summary" aria-label={t('finalSummary')} data-selected-batch={selectedSequence === summaryMessage?.sequence || undefined} tabIndex={-1}><h3>{t('finalSummary')}</h3>{renderFactorySlot('conversation.chat.assistant.content', { text: finalAnswer.text, streaming: false })}</article>}
            {initialLoading ? <div className="vc-chat-loading" role="status" aria-label={t('busy')} aria-busy="true"><div className="vc-chat-loading-input vc-skeleton-fill" aria-hidden="true" /><div className="vc-chat-loading-answer" aria-hidden="true"><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /></div></div> : (!detail || !messages.length && !detail.observations.length) && <div className="vc-chat-empty"><StateDot state={active ? 'ongoing' : 'idle'} /><p>{t(active ? 'modelWaiting' : 'processNoSavedOutput')}</p></div>}
          </div>
        </div>
        {view === 'activity' && <div id={`${tabId}-activity`} role="tabpanel" aria-labelledby={`${tabId}-activity-tab`} className="vc-process-log">{task && <dl className="vc-chat-config"><div><dt>{t('model')}</dt><dd title={task.model}>{task.model}</dd></div><div><dt>{t('reasoningEffort')}</dt><dd>{task.reasoningEffort ?? t('providerDefault')}</dd></div><div><dt>{t('analysisAttempt')}</dt><dd>{task.attempts}</dd></div></dl>}<ol className="vc-analysis-timeline">{process?.events.map(event => <li key={event.sequence}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time><div><strong>{analysisPhaseLabel(t, event.phase)}</strong>{event.batch !== undefined && <span>{t('analysisBatch')} {event.batch}</span>}</div></li>)}</ol>{!process?.events.length && <p className="vc-chat-empty">{t('processNoActivity')}</p>}</div>}
        {detail && (view === 'requests' || view === 'diagnostics') && <div className="vc-process-log" id={`${tabId}-${view}`} role="tabpanel" aria-labelledby={`${tabId}-${view}-tab`}><AnalysisDiagnostics detail={detail} mode={view} t={t} onLocate={navigate} /></div>}
      </div><aside className="vc-process-context" aria-label={t('analysisContext')} aria-busy={initialLoading}>
        <header className="vc-process-context-heading"><div><h3>{t('analysisContext')}</h3>{nativeCalls.length > 0 && <Tag tone="info">{t('nativeLlm')}</Tag>}</div><img src={sidebarArtwork} alt="" width={64} height={43} /></header>
        <div className="vc-process-facts">{initialLoading ? <InformationSkeleton /> : <>
        {task && <section className="vc-process-model"><div className="vc-process-model-name"><strong aria-label={t('model')} title={task.model}>{task.model}</strong>{nativeCalls.length > 0 && <small title={t('nativeProvider')}>{nativeCalls.at(-1)?.provider}</small>}</div><dl className="vc-process-model-controls"><div><dt>{t('reasoningEffort')}</dt><dd><Tag>{task.reasoningEffort ?? t('providerDefault')}</Tag></dd></div><div><dt>{t('analysisExecutions')}</dt><dd>{task.attempts}</dd></div></dl></section>}
        {detail && <ContextUsage value={contextUsage} t={t} />}
        {usage.length > 0 && <section className="vc-process-usage"><h3>{t('analysisUsage')}</h3><dl><div><dt>{t('modelInputTokens')}</dt><dd>{inputTokens.toLocaleString()}</dd></div><div><dt>{t('modelOutputTokens')}</dt><dd>{usage.reduce((sum, item) => sum + item.outputTokens, 0).toLocaleString()}</dd></div><div className="vc-process-cache"><dt>{t('modelCacheRead')}</dt><dd>{cacheAvailable ? `${cacheReadTokens.toLocaleString()}${inputTokens > 0 ? ` · ${Math.round(cacheReadTokens / inputTokens * 100)}%` : ''}` : t('modelCacheUnknown')}</dd></div></dl></section>}
        </>}</div>
        {initialLoading && <NavigationSkeleton />}
        {navigationEntries.length > 0 && <section className="vc-process-navigation"><div className="vc-process-batch-heading"><h3>{t('analysisBatches')}</h3><span>{navigationEntries.length}</span></div><p className="vc-process-navigation-hint">{t('analysisNavigationHint')}</p><nav aria-label={t('analysisBatches')}>{navigationEntries.map(entry => <Button key={entry.sequence} variant="ghost" size="sm" className="vc-process-batch-link" aria-current={selectedSequence === entry.sequence ? 'step' : undefined} aria-controls={hasFinal && entry.sequence === summaryMessage?.sequence ? `${tabId}-final-summary` : `${tabId}-message-${entry.sequence}`} onClick={() => navigate(entry.sequence)}><StateDot state={entry.state === 'streaming' ? 'ongoing' : entry.state === 'complete' ? 'done' : entry.state === 'failed' ? 'warning' : 'idle'} /><span className="vc-process-batch-copy"><span><strong>{t(entry.kind === 'summary' ? 'processSummary' : 'analysisBatch')}{entry.batch !== undefined && <> {entry.batch}</>}</strong><Tag tone={entry.state === 'complete' ? 'success' : entry.state === 'failed' ? 'danger' : entry.state === 'streaming' ? 'info' : 'neutral'}>{messageStateLabel(entry.state)}</Tag></span><small>{entry.imageCount} {t('galleryPhotoUnit')}{entry.attempts > 1 && <> · {t('analysisRequestAttempt')} {entry.attempt}/{entry.attempts}</>}</small></span><ui.IconChevronRightOutlineRegular size={14} /></Button>)}</nav></section>}
        <Button size="sm" variant="outline" className="vc-process-log-toggle" onClick={() => setView(view === 'activity' ? 'output' : 'activity')}><ui.IconListPenOutlineRegular size={14} />{t(view === 'activity' ? 'processModelOutput' : 'analysisTimeline')}</Button>
      </aside></div>
      <footer className="vc-chat-footer"><small>{task && !active && ['failed', 'paused', 'interrupted'].includes(task.status) ? analysisContinuationHint(task, t) : t(pausing ? 'analysisPausingHint' : active ? 'analysisContinueHint' : task?.status === 'cancelled' ? 'processCancelledHint' : 'analysisRetainedHint')}</small><div className="vc-dataset-actions">
        {view === 'output' && !following && <Button variant="outline" onClick={latest}>{t('latestOutput')}</Button>}
        {task && onPause && ['created', 'running', 'pausing'].includes(task.status) && <Button variant="outline" disabled={stopping || pausing || resuming} onClick={() => onPause(task.runId)}>{pausing && <StateDot state="ongoing" />}{t(pausing ? 'pausing' : 'pauseAnalysis')}</Button>}
        {task && onResume && canContinue && <Button variant="outline" disabled={stopping || resuming} aria-busy={resuming || undefined} onClick={() => onResume(task.runId)}>{resuming && <StateDot state="ongoing" />}{t(resuming ? 'analysisResuming' : 'resumeAnalysis')}</Button>}
        {task && onReanalyze && ['completed', 'failed', 'cancelled'].includes(task.status) && <Button variant="outline" disabled={reanalysisDisabled || stopping || resuming} onClick={() => onReanalyze(task.styleId)}><ui.IconSparkleRegular size={16} />{t('reanalyze')}</Button>}
        {task && (active || ['paused', 'interrupted'].includes(task.status)) && <Button variant="outline" disabled={stopping} onClick={() => onStop(task.runId)}>{stopping && <StateDot state="ongoing" />}{t(stopping ? 'cancelling' : 'stopAnalysis')}</Button>}
        <Button variant="primary" onClick={onClose}>{t('close')}</Button>
      </div></footer>
    </Modal>
  }
}
