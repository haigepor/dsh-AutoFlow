/** Height disclosure that keeps its last body mounted until the exit completes. */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import css from './AnimatedCollapse.module.css'

/** Controlled disclosure with optional outer and inner layout classes. */
export interface AnimatedCollapseProps {
  open: boolean
  children?: ReactNode
  /** Retain the current body while closed, for controls owning transient DOM state. */
  keepMounted?: boolean | undefined
  id?: string | undefined
  className?: string | undefined
  contentClassName?: string | undefined
}

/**
 * Animate height without measuring or fixing the body's intrinsic height.
 * Closing content is immediately hidden from focus and accessibility navigation;
 * its last rendered children remain only for the CSS exit, then unmount unless
 * keepMounted retains the current body and its transient control state.
 * @param props - Controlled visibility, content, and layout classes.
 * @returns A lazy, reversible disclosure respecting the theme's motion settings.
 */
export function AnimatedCollapse({ open, children, keepMounted = false, id, className, contentClassName }: AnimatedCollapseProps) {
  const root = useRef<HTMLDivElement>(null)
  const lastChildren = useRef(children)
  const [present, setPresent] = useState(open)
  const [expanded, setExpanded] = useState(open)

  useLayoutEffect(() => { if (open) lastChildren.current = children }, [open, children])
  useLayoutEffect(() => {
    if (open) {
      if (!present) { setPresent(true); return }
      // 首次展开先提交零高度，再读取布局，以便浏览器保留过渡的起点。
      root.current?.getBoundingClientRect()
      setExpanded(true)
      return
    }
    setExpanded(false)
    if (keepMounted) return
    if (!present || !root.current) return
    const style = getComputedStyle(root.current)
    const milliseconds = (value: string) => value.split(',').map((part) => {
      const number = Number.parseFloat(part) || 0
      return part.trim().endsWith('ms') ? number : number * 1000
    })
    const durations = milliseconds(style.transitionDuration)
    const delays = milliseconds(style.transitionDelay)
    const duration = Math.max(0, ...durations.map((value, index) => value + (delays[index % delays.length] ?? 0)))
    if (duration === 0) { setPresent(false); return }
    const timer = setTimeout(() => { setPresent(false) }, duration)
    return () => { clearTimeout(timer) }
  }, [open, present, keepMounted])

  return (
    <div ref={root} id={id} className={clsx(css.root, className)} data-expanded={expanded || undefined}
      aria-hidden={!open} {...open ? {} : { inert: '' }}>
      <div className={clsx(css.clip, contentClassName)}>
        {keepMounted ? children : (open || present) && (open ? children : lastChildren.current)}
      </div>
    </div>
  )
}
