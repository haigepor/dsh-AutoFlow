/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Original-ratio previews retain explicit loading, failure and manual retry states. */
import type { WorkbenchText } from './workbench-locale.ts'
import unavailableArtwork from '../../assets/reference-unavailable-v1.webp'

interface Props { src: string; href: string; alt: string; width: number; height: number; refreshKey: number; t: WorkbenchText }

/** @param React Host runtime. @returns A source-scoped preview with explicit refresh and decorative failure states. */
export function createReferencePreview(React: typeof import('react')) {
  function Preview({ src, href, alt, width, height, refreshKey, t }: Props) {
    const [display, setDisplay] = React.useState<{ state: 'loading' | 'ready' | 'failed'; attempt: number; refreshKey: number }>({ state: 'loading', attempt: 0, refreshKey })
    if (display.refreshKey !== refreshKey) {
      // 用户点击顶部刷新时仅重新发起失败图片；自动轮询不重试，成功图片保留浏览器缓存。
      setDisplay({ ...display, refreshKey, ...(display.state === 'failed' ? { state: 'loading', attempt: display.attempt + 1 } : {}) })
    }
    const { state, attempt } = display
    const imageSrc = attempt ? `${src}${src.includes('?') ? '&' : '?'}previewRetry=${attempt}` : src
    return <div className="vc-reference-preview" data-preview-state={state}>
      <a className="vc-image-preview" href={href} target="_blank" rel="noreferrer" aria-label={state === 'failed' ? `${alt} · ${t('referencePreviewFailed')}` : undefined} title={state === 'failed' ? t('referencePreviewFailed') : undefined} aria-busy={state === 'loading' || undefined}>
        <img key={attempt} src={imageSrc} alt={alt} width={width} height={height} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setDisplay(current => current.attempt === attempt ? { ...current, state: 'ready' } : current)} onError={() => setDisplay(current => current.attempt === attempt ? { ...current, state: 'failed' } : current)} />
      </a>
      {state !== 'ready' && <span className="vc-reference-preview-state" aria-hidden="true">{state === 'failed' && <img className="vc-preview-unavailable" src={unavailableArtwork} alt="" width={64} height={48} />}</span>}
    </div>
  }
  return function ReferencePreview(props: Props) { return <Preview key={props.src} {...props} /> }
}
