/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Original-ratio previews retain explicit loading, failure and manual retry states. */
import type { WorkbenchText } from './workbench-locale.ts'
import unavailableArtwork from '../../assets/reference-unavailable-v1.webp'
import { sharedPreviewLoader, type PreviewLease } from './preview-loader.ts'
import { sharedPreviewVisibility } from './preview-visibility.ts'

interface Props { src: string; href: string; alt: string; width: number; height: number; refreshKey: number; t: WorkbenchText; onPreview?: (() => void) | undefined; onSelect?: (() => void) | undefined; selected?: boolean; selectionDisabled?: boolean }

/** @param React Host runtime. @param ui Existing project controls. @returns A source-scoped preview opening the owner gallery or a native single-image dialog. */
export function createReferencePreview(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  function Preview({ src, href, alt, width, height, refreshKey, t, onPreview, onSelect, selected, selectionDisabled }: Props) {
    const [previewOpen, setPreviewOpen] = React.useState(false)
    const frame = React.useRef<HTMLDivElement>(null), currentUrl = React.useRef(''), failedAttempt = React.useRef<number | undefined>(undefined)
    const [visible, setVisible] = React.useState(false), [loaded, setLoaded] = React.useState<PreviewLease | null>(null)
    const closePreview = React.useCallback(() => setPreviewOpen(false), [])
    const [display, setDisplay] = React.useState<{ state: 'loading' | 'ready' | 'failed'; attempt: number; refreshKey: number }>({ state: 'loading', attempt: 0, refreshKey })
    if (display.refreshKey !== refreshKey) {
      // 用户点击顶部刷新时仅重新发起失败图片；自动轮询不重试，成功图片保留浏览器缓存。
      setDisplay({ ...display, refreshKey, ...(display.state === 'failed' ? { state: 'loading', attempt: display.attempt + 1 } : {}) })
    }
    const { state, attempt } = display
    const imageSrc = attempt ? `${src}${src.includes('?') ? '&' : '?'}previewRetry=${attempt}` : src
    React.useEffect(() => {
      const target = frame.current
      if (!target) return
      return sharedPreviewVisibility.observe(target, value => { if (value) setVisible(true) })
    }, [])
    React.useEffect(() => {
      setLoaded(null)
      if (!visible || failedAttempt.current === attempt) return
      const controller = new AbortController()
      let active = true, acquired: PreviewLease | undefined
      setDisplay(current => ({ ...current, state: 'loading' }))
      void sharedPreviewLoader.load(imageSrc, controller.signal).then(value => {
        if (!active || controller.signal.aborted) { value.release(); return }
        acquired = value; currentUrl.current = value.url; setLoaded(value)
      }, error => {
        if (!active || controller.signal.aborted) return
        failedAttempt.current = attempt; setDisplay(current => ({ ...current, state: 'failed' }))
      })
      return () => { active = false; controller.abort(); acquired?.release(); if (currentUrl.current === acquired?.url) currentUrl.current = '' }
    }, [visible, imageSrc, attempt])
    return <div ref={frame} className="vc-reference-preview" data-preview-state={state}>
      <ui.Button type="button" variant="ghost" className="vc-image-preview nodrag nopan" onClick={onSelect ? () => { if (!selectionDisabled) onSelect() } : onPreview ?? (() => setPreviewOpen(true))} disabled={!href && !onSelect} aria-disabled={onSelect && selectionDisabled || undefined} aria-pressed={onSelect ? selected : undefined} aria-label={`${t(onSelect ? 'gallerySelectPhoto' : 'taskOpenPreview')} · ${alt}`} title={state === 'failed' ? t('referencePreviewFailed') : undefined} aria-busy={state === 'loading' || undefined}>
        <img draggable={false} key={loaded?.url ?? attempt} src={loaded?.url} alt={alt} width={width} height={height} decoding="async" referrerPolicy="no-referrer" onLoad={() => { if (loaded && currentUrl.current === loaded.url) setDisplay(current => current.attempt === attempt ? { ...current, state: 'ready' } : current) }} onError={() => { if (loaded && currentUrl.current === loaded.url) { failedAttempt.current = attempt; currentUrl.current = ''; loaded.release(); setLoaded(null); setDisplay(current => current.attempt === attempt ? { ...current, state: 'failed' } : current) } }} />
      </ui.Button>
      {state !== 'ready' && <span className="vc-reference-preview-state" aria-hidden="true">{state === 'failed' && <img className="vc-preview-unavailable" src={unavailableArtwork} alt="" width={64} height={48} />}</span>}
      {previewOpen && <ui.ImageLightbox src={href === src && loaded ? loaded.url : href} alt={alt} labels={{ dialog: t('galleryPreview'), close: t('close') }} loadingLabels={{ loading: t('galleryPreviewLoading'), error: t('galleryPreviewError'), retry: t('retry') }} onClose={closePreview} />}
    </div>
  }
  return React.memo(function ReferencePreview(props: Props) { return <Preview key={props.src} {...props} /> })
}
