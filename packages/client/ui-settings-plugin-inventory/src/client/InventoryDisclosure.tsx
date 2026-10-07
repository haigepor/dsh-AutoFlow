/** Lazy disclosure retaining visited content and focus isolation during height transitions. */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import css from './PluginInventorySettingsTab.module.css'

/** Mount on first expansion, then retain content for continuous reverse transitions.
 * @param props Disclosure state, identity and retained content.
 * @returns Animated, inert-while-collapsed region.
 */
export function InventoryDisclosure({ open, id, children }: {
  readonly open: boolean
  readonly id: string
  readonly children: ReactNode
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [visited, setVisited] = useState(open)
  useLayoutEffect(() => {
    if (open) setVisited(true)
    // 关闭动画期间保留内容，但立即移出键盘和辅助技术的操作范围。
    if (ref.current !== null) ref.current.inert = !open
  }, [open])
  return (
    <div ref={ref} id={id} className={css.disclosure} data-open={open} aria-hidden={!open}>
      <div className={css.disclosureClip}>{open || visited ? children : null}</div>
    </div>
  )
}
