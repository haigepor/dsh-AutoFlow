/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Gallery placeholders and direct image previews use the existing ImageLightbox primitive. */
import type { GalleryPhoto } from '../shared/gallery.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import loadingArtwork from '../../assets/gallery-preview-loading-v1.webp'
import { safeResourcePath } from './store.ts'

/** @param path Optional authenticated Host path. @param fallback Original public source for older Hosts or explicit redirect mode. @returns Display URL relative to the application's mounted base. */
export function galleryImageSource(path: string | undefined, fallback: string): string {
  const safe = path ? safeResourcePath(path) : ''
  return safe ? new URL(safe.slice(1), document.baseURI).href : fallback
}

/** @param React Host React runtime. @param ui Project primitives. @returns Stable gallery media components. */
export function createGalleryMedia(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  function GallerySkeleton({ kind, count, label, referenceGrid = false }: { kind: 'folders' | 'photos'; count: number; label: string; referenceGrid?: boolean }) {
    return <div className="vc-gallery-skeleton" role="status" aria-label={label}><span className="vc-sr-only">{label}</span><div className={referenceGrid ? 'vc-image-grid vc-reference-grid' : kind === 'folders' ? 'vc-gallery-folders' : 'vc-gallery-photos'} aria-hidden="true">{Array.from({ length: count }, (_, index) => <div key={index} className={`vc-gallery-skeleton-card vc-gallery-skeleton-${kind}`}><div className="vc-gallery-skeleton-fill vc-gallery-skeleton-image" /><div className="vc-gallery-skeleton-copy"><span className="vc-gallery-skeleton-fill" /><span className="vc-gallery-skeleton-fill" /></div></div>)}</div></div>
  }
  function GalleryLoadMore({ hasMore, loading, disabled, version, onLoad, label, kind, showSkeleton = true }: { hasMore: boolean; loading: boolean; disabled: boolean; version: string | number; onLoad(): void; label: string; kind: 'folders' | 'photos'; showSkeleton?: boolean }) {
    const sentinel = React.useRef<HTMLDivElement>(null), next = React.useRef(onLoad)
    next.current = onLoad
    React.useEffect(() => {
      const target = sentinel.current
      if (!target || !hasMore || loading || disabled) return
      // 沿父级寻找实际滚动区，兼容图库与嵌套弹窗；每批只触发一次。
      let root = target.parentElement
      while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement
      const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); next.current() } }, { root, rootMargin: '0px 0px 160px' })
      observer.observe(target)
      return () => observer.disconnect()
    }, [hasMore, loading, disabled, version])
    return <div ref={sentinel} className="vc-gallery-load-more" aria-busy={loading}>{loading && showSkeleton && <GallerySkeleton kind={kind} count={2} label={label} />}</div>
  }
  function GalleryPhotoPreview({ photo, selected, disabled, onToggle, t }: { photo: GalleryPhoto; selected: boolean; disabled: boolean; onToggle(): void; t: WorkbenchText }) {
    const [preview, setPreview] = React.useState(false)
    const trigger = React.useRef<HTMLButtonElement>(null)
    const frame = React.useRef<HTMLDivElement>(null)
    const closePreview = React.useCallback(() => setPreview(false), [])
    const openPreview = () => { (trigger.current?.disabled ? frame.current : trigger.current)?.focus({ preventScroll: true }); setPreview(true) }
    return <div ref={frame} className="vc-gallery-photo-frame" tabIndex={disabled ? 0 : -1} role="group" aria-label={`${t('galleryPreview')}: ${photo.title}`} onContextMenu={event => { event.preventDefault(); openPreview() }} onKeyDown={event => {
      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); openPreview() }
    }}>
      <ui.Button ref={trigger} variant="ghost" className="vc-gallery-preview" aria-label={`${t('gallerySelectPhoto')}: ${photo.title}`} aria-pressed={selected} disabled={disabled} onClick={onToggle}><img src={galleryImageSource(photo.thumbnailPath, photo.thumbnailUrl)} alt={photo.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" /></ui.Button>
      {preview && <ui.ImageLightbox src={galleryImageSource(photo.previewPath, photo.referenceUrl)} alt={photo.title} labels={{ dialog: t('galleryPreview'), close: t('close') }} loadingLabels={{ loading: t('galleryPreviewLoading'), error: t('galleryPreviewError'), retry: t('retry') }} loadingImageSrc={loadingArtwork} onClose={closePreview} />}
    </div>
  }
  return { GallerySkeleton, GalleryPhotoPreview, GalleryLoadMore }
}
