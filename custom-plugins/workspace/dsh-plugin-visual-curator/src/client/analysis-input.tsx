/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Read-only saved input using the project's independent message-image gallery. */
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AnalysisRequest } from '../shared/analysis-process.ts'
import type { ClientState } from './store.ts'
import { safeResourcePath } from './store.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { createAnalysisIcon } from './analysis-icons.tsx'

function taskInstruction(text: string): string {
  let payload: unknown
  try { payload = JSON.parse(text) } catch (error) { return text }
  if (!payload || typeof payload !== 'object' || !('input' in payload) || !payload.input || typeof payload.input !== 'object' || !('taskBrief' in payload.input) || typeof payload.input.taskBrief !== 'string') return text
  const brief = payload.input.taskBrief
  let value: unknown
  try { value = JSON.parse(brief) } catch (error) { return brief }
  return value && typeof value === 'object' && 'instruction' in value && typeof value.instruction === 'string' ? value.instruction : brief
}

/** @param React Host runtime. @param ui Existing DSH primitives. @returns Lazy input card independent of model execution. */
export function createAnalysisInput(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, StateDot, Modal, SegmentedTabs } = ui
  const AnalysisIcon = createAnalysisIcon(React)
  const unavailableAttachment = async () => { throw new Error('Only authorized preview references are supplied by this view.') }
  return function AnalysisInput({ request, state, t, onRead, onInspect, renderFactorySlot }: {
    request: AnalysisRequest; state: ClientState; t: WorkbenchText; onRead(requestId: string): void; onInspect(requestId: string): void
    renderFactorySlot: PropsRenderFactories['renderFactorySlot']
  }) {
    const [expanded, setExpanded] = React.useState(false), [copyFailed, setCopyFailed] = React.useState(false)
    const row = React.useRef<HTMLElement>(null)
    const requested = React.useRef<string | null>(null)
    const [detailView, setDetailView] = React.useState<'instruction' | 'user' | 'system' | 'images' | null>(null)
    const detailId = React.useId()
    const input = state.analysisInputs[request.requestId], loading = state.analysisInputLoading.includes(request.requestId), error = state.analysisInputErrors[request.requestId]
    const instruction = input ? taskInstruction(input.inputText) : ''
    // 只读取进入阅读区的已保存输入；不会发送模型请求，也不改变用户的滚动跟随状态。
    React.useEffect(() => {
      if (!request.available || !row.current || requested.current === request.requestId) return
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); requested.current = request.requestId; onRead(request.requestId) }
      }, { root: row.current.closest('.vc-chat-feed') })
      observer.observe(row.current)
      return () => observer.disconnect()
    }, [request.requestId, request.available, onRead])
    const images = input?.images.flatMap(image => {
      const path = safeResourcePath(image.previewPath)
      return path ? [{ preview: { url: new URL(path.slice(1), document.baseURI).href, name: image.name } }] : []
    }) ?? []
    const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setCopyFailed(false) } catch (error) { setCopyFailed(true) } }
    const tabs = [
      { value: 'instruction', label: t('inputUserText'), id: `${detailId}-instruction-tab`, panelId: `${detailId}-instruction` },
      { value: 'user', label: t('inputRawText'), id: `${detailId}-user-tab`, panelId: `${detailId}-user` },
      { value: 'system', label: t('inputSystemText'), id: `${detailId}-system-tab`, panelId: `${detailId}-system` },
      { value: 'images', label: t('inputImageDetails'), id: `${detailId}-images-tab`, panelId: `${detailId}-images` },
    ] as const
    const activeTab = tabs.find(item => item.value === (detailView ?? 'instruction'))!
    const detailText = !input ? '' : detailView === 'user' ? input.inputText : detailView === 'system' ? input.instructions : detailView === 'images' ? JSON.stringify(input.images.map(({ name, imageVersionId, digest, mime, role }) => ({ name, imageVersionId, digest, mime, role })), null, 2) : taskInstruction(input.inputText)
    return <section ref={row} className="vc-request-input" data-request-id={request.requestId} aria-label={t('processModelInput')}>
      <div className="vc-user-stack">
        {images.length > 0 && renderFactorySlot('conversation.images.content', { images, loadImage: unavailableAttachment, align: 'end', compact: true })}
        <div className="vc-user-bubble">
          {!request.available ? <p>{t('inputUnavailable')}</p> : error ? <div className="vc-input-error" role="alert"><span>{t('inputReadFailed')}</span><Button size="sm" onClick={() => onRead(request.requestId)}>{t('refresh')}</Button></div> : input ? <>
            <div className="vc-input-preview" data-expanded={expanded || instruction.length <= 180}>{instruction}</div>
            {instruction.length > 180 && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => { onInspect(request.requestId); setExpanded(value => !value) }}>{t(expanded ? 'inputCollapse' : 'inputExpand')}</Button>}
          </> : <div className="vc-input-pending" role="status"><span>{t(request.operation === 'summarize' ? 'processSummary' : 'batchObservations')} · {request.imageIds.length} {t('chatImages')}</span>{loading && <StateDot state="ongoing" />}</div>}
        </div>
        <div className="vc-input-meta"><span>{t('processModelInput')}</span><time dateTime={request.createdAt}>{new Date(request.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{request.available && <Button size="sm" variant="ghost" onClick={() => { onInspect(request.requestId); setDetailView('instruction') }}><ui.IconCodeOutlineRegular size={14} />{t('inputDetails')}</Button>}</div>
      </div>
      <Modal open={detailView !== null} onClose={() => setDetailView(null)} title={t('inputDetails')} headless className="vc-input-inspector-modal">
        <header className="vc-process-dialog-header"><h2>{t('inputDetails')}</h2><Button size="sm" variant="ghost" aria-label={t('close')} onClick={() => setDetailView(null)}><ui.IconCloseOutlineRegular size={16} /></Button></header>
        <div className="vc-input-inspector-content">
          <SegmentedTabs label={t('inputDetails')} variant="underline" items={tabs} value={detailView ?? 'instruction'} onChange={setDetailView} />
          <div className="vc-input-detail-pane" id={activeTab.panelId} role="tabpanel" aria-labelledby={activeTab.id} tabIndex={0}><p className="vc-input-detail-note">{request.state === 'committed' ? <ui.IconCheckCircleOutlineRegular size={14} /> : <ui.IconClockOutlineRegular size={14} />}{t(request.state === 'committed' ? 'inputReturned' : request.state === 'reserved' ? 'inputReserved' : 'inputOutcomeUnknown')}{input?.images.some(image => image.sourceKind === 'remote') && <span>{t('inputRemoteHint')}</span>}</p><pre data-input-text={detailView === 'user' || undefined} data-system-text={detailView === 'system' || undefined}>{detailText}</pre>{detailView === 'instruction' && input && input.images.length > 0 && <><h3 className="vc-input-detail-heading"><AnalysisIcon kind="image" />{t('inputImagesHeading')} · {input.images.length}</h3><div className="vc-input-detail-images">{input.images.map((image, index) => {
            const path = safeResourcePath(image.previewPath)
            return <figure key={`${image.imageVersionId}-${index}`}>{path ? renderFactorySlot('conversation.images.content', { images: [{ preview: { url: new URL(path.slice(1), document.baseURI).href, name: image.name } }], loadImage: unavailableAttachment, align: 'start', compact: true }) : <AnalysisIcon kind="image" size={24} />}<figcaption><span>{t('chatImage')} {String(index + 1).padStart(2, '0')}</span>{image.name}</figcaption></figure>
          })}</div></>}</div>
          {copyFailed && <p role="alert">{t('inputCopyFailed')}</p>}
        </div>
        <footer className="vc-chat-footer"><div className="vc-dataset-actions"><Button variant="outline" onClick={() => void copy(detailText)}><ui.IconCopyOutlineRegular size={16} />{t('inputCopy')}</Button><Button variant="primary" onClick={() => setDetailView(null)}>{t('close')}</Button></div></footer>
      </Modal>
    </section>
  }
}
