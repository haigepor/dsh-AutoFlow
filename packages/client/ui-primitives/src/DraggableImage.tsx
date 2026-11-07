/** Original-image drag gestures owned by a presentation primitive. */
import { forwardRef, type ImgHTMLAttributes } from 'react'
import { useImageDrag } from './image-drag.ts'
import type { FileDragActions } from './file-drag-actions.ts'

/** Image presentation plus original content and explicit file preparation callbacks. */
export interface DraggableImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'draggable' | 'onDragStart' | 'onDragEnd' | 'onPointerEnter' | 'onPointerLeave' | 'onPointerDown' | 'onPointerUp' | 'onClickCapture'> {
  readonly fileDrag: FileDragActions
  readonly src: string
  /** Original content URL when src displays a bounded preview. Resource identity remains available for native borrowing. */
  readonly originalSrc?: string | undefined
  readonly name: string
  readonly resourceAddress?: string | undefined
  readonly original?: File | undefined
}

/**
 * Render an image with original-file dragging; using explicit application-owned callbacks.
 * @param props - image attributes, original filename and file preparation callbacks.
 * @param ref - image element for measurement and pointer-mode bindings.
 * @returns a draggable image that suppresses only the mouse click following its drag.
 */
export const DraggableImage = forwardRef<HTMLImageElement, DraggableImageProps>(function DraggableImage(
  { fileDrag, src, originalSrc, name, original, resourceAddress, ...props }, ref,
) {
  const drag = useImageDrag(fileDrag, originalSrc ?? src, name, original, resourceAddress)
  return <img {...props} {...drag} src={src} ref={ref} draggable />
})
