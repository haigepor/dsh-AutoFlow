import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button.tsx'
import { StateDot } from './StateDot.tsx'
import { IconCloseOutlineRegular } from './icons/index.tsx'
import css from './ImageLightbox.module.css'

/** Lightbox strings the owner resolves from its own locale namespace. */
export interface ImageLightboxLabels {
  /** Accessible name of the preview dialog. */
  dialog: string
  /** Accessible label of the close control. */
  close: string
}

/** Owner-localized feedback for an image request, including a retry action. */
export interface ImageLightboxLoadingLabels {
  /** Announced while the original image is loading. */
  loading: string
  /** Displayed when the image request fails. */
  error: string
  /** Label of the explicit retry control. */
  retry: string
}

function LightboxImage({ src, alt, labels, loadingImageSrc, onRetry }: {
  src: string
  alt: string
  labels: ImageLightboxLoadingLabels | undefined
  loadingImageSrc: string | undefined
  onRetry: () => void
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading'), [attempt, setAttempt] = useState(0)
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => { if (image.current?.complete && image.current.naturalWidth > 0) setStatus('ready') }, [attempt])
  return <>
    <img key={attempt} ref={image} className={css.image} src={src} alt={alt} data-state={labels ? status : undefined}
      onLoad={() => { setStatus('ready') }} onError={() => { setStatus('error') }} />
    {labels && status !== 'ready' && <div className={css.feedback} data-illustrated={status === 'loading' && !!loadingImageSrc}
      role={status === 'error' ? 'alert' : 'status'} aria-live="polite">
      {status === 'loading' && loadingImageSrc && <img className={css.artwork} src={loadingImageSrc} alt="" width={88} height={88} />}
      <span className={css.caption}><StateDot state={status === 'error' ? 'warning' : 'ongoing'} />{status === 'error' ? labels.error : labels.loading}</span>
      {status === 'error' && <Button size="sm" variant="outline" onClick={() => { onRetry(); setStatus('loading'); setAttempt(value => value + 1) }}>{labels.retry}</Button>}
    </div>}
  </>
}

/**
 * Document-level original-image preview opened by clicking a thumbnail.
 * Closes on Escape, backdrop press, or the close control, and restores focus
 * to the opener on unmount. Rendered through a body portal: an opener inside
 * a transformed or filtered ancestor would otherwise trap the fixed backdrop
 * in that ancestor's box instead of covering the viewport.
 *
 * @param props.src - the original image URL.
 * @param props.alt - the image's alt text.
 * @param props.labels - dialog and close-control strings.
 * @param props.loadingLabels - optional localized loading, failure and retry controls; omitted callers retain the plain image presentation.
 * @param props.loadingImageSrc - optional decorative artwork displayed above the loading caption.
 * @param props.onClose - dismiss callback owned by the opener.
 * @returns the modal preview dialog.
 */
export function ImageLightbox({ src, alt, labels, loadingLabels, loadingImageSrc, onClose }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  loadingLabels?: ImageLightboxLoadingLabels | undefined
  loadingImageSrc?: string | undefined
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        event.preventDefault()
        const controls = Array.from(stageRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const current = controls.findIndex(control => control === document.activeElement)
        controls[(current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      restoreRef.current?.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div ref={stageRef} className={css.stage}>
        <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
        <LightboxImage key={src} src={src} alt={alt} labels={loadingLabels} loadingImageSrc={loadingImageSrc}
          onRetry={() => { closeRef.current?.focus() }} />
        <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>
          <IconCloseOutlineRegular size={16} />
        </button>
      </div>
    </div>,
    document.body,
  )
}
