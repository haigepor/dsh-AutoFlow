/** Image tool cards and the same-Session gallery consume framework resources and explicit props. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallPhaseProps, ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type { ImageViewTask } from '../shared/image-view.ts'
import { imageSessionAddress } from './resource.ts'
import { imageEstimate, imageTaskActive, recordedImageTask, selectImageTask, sessionGallery, type GalleryImage } from './model.ts'
import { mountLoadingDots } from './motion.ts'
import type {} from './locales.ts'
import type {} from './conversation.ts'

/** Media addresses are constructed by the registration's explicit Session scope. */
export interface ImageCardInjected { mediaUrl(taskId: string, assetId: string, variant: 'preview' | 'view' | 'download', attempt?: number): string }
export type ImageCardProps = ToolCallPhaseProps & Pick<ToolCallViewProps, 'sessionId' | 'callId' | 'toolName' | 'useResource' | 'inspect'> & PropsLocale<'codexImages'> & ImageCardInjected
export type ConversationImageProps = Pick<PropsRuntime<'conversation.chat.node', 'codex-image'>, 'node' | 'sessionId' | 'useResource'> & PropsLocale<'codexImages'> & ImageCardInjected
type SurfaceProps = Pick<ImageCardProps, 'sessionId' | 'callId' | 'useResource' | 't' | 'mediaUrl'> & {
  settled: boolean; failed: boolean; live?: boolean | undefined; saved?: ImageViewTask | undefined
}
type ReactRuntime = typeof import('react')
type Primitives = Pick<typeof import('@deepseek-ai/dsh-client-ui-primitives'), 'Modal' | 'FileTypeIcon'> & { IconCloseOutlineRegular: import('react').ComponentType<{ size: number }> }

/** Build stable component identities once from the shell's React and Modal instances.
 * @param React Shared framework instance.
 * @param ui Existing modal and icon controls.
 * @returns Compact tool renderer and independent conversation image renderer.
 */
export function createImageCard(React: ReactRuntime, ui: Primitives) {
  const { Modal, IconCloseOutlineRegular, FileTypeIcon } = ui
  function Dots() {
    const canvas = React.useRef<HTMLCanvasElement>(null)
    React.useEffect(() => canvas.current ? mountLoadingDots(canvas.current) : undefined, [])
    return <canvas ref={canvas} className="ci-dots" aria-hidden="true" />
  }
  function GeneratedImage({ image, mediaUrl, t, open }: { image: GalleryImage; open(): void } & Pick<ImageCardProps, 'mediaUrl' | 't'>) {
    const [ready, setReady] = React.useState(false), [failed, setFailed] = React.useState(false), [attempt, setAttempt] = React.useState(0)
    return <div className="ci-image-item">
      <button type="button" className="ci-frame ci-result" aria-label={t('openImage')} aria-busy={!ready && !failed} disabled={!ready || failed} onClick={open}>
        {!ready && !failed && <Dots />}
        {!failed && <img src={mediaUrl(image.taskId, image.assetId, 'preview', attempt)} alt={image.name || t('image')} decoding="async" data-ready={ready} onLoad={() => setReady(true)} onError={() => setFailed(true)} />}
        {failed && <span className="ci-media-failure">{t('imageFailed')}</span>}
      </button>
      {failed && <button type="button" className="ci-text-action" onClick={() => { setFailed(false); setReady(false); setAttempt(n => n + 1) }}>{t('retryImage')}</button>}
    </div>
  }
  function Gallery({ images, selected, select, close, mediaUrl, t }: {
    images: readonly GalleryImage[]; selected: string; select(key: string): void; close(): void
  } & Pick<ImageCardProps, 'mediaUrl' | 't'>) {
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
  function ImageSurface({ callId, sessionId, useResource, t, mediaUrl, saved, settled, failed, live }: SurfaceProps) {
    const resource = useResource<'codex-images'>(imageSessionAddress(sessionId))
    const view = resource.value?.sessionId === sessionId ? resource.value : undefined
    const task = selectImageTask(view, callId, undefined, saved)
    const [now, setNow] = React.useState(Date.now), [selected, setSelected] = React.useState<string | undefined>()
    const active = task ? imageTaskActive(task) : !settled
    const progress = live === true && resource.status !== 'failed' && view !== undefined && task !== undefined && active
    React.useEffect(() => { if (!progress) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [progress])
    const gallery = React.useMemo(() => selected === undefined ? [] : sessionGallery(view, task), [selected, view, task])
    const assets: GalleryImage[] = task?.assets.map(asset => ({ ...asset, taskId: task.taskId, key: `${task.taskId}:${asset.assetId}` })) ?? []
    const state = task?.state
    const title = state === 'queued' ? t('queued') : state === 'sent' ? t('generating') : state === 'succeeded' ? t('succeeded')
      : state === 'outcome-unknown' ? t('unknown') : state === 'cancelled' ? t('cancelled') : state === 'failed' || failed ? t('failed')
        : !settled ? t('preparing') : t('unavailable')
    return <article className="ci-tool" data-codex-image-card data-state={state ?? (settled ? 'result' : 'start')} data-compact={false} aria-label={active && !progress && settled ? t('loadingImage') : title}>
      {assets.length > 0 ? <div className="ci-images">{assets.map(image => <GeneratedImage key={image.key} image={image} mediaUrl={mediaUrl} t={t} open={() => setSelected(image.key)} />)}</div>
        : <div className="ci-frame ci-pending" aria-busy={active}>{active && <Dots />}{(!active || progress) && <div className="ci-pill" role={progress ? 'progressbar' : 'status'} aria-label={progress ? t('estimated') : title}
          aria-valuemin={progress ? 0 : undefined} aria-valuemax={progress ? 100 : undefined} aria-valuenow={progress ? imageEstimate(task, now) : undefined}>
          {progress ? <><small>{t('estimated')}</small><span>{imageEstimate(task, now)}%</span></> : title}</div>}</div>}
      {resource.status === 'failed' && <p className="ci-notice" role="status">{t('reconnecting')}</p>}
      {assets.length > 0 && state !== 'succeeded' && !active && <p className="ci-notice" role="status">{t('partial')}</p>}
      {state === 'outcome-unknown' && <p className="ci-notice">{t('pendingUnknown')}</p>}
      {task?.errorCode === 'IMAGE_CREDITS_DISABLED' && <p className="ci-notice">{t('creditsDisabled')}</p>}
      {selected !== undefined && <Gallery images={gallery} selected={selected} select={setSelected} close={() => setSelected(undefined)} mediaUrl={mediaUrl} t={t} />}
    </article>
  }
  function GenerationRow(props: ImageCardProps) {
    const { block, phase, inspect, t } = props
    // 状态由分组摘要统一显示；工具详情保留真实调用的查看入口。
    const content = <><FileTypeIcon kind="image" size={18} /><span>{t('generationRequest')}</span></>
    return <div className="ci-process-row" data-codex-image-process data-state={phase === 'result' && block.isError ? 'failed' : undefined}>
      {inspect ? <button type="button" className="ci-process-action" aria-label={t('inspectRequest')} onClick={inspect}>{content}</button> : content}
    </div>
  }
  function ToolCard(props: ImageCardProps) {
    if (props.toolName === 'codex_image_result') return props.phase === 'result' && props.block.isError
      ? <div className="ci-process-row" data-codex-image-query-error><FileTypeIcon kind="image" size={18} /><span>{props.t('unavailable')}</span></div> : null
    return <GenerationRow {...props} />
  }
  function ConversationCard({ node, ...props }: ConversationImageProps) {
    return <ImageSurface {...props} {...node.data} />
  }
  return { ToolCard, ConversationCard }
}
