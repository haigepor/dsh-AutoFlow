/** Provider subpages use the enclosing Settings page's enter/leave animations. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Delay a page replacement until the current Settings exit animation completes.
 * @param root - contains the visible model-settings subpage.
 * @returns animation state and a replacement callback; overlapping requests are ignored.
 */
export function useProviderPageTransition(root: RefObject<HTMLElement | null>): {
  active: boolean
  leaving: boolean
  transition: (replace: () => void) => void
} {
  const [active, setActive] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const pending = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    if (!leaving) return
    const view = root.current?.querySelector<HTMLElement>('[data-models-subpage]:not([hidden])')
    // 读取设置页实际使用的时长；无动画或减少动态效果时立即替换，不另设延迟。
    const duration = view == null ? 0 : Number.parseFloat(getComputedStyle(view).animationDuration) * 1000
    const finish = (): void => {
      const replace = pending.current
      pending.current = null
      setLeaving(false)
      replace?.()
    }
    if (!Number.isFinite(duration) || duration <= 0) { finish(); return }
    const timer = window.setTimeout(finish, duration)
    return () => { window.clearTimeout(timer) }
  }, [leaving, root])
  return {
    active, leaving,
    transition: (replace) => {
      if (pending.current !== null) return
      pending.current = replace
      setActive(true)
      setLeaving(true)
    },
  }
}
