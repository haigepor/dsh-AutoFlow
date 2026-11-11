import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { mountLoadingDots } from './image-loading-dots.ts'
import css from './ImageGenerationSkeleton.module.css'

/** Decorative loading texture; the owning image frame supplies its accessible status. */
export interface ImageGenerationSkeletonProps {
  /** Task-local motion permission, independent of page visibility and reduced-motion preference. */
  active?: boolean
  /** Additional frame-local sizing or presentation class. */
  className?: string
}

/** Reuse the conversation image-generation texture without loading task or account state.
 * @param props Owner presentation and task-local motion permission.
 * @returns A decorative Canvas whose observers and animation frames are released on unmount.
 */
export function ImageGenerationSkeleton({ active = true, className }: ImageGenerationSkeletonProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => canvas.current ? mountLoadingDots(canvas.current, active) : undefined, [active])
  return <canvas ref={canvas} className={clsx(css.canvas, className)} data-image-generation-skeleton="" aria-hidden="true" />
}
