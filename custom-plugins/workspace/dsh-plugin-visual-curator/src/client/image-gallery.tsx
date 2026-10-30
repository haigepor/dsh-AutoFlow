/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** A filtered image sequence uses the native lightbox without changing task or collection ownership. */
import type { WorkbenchText } from './workbench-locale.ts'
import loadingArtwork from '../../assets/gallery-preview-loading-v1.webp'

/** Already-authorized image locations and stable identities supplied by the current view. */
export interface GalleryImage { id: string; path: string; name: string }

/** @param React Shared React runtime. @param ui Existing project primitives. @returns Controlled preview of the owner's loaded image sequence. */
export function createImageGallery(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function ImageGallery({ images, selectedId, onSelect, onClose, t }: { images: GalleryImage[]; selectedId: string | null; onSelect(id: string): void; onClose(): void; t: WorkbenchText }) {
    const index = images.findIndex(image => image.id === selectedId), image = images[index]
    if (!image) return null
    return <ui.ImageLightbox src={image.path} alt={image.name} labels={{ dialog: t('galleryPreview'), close: t('close') }}
      loadingLabels={{ loading: t('galleryPreviewLoading'), error: t('galleryPreviewError'), retry: t('retry') }} loadingImageSrc={loadingArtwork} onClose={onClose}
      navigation={{ positionLabel: `${index + 1} / ${images.length}`, previousLabel: t('imagePrevious'), nextLabel: t('imageNext'),
        onPrevious: index > 0 ? () => onSelect(images[index - 1]!.id) : undefined,
        onNext: index + 1 < images.length ? () => onSelect(images[index + 1]!.id) : undefined }} />
  }
}
