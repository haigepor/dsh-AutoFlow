/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Result previews keep their image stage while requests load or fail. */
import type { WorkbenchText } from './workbench-locale.ts'

interface Props { src: string; thumbnailSrc?: string | undefined; alt: string; t: WorkbenchText }

/** @param React Shared runtime. @param ui Native feedback and retry controls. @returns A preview with a thumbnail fallback and explicit full-preview retry. */
export function createResultPreview(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  function Preview({ src, thumbnailSrc, alt, t }: Props) {
    const [request, setRequest] = React.useState({ attempt: 0, thumbnail: false, state: 'loading' as 'loading' | 'ready' | 'failed' })
    const source = request.thumbnail ? thumbnailSrc! : src
    const url = request.attempt ? `${source}${source.includes('?') ? '&' : '?'}previewRetry=${request.attempt}` : source
    const retry = () => setRequest(current => ({ attempt: current.attempt + 1, thumbnail: false, state: 'loading' }))
    return <div className="vc-result-preview-frame" data-result-preview={request.state} data-preview-fallback={request.thumbnail || undefined}>
      <a href={src} target="_blank" rel="noreferrer" aria-label={`${t('taskOpenPreview')} · ${alt}`}>
        <img key={`${request.attempt}:${request.thumbnail}`} src={url} alt={alt} decoding="async" referrerPolicy="no-referrer"
          onLoad={() => setRequest(current => current.attempt === request.attempt && current.thumbnail === request.thumbnail ? { ...current, state: 'ready' } : current)}
          onError={() => setRequest(current => {
            if (current.attempt !== request.attempt || current.thumbnail !== request.thumbnail) return current
            return !current.thumbnail && thumbnailSrc && thumbnailSrc !== src ? { ...current, thumbnail: true, state: 'loading' } : { ...current, state: 'failed' }
          })} />
      </a>
      {request.state !== 'ready' && <div className="vc-result-preview-feedback" role={request.state === 'failed' ? 'alert' : 'status'}>
        <ui.StateDot state={request.state === 'failed' ? 'warning' : 'ongoing'} />
        <span>{t(request.state === 'failed' ? 'galleryPreviewError' : 'galleryPreviewLoading')}</span>
        {request.state === 'failed' && <ui.Button size="sm" variant="outline" onClick={retry}>{t('retry')}</ui.Button>}
      </div>}
      {request.thumbnail && request.state === 'ready' && <div className="vc-result-preview-fallback" role="status"><span>{t('resultPreviewThumbnail')}</span><ui.Button size="sm" variant="outline" onClick={retry}>{t('resultPreviewRetry')}</ui.Button></div>}
    </div>
  }
  return function ResultPreview(props: Props) { return <Preview key={`${props.src}:${props.thumbnailSrc ?? ''}`} {...props} /> }
}
