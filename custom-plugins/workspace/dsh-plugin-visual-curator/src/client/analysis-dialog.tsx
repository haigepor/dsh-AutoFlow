/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Model conversation and independent task controls, composed with the Host's primitives. */
import { analysisActive, type AnalysisTask, type AnalysisMessage, type AnalysisDetail } from '../shared/analysis-process.ts'
import { styleSummarySchema } from '../shared/style-analysis.ts'
import type { ClientState } from './store.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { createAnalysisInput } from './analysis-input.tsx'
import { createAnalysisIcon } from './analysis-icons.tsx'
import { safeResourcePath } from './store.ts'
import type { AnalysisInput as SavedInput } from '../shared/analysis-process.ts'

/** @param t Plugin locale. @param phase Task phase. @returns Localized phase name. */
export function analysisPhaseLabel(t: WorkbenchText, phase: AnalysisTask['phase']): string {
  const keys = { queued: 'analysisQueued', preparing: 'analysisPreparing', analyzing: 'analyzingImages', receiving: 'analysisReceiving', validating: 'analysisValidating', summarizing: 'summarizingStyle', saving: 'analysisSaving', completed: 'completed', interrupted: 'interrupted', cancelled: 'cancelled', failed: 'failed' } as const
  return t(keys[phase])
}
function summaryOf(message: AnalysisMessage, detail: AnalysisDetail) {
  if (message.kind !== 'summary' || message.state !== 'complete') return undefined
  if (detail.summary) return detail.summary
  if (!message.content) return undefined
  let value: unknown
  try { value = JSON.parse(message.content) } catch (error) { return undefined }
  const parsed = styleSummarySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
function dimensionLabel(t: WorkbenchText, field: string): string {
  const dimension = (['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'] as const).find(value => value === field)
  return dimension ? t(dimension) : field
}

/** @param React Host React instance. @param ui Existing accessible primitives. @returns Process dialog with independent output and activity views. */
export function createAnalysisDialog(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Modal, Button, StateDot, Tag, DisclosureRow, SegmentedTabs } = ui
  const AnalysisInput = createAnalysisInput(React, ui)
  const AnalysisIcon = createAnalysisIcon(React)
  const unavailableAttachment = async () => { throw new Error('Only authorized preview references are supplied by this view.') }
  type EvidenceProps = { images: SavedInput['images']; onReadInput(requestId: string): void }
  function Evidence({ imageId, images, onReadInput, detail, t, renderFactorySlot }: { imageId: string; detail: AnalysisDetail; t: WorkbenchText } & EvidenceProps & PropsRenderFactories) {
    const image = images.find(item => item.imageVersionId === imageId)
    const path = image && safeResourcePath(image.previewPath)
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
    return <div ref={element} className="vc-evidence-image">{path ? renderFactorySlot('conversation.images.content', { images: [{ preview: { url: new URL(path.slice(1), document.baseURI).href, name } }], loadImage: unavailableAttachment, align: 'start', thumbnail: true }) : <span className="vc-evidence-placeholder" role="img" aria-label={t('outputPreviewUnavailable')}><AnalysisIcon kind="image" size={24} /></span>}</div>
  }
  function Observations({ rows, detail, images, onReadInput, imageIds, t, renderFactorySlot }: { rows: AnalysisDetail['observations']; detail: AnalysisDetail; images: SavedInput['images']; onReadInput(requestId: string): void; imageIds?: string[]; t: WorkbenchText } & PropsRenderFactories) {
    return <section className="vc-observation-section"><h3 className="vc-output-section-title"><AnalysisIcon kind="image" />{t('batchObservations')}<span>{rows.length} {t('chatImages')}</span></h3><div className="vc-chat-observations">{rows.map((row, index) => {
      const position = imageIds?.indexOf(row.imageVersionId) ?? index
      const number = String((position < 0 ? index : position) + 1).padStart(2, '0')
      const name = detail.images.find(image => image.imageVersionId === row.imageVersionId)?.name ?? `${t('chatImage')} ${number}`
      return <section key={row.imageVersionId} className="vc-chat-observation"><Evidence imageId={row.imageVersionId} images={images} onReadInput={onReadInput} detail={detail} t={t} renderFactorySlot={renderFactorySlot} /><div className="vc-observation-copy"><header><h4>{t('chatImage')} {number}</h4><span title={name}>{name}</span></header><dl>{row.dimensions.map((dimension, i) => <div key={i}><dt><AnalysisIcon kind={dimension.field} size={14} />{dimensionLabel(t, dimension.field)}</dt><dd>{typeof dimension.value === 'string' ? dimension.value : JSON.stringify(dimension.value)} {dimension.uncertain && <Tag>{t('uncertain')}</Tag>}</dd></div>)}</dl></div></section>
    })}</div></section>
  }
  function SummaryEvidence({ ids, kind, images, onReadInput, detail, t, renderFactorySlot }: { ids: string[]; kind: 'positiveEvidence' | 'negativeEvidence'; images: SavedInput['images']; onReadInput(requestId: string): void; detail: AnalysisDetail; t: WorkbenchText } & PropsRenderFactories) {
    if (!ids.length) return null
    return <div className="vc-summary-evidence"><span>{t(kind)}</span><div>{ids.map(imageId => <figure key={imageId}><Evidence imageId={imageId} images={images} onReadInput={onReadInput} detail={detail} t={t} renderFactorySlot={renderFactorySlot} /><figcaption>{detail.images.find(image => image.imageVersionId === imageId)?.name ?? t('outputPreviewUnavailable')}</figcaption></figure>)}</div></div>
  }
  function ModelMessage({ message, detail, images, onReadInput, t, renderFactorySlot }: { message: AnalysisMessage; detail: AnalysisDetail; images: SavedInput['images']; onReadInput(requestId: string): void; t: WorkbenchText } & PropsRenderFactories) {
    const [reasoningOpen, setReasoningOpen] = React.useState(false), [rawOpen, setRawOpen] = React.useState(false)
    const streaming = message.state === 'streaming', summary = summaryOf(message, detail)
    const rows = message.kind === 'analysis' && message.state === 'complete' ? detail.observations.filter(row => message.imageIds.includes(row.imageVersionId)) : []
    const bodyReady = rows.length > 0 || !!summary
    const compact = !streaming && message.state !== 'complete' && !bodyReady
    const [expanded, setExpanded] = React.useState(!compact)
    // 未完成批次收起为状态行，保留可展开的接口原文，不遮住之前已提交的观察。
    React.useEffect(() => { if (compact) { setExpanded(false); setReasoningOpen(false) } }, [compact])
    return <article className="vc-chat-message" data-message-sequence={message.sequence} data-compact={compact} aria-busy={streaming}>
      <header className="vc-chat-message-header"><span className="vc-chat-avatar" aria-hidden="true"><ui.IconSparkleRegular size={16} /></span><strong>{detail.task.model}</strong><span className="vc-chat-batch-label">{t(message.kind === 'summary' ? 'processSummary' : 'batchObservations')}{message.kind === 'analysis' && <> · {message.batch}</>}</span><span className="vc-chat-message-spacer" />{message.state === 'streaming' ? <span className="vc-model-status"><StateDot state="ongoing" />{t(message.reasoning && !message.content ? 'modelThinking' : 'modelWriting')}</span> : message.state !== 'complete' && <Tag>{t(message.state)}</Tag>}{compact && <Button size="sm" variant="ghost" aria-expanded={expanded} aria-label={t('processBatchDetails')} onClick={() => setExpanded(value => !value)}><ui.IconChevronDownOutlineRegular size={14} className={expanded ? 'vc-rotate' : undefined} /></Button>}</header>
      {compact && !expanded ? <p className="vc-chat-compact-note">{t('processBatchUnfinished')}</p> : <div className="vc-chat-message-body">
        {message.reasoning && <DisclosureRow className="vc-chat-reasoning" icon={<ui.IconThinkOutlineRegular size={14} />} title={t('processReasoning')} running={streaming && !message.content} open={reasoningOpen} expandable expandOnRowClick onToggle={() => setReasoningOpen(value => !value)}>{renderFactorySlot('conversation.chat.reasoning.content', { text: message.reasoning, running: streaming && !message.content })}</DisclosureRow>}
        {rows.length > 0 && <Observations rows={rows} detail={detail} images={images} onReadInput={onReadInput} imageIds={message.imageIds} t={t} renderFactorySlot={renderFactorySlot} />}
        {summary && <div className="vc-chat-answer vc-summary-answer"><header className="vc-summary-intro"><span className="vc-output-eyebrow"><ui.IconSparkleRegular size={14} />{t('processSummary')}</span><h3>{summary.name}</h3><p>{summary.summary}</p></header><dl className="vc-summary-dimensions">{summary.dimensions.map(row => <div key={row.dimension}><dt><AnalysisIcon kind={row.dimension} />{t(row.dimension)}</dt><dd><p>{row.description}</p>{row.consistency !== 'consistent' && <Tag>{t(row.consistency)}</Tag>}<SummaryEvidence ids={row.supportImageVersionIds} kind="positiveEvidence" images={images} onReadInput={onReadInput} detail={detail} t={t} renderFactorySlot={renderFactorySlot} /><SummaryEvidence ids={row.counterImageVersionIds} kind="negativeEvidence" images={images} onReadInput={onReadInput} detail={detail} t={t} renderFactorySlot={renderFactorySlot} /></dd></div>)}</dl>{summary.suggestedRules.length > 0 && <section className="vc-summary-rules"><h4 className="vc-output-section-title"><ui.IconChecklistOutlineRegular size={16} />{t('outputSuggestedRules')}<span>{summary.suggestedRules.length}</span></h4><ol>{summary.suggestedRules.map((rule, index) => <li key={index}><span className="vc-chat-image-number">{String(index + 1).padStart(2, '0')}</span><span>{rule.statement}</span></li>)}</ol></section>}<section className="vc-summary-prompt"><h4 className="vc-output-section-title"><ui.IconSearchOutlineRegular size={16} />{t('matchingPrompt')}</h4><p>{summary.matchingPrompt}</p></section></div>}
        {!bodyReady && message.content && <div className="vc-chat-answer vc-chat-stream" data-streaming={streaming}>{message.content}</div>}
        {!message.content && !bodyReady && (!streaming || !message.reasoning) && <p className="vc-chat-waiting" role="status">{t(streaming ? 'modelWaiting' : message.state === 'complete' ? 'analysisOutputBounded' : 'processBatchUnfinished')}</p>}
        {message.content && bodyReady && <DisclosureRow className="vc-chat-raw" icon={<ui.IconCodeOutlineRegular size={14} />} title={t('providerOutput')} open={rawOpen} expandable expandOnRowClick onToggle={() => setRawOpen(value => !value)}><pre className="vc-analysis-output">{message.content}</pre></DisclosureRow>}
      </div>}
    </article>
  }
  return function AnalysisDialog({ state, t, onClose, onStop, onRetry, onReadInput, renderFactorySlot }: { state: ClientState; t: WorkbenchText; onClose(): void; onStop(runId: string): void; onRetry(): void; onReadInput(requestId: string): void; renderFactorySlot: PropsRenderFactories['renderFactorySlot'] }) {
    const [view, setView] = React.useState<'output' | 'activity'>('output'), [following, setFollowing] = React.useState(true)
    const feed = React.useRef<HTMLDivElement>(null), follow = React.useRef(true), outputScroll = React.useRef(0), tabId = React.useId()
    const detail = state.analysisDetail, task = detail?.task ?? state.analysisTasks.find(item => item.runId === state.analysisRunId), process = detail?.process
    const active = !!task && analysisActive(task.status), stopping = task?.status === 'cancelling' || state.pending.includes(`stop:${state.analysisRunId}`)
    const images = detail?.requests.flatMap(request => state.analysisInputs[request.requestId]?.images ?? []) ?? []
    const messages = process?.messages ?? []
    const linked = new Set(messages.flatMap(message => message.requestId ? [message.requestId] : []))
    const unlinked = detail?.requests.filter(request => !linked.has(request.requestId)) ?? []
    const tabs = React.useMemo(() => [{ value: 'output', label: t('processModelOutput'), id: `${tabId}-output-tab`, panelId: `${tabId}-output` }, { value: 'activity', label: t('analysisTimeline'), id: `${tabId}-activity-tab`, panelId: `${tabId}-activity` }] as const, [tabId, t])
    React.useLayoutEffect(() => { follow.current = true; outputScroll.current = 0; setFollowing(true); setView('output') }, [state.analysisRunId])
    // 只有输出页处于末尾时跟随；切换到日志不会丢失模型正文的阅读位置。
    React.useLayoutEffect(() => { if (view === 'output' && feed.current) feed.current.scrollTop = follow.current ? feed.current.scrollHeight : outputScroll.current }, [view, state.analysisRunId, process?.updatedAt, detail?.observations.length])
    const latest = () => { follow.current = true; setFollowing(true); if (feed.current) feed.current.scrollTop = feed.current.scrollHeight }
    const inspectInput = (requestId: string) => { follow.current = false; setFollowing(false); outputScroll.current = feed.current?.scrollTop ?? 0; onReadInput(requestId) }
    const phase = task?.outcome === 'budget-exhausted' ? t('budgetExhausted') : task ? analysisPhaseLabel(t, task.phase) : t('busy')
    return <Modal open={!!state.analysisRunId} onClose={onClose} title={`${t('analysisProcess')}${task ? ` · ${task.name}` : ''}`} headless className="vc-analysis-modal">
      <header className="vc-process-dialog-header"><div className="vc-process-title"><h2>{t('analysisProcess')}</h2>{task && <p>{task.name}</p>}</div>{task && <div className="vc-process-summary"><div className="vc-analysis-status" role="status" aria-live="polite"><StateDot state={active || state.analysisLoading ? 'ongoing' : task.status === 'completed' && task.outcome !== 'budget-exhausted' ? 'done' : 'warning'} /><strong>{phase}</strong></div><div className="vc-chat-count"><span>{t(active ? 'analysisProgress' : 'processSaved')}</span><strong>{task.observed}</strong><span>/ {task.total}</span></div></div>}<Button size="sm" variant="ghost" className="vc-process-close" aria-label={t('close')} onClick={onClose}><ui.IconCloseOutlineRegular size={16} /></Button></header>
      {task && active && <div className="vc-chat-progress"><progress className="vc-analysis-progress" max={Math.max(1, task.total)} value={task.observed} aria-label={t('analysisProgress')} /></div>}
      {(state.analysisError || task?.error) && <div className="vc-process-error" role="alert"><span>{state.analysisError?.safeMessage || task?.error?.safeMessage || t('error')}</span><Button size="sm" onClick={onRetry}>{t('refresh')}</Button></div>}
      <SegmentedTabs className="vc-process-tabs" variant="underline" label={t('analysisProcess')} items={tabs} value={view} onChange={setView} />
      <div className="vc-chat-panels">
        <div ref={feed} id={`${tabId}-output`} role="tabpanel" aria-labelledby={`${tabId}-output-tab`} hidden={view !== 'output'} className="vc-chat-feed" onScroll={() => { const element = feed.current; if (!element || view !== 'output') return; outputScroll.current = element.scrollTop; const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 64; follow.current = nearEnd; setFollowing(nearEnd) }}>
          <div role="log" aria-live="off" aria-label={t('modelConversation')}>
            {unlinked.length > 0 && <section className="vc-input-history"><h3>{t('inputHistory')}</h3><p>{t('inputHistoryHint')}</p>{unlinked.map(request => <AnalysisInput key={request.requestId} request={request} state={state} t={t} onRead={onReadInput} onInspect={inspectInput} renderFactorySlot={renderFactorySlot} />)}</section>}
            {detail && messages.map(message => {
              const request = detail.requests.find(item => item.requestId === message.requestId)
              return <div key={message.sequence} className="vc-request-exchange">{request && <AnalysisInput request={request} state={state} t={t} onRead={onReadInput} onInspect={inspectInput} renderFactorySlot={renderFactorySlot} />}<ModelMessage message={message} detail={detail} images={images} onReadInput={onReadInput} t={t} renderFactorySlot={renderFactorySlot} /></div>
            })}
            {detail && !messages.length && detail.observations.length > 0 && <article className="vc-chat-message"><header className="vc-chat-message-header"><strong>{t('sampleObservations')}</strong></header><Observations rows={detail.observations} detail={detail} images={images} onReadInput={onReadInput} t={t} renderFactorySlot={renderFactorySlot} /></article>}
            {(!detail || !messages.length && !detail.observations.length) && <div className="vc-chat-empty"><StateDot state={active || state.analysisLoading ? 'ongoing' : 'idle'} /><p>{t(state.analysisLoading ? 'busy' : active ? 'modelWaiting' : 'processNoSavedOutput')}</p></div>}
            {detail && !messages.length && process?.reasoning && renderFactorySlot('conversation.chat.reasoning.content', { text: process.reasoning, running: active && !process.content })}
            {process?.truncated && <p className="vc-chat-retention">{t('analysisOutputBounded')}</p>}
          </div>
        </div>
        {view === 'activity' && <div id={`${tabId}-activity`} role="tabpanel" aria-labelledby={`${tabId}-activity-tab`} className="vc-process-log">{task && <dl className="vc-chat-config"><div><dt>{t('model')}</dt><dd title={task.model}>{task.model}</dd></div><div><dt>{t('reasoningEffort')}</dt><dd>{task.reasoningEffort ?? t('providerDefault')}</dd></div><div><dt>{t('analysisAttempt')}</dt><dd>{task.attempts}</dd></div></dl>}<ol className="vc-analysis-timeline">{process?.events.map(event => <li key={event.sequence}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time><div><strong>{analysisPhaseLabel(t, event.phase)}</strong>{event.batch !== undefined && <span>{t('analysisBatch')} {event.batch}</span>}</div></li>)}</ol>{!process?.events.length && <p className="vc-chat-empty">{t('processNoActivity')}</p>}</div>}
      </div>
      <footer className="vc-chat-footer"><small>{t(active ? 'analysisContinueHint' : task?.status === 'cancelled' ? 'processCancelledHint' : 'analysisRetainedHint')}</small><div className="vc-dataset-actions">{view === 'output' && !following && <Button variant="outline" onClick={latest}>{t('latestOutput')}</Button>}{task && active && <Button variant="outline" disabled={stopping} onClick={() => onStop(task.runId)}>{stopping && <StateDot state="ongoing" />}{t(stopping ? 'cancelling' : 'stopAnalysis')}</Button>}<Button variant="primary" onClick={onClose}>{t('close')}</Button></div></footer>
    </Modal>
  }
}
