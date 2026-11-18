/** Image process disclosures and the Session gallery share the same task resource. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallPhaseProps, ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { imageSessionAddress } from './resource.ts'
import { imageEstimate, imageTaskActive, selectImageTask, sessionGallery, type GalleryImage } from './model.ts'
import type {} from './locales.ts'
import type {} from './conversation.ts'

/** Media addresses are constructed by the registration's explicit Session scope. */
export interface ImageCardInjected { mediaUrl(taskId: string, assetId: string, variant: 'preview' | 'view' | 'download', attempt?: number): string }
/** The raw tool row owns preparation and result-read errors. */
export type ImageToolRowProps = ToolCallPhaseProps & Pick<ToolCallViewProps, 'toolName'> & PropsLocale<'codexImages'>
/** The process disclosure owns one generation request and its saved previews. */
export type ConversationImageProps = Pick<PropsRuntime<'conversation.chat.node', 'codex-image'>,
  'node' | 'sessionId' | 'useResource' | 'useDisclosure' | 'inspectCall'> & PropsLocale<'codexImages'> & ImageCardInjected
type MediaProps = Pick<ConversationImageProps, 'mediaUrl' | 't'>
type ReactRuntime = typeof import('react')
type Primitives = Pick<typeof import('@deepseek-ai/dsh-client-ui-primitives'),
  'Modal' | 'FileTypeIcon' | 'ImageGenerationSkeleton' | 'DisclosureRow' | 'IconCloseOutlineRegular' | 'IconInspectOutlineRegular'>

/** Build stable component identities once from the shell's React and Modal instances.
 * @param React Shared framework instance.
 * @param ui Shared disclosure, modal and icon controls.
 * @returns Tool activity and generation disclosure renderers.
 */
export function createImageCard(React: ReactRuntime, ui: Primitives) {
  const { Modal, IconCloseOutlineRegular, IconInspectOutlineRegular, FileTypeIcon, ImageGenerationSkeleton, DisclosureRow } = ui
  function GeneratedImage({ image, mediaUrl, t, open }: { image: GalleryImage; open(): void } & MediaProps) {
    const [ready, setReady] = React.useState(false), [failed, setFailed] = React.useState(false), [attempt, setAttempt] = React.useState(0)
    return <div className="ci-image-item">
      <button type="button" className="ci-frame ci-result" aria-label={t('openImage')} aria-busy={!ready && !failed} disabled={!ready || failed} onClick={open}>
        {!ready && !failed && <ImageGenerationSkeleton className="ci-dots" />}
        {!failed && <img src={mediaUrl(image.taskId, image.assetId, 'preview', attempt)} alt={image.name || t('image')} decoding="async" data-ready={ready} onLoad={() => setReady(true)} onError={() => setFailed(true)} />}
        {failed && <span className="ci-media-failure">{t('imageFailed')}</span>}
      </button>
      {failed && <button type="button" className="ci-text-action" onClick={() => { setFailed(false); setReady(false); setAttempt(n => n + 1) }}>{t('retryImage')}</button>}
    </div>
  }
  function Gallery({ images, selected, select, close, mediaUrl, t }: {
    images: readonly GalleryImage[]; selected: string; select(key: string): void; close(): void
  } & MediaProps) {
    const [loaded, setLoaded] = React.useState(''), [failed, setFailed] = React.useState(''), [attempt, setAttempt] = React.useState(0)
    const index = Math.max(0, images.findIndex(image => image.key === selected)), image = images[index]
    if (!image) return null
    const choose = (direction: number) => { const next = images[(index + direction + images.length) % images.length]; if (next) select(next.key) }
    const ready = loaded === `${image.key}:${attempt}`, error = failed === `${image.key}:${attempt}`
    return <Modal open headless title={t('previewTitle')} onClose={close} className="ci-gallery" onKeyDownCapture={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); choose(event.key === 'ArrowLeft' ? -1 : 1) }
    }}>
      <header className="ci-gallery-header"><h2>{t('previewTitle')}</h2><span>{t('counter', { index: index + 1, total: images.length })}</span>
        <button type="button" className="ci-icon-button" aria-label={t('close')} onClick={close}><IconCloseOutlineRegular size={18} /></button></header>
      <div className="ci-gallery-body" data-multiple={images.length > 1}>
        <div className="ci-gallery-stage" aria-busy={!ready && !error}>
          {!ready && !error && <span className="ci-gallery-loading" role="status">{t('loadingImage')}</span>}
          {error ? <div role="alert"><p>{t('imageFailed')}</p><button type="button" className="ci-action" onClick={() => setAttempt(n => n + 1)}>{t('retryImage')}</button></div>
            : <img key={`${image.key}:${attempt}`} className="ci-gallery-image" data-ready={ready} src={mediaUrl(image.taskId, image.assetId, 'view', attempt)} alt={image.name || t('image')} onLoad={() => setLoaded(`${image.key}:${attempt}`)} onError={() => setFailed(`${image.key}:${attempt}`)} />}
        </div>
        {images.length > 1 && <aside className="ci-gallery-rail" aria-label={t('sessionImages')}><h3>{t('sessionImages')}</h3><ul>
          {images.map((item, n) => <li key={item.key}><button type="button" className="ci-thumbnail" aria-current={item.key === image.key} aria-label={t('counter', { index: n + 1, total: images.length })} onClick={() => select(item.key)}>
            <img src={mediaUrl(item.taskId, item.assetId, 'preview')} alt={item.name || t('image')} loading="lazy" /></button></li>)}
        </ul></aside>}
      </div>
      <footer className="ci-gallery-footer"><div>{images.length > 1 && <><button type="button" className="ci-action" onClick={() => choose(-1)}>{t('previous')}</button><button type="button" className="ci-action" onClick={() => choose(1)}>{t('next')}</button></>}</div>
        <a className="ci-text-action" href={mediaUrl(image.taskId, image.assetId, 'download')} download={image.name}>{t('download')}</a></footer>
    </Modal>
  }
  function ConversationCard({ node, sessionId, useResource, useDisclosure, inspectCall, t, mediaUrl }: ConversationImageProps) {
    const { callId, saved, settled, failed, live } = node.data
    const { expanded, toggle } = useDisclosure()
    const resource = useResource<'codex-images'>(imageSessionAddress(sessionId))
    const view = resource.value?.sessionId === sessionId ? resource.value : undefined
    const task = selectImageTask(view, callId, undefined, saved)
    const [now, setNow] = React.useState(Date.now), [selected, setSelected] = React.useState<string | undefined>()
    const active = task ? imageTaskActive(task) : !settled && live === true
    const progress = expanded && live === true && resource.status !== 'failed' && view !== undefined && task !== undefined && active
    React.useEffect(() => { if (!progress) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [progress])
    const gallery = React.useMemo(() => selected === undefined ? [] : sessionGallery(view, task), [selected, view, task])
    const assets: GalleryImage[] = task?.assets.map(asset => ({ ...asset, taskId: task.taskId, key: `${task.taskId}:${asset.assetId}` })) ?? []
    const state = task?.state
    const reconnecting = resource.status === 'failed'
    const partial = assets.length > 0 && state !== 'succeeded' && !active
    const creditsDisabled = task?.errorCode === 'IMAGE_CREDITS_DISABLED'
    const title = state === 'succeeded' ? t('succeeded') : state === 'outcome-unknown' ? t('unknown')
      : state === 'cancelled' ? t('cancelled') : state === 'failed' || failed ? t('failed') : reconnecting ? t('reconnecting')
        : active && !live ? t('loadingImage') : state === 'queued' ? t('queued') : state === 'sent' ? t('generating')
          : active ? t('preparing') : t('unavailable')
    const expandable = assets.length > 0 || active || reconnecting || state === 'outcome-unknown' || creditsDisabled
    const open = expandable && expanded
    const percent = progress ? imageEstimate(task, now) : undefined
    return <article className="ci-tool" data-codex-image-card data-state={state ?? (failed ? 'failed' : settled ? 'result' : 'start')}>
      <DisclosureRow
        icon={<FileTypeIcon kind="image" size={14} />} title={title}
        expandable={expandable} expandOnRowClick open={open} onToggle={() => { setSelected(undefined); toggle() }}
        collapsedContent={assets.length > 0 ? <span className="ci-image-count">{t('imageCount', { count: assets.length })}</span> : undefined}
        keepContentWhenOpen
        headerAccessory={inspectCall && <button type="button" className="ci-inspect" aria-label={t('inspectRequest')} title={t('inspectRequest')} onClick={() => inspectCall(callId)}>
          <IconInspectOutlineRegular size={14} />
        </button>}
      >
        <div className="ci-image-body">
          {assets.length > 0 ? <div className="ci-images">{assets.map(image => <GeneratedImage key={image.key} image={image} mediaUrl={mediaUrl} t={t} open={() => setSelected(image.key)} />)}</div>
            : active && <div className="ci-frame ci-pending" aria-busy="true">
              <ImageGenerationSkeleton className="ci-dots" />
              {percent !== undefined && <div className="ci-pill" role="progressbar" aria-label={t('estimated')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <small>{t('estimated')}</small><span>{percent}%</span>
              </div>}
            </div>}
          {reconnecting && !active && <p className="ci-notice" role="status">{t('reconnecting')}</p>}
          {partial && <p className="ci-notice" role="status">{t('partial')}</p>}
          {state === 'outcome-unknown' && <p className="ci-notice">{t('pendingUnknown')}</p>}
          {creditsDisabled && <p className="ci-notice">{t('creditsDisabled')}</p>}
        </div>
      </DisclosureRow>
      {open && selected !== undefined && <Gallery images={gallery} selected={selected} select={setSelected} close={() => setSelected(undefined)} mediaUrl={mediaUrl} t={t} />}
    </article>
  }
  function ToolCard(props: ImageToolRowProps) {
    if (props.toolName === 'codex_image_result') return props.phase === 'result' && props.block.isError
      ? <div className="ci-process-row" data-codex-image-query-error><FileTypeIcon kind="image" size={14} /><span>{props.t('unavailable')}</span></div> : null
    // A dispatched generation already has a disclosure with the real call's inspection action.
    return props.phase === 'preparing'
      ? <div className="ci-process-row"><FileTypeIcon kind="image" size={14} /><span>{props.t('generationRequest')}</span></div> : null
  }
  return { ToolCard, ConversationCard }
}
