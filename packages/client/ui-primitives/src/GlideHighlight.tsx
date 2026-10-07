/** A shared hover/focus layer for navigation rows owned by its parent element. */
import { useEffect, useRef } from 'react'

/**
 * Render one decorative highlight behind the parent's matching rows.
 * The parent must be positioned; row geometry may change through scrolling or nesting.
 * @param props.className - owner styling for the absolutely positioned layer.
 * @param props.rowSelector - selector for interactive rows inside the parent.
 * @param props.bridgeGaps - follow the nearest vertical row across noninteractive gaps after row entry; off by default.
 * @returns a pointer-inert layer that follows hovered or focused rows.
 */
export function GlideHighlight({ className, rowSelector, bridgeGaps = false }: {
  className: string | undefined
  rowSelector: string
  bridgeGaps?: boolean
}) {
  const layerRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    const container = layer.parentElement
    if (container === null) return

    let pointerRow: HTMLElement | null = null
    let focusRow: HTMLElement | null = null
    let placed = false
    let placementFrame = 0
    const rowFor = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null
      const row = target.closest(rowSelector)
      return row instanceof HTMLElement && container.contains(row) ? row : null
    }
    const hide = (): void => {
      layer.style.opacity = '0'
      delete container.dataset.glideActive
    }
    const show = (row: HTMLElement | null): void => {
      if (row === null || !container.contains(row)) { hide(); return }
      if (!placed) {
        // 首次定位只淡入，避免高亮从容器左上角滑到目标行。
        placed = true
        placementFrame = window.requestAnimationFrame(() => { layer.dataset.glidePlaced = 'true' })
      }
      const parentRect = container.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      layer.style.left = `${String(rowRect.left - parentRect.left + container.scrollLeft)}px`
      layer.style.top = `${String(rowRect.top - parentRect.top + container.scrollTop)}px`
      layer.style.width = `${String(rowRect.width)}px`
      layer.style.height = `${String(rowRect.height)}px`
      layer.style.opacity = '1'
      container.dataset.glideActive = 'true'
    }
    const onPointerOver = (event: PointerEvent): void => {
      const row = rowFor(event.target)
      if (row === null) return
      pointerRow = row
      show(row)
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (!bridgeGaps || pointerRow === null || rowFor(event.target) !== null) return
      let nearest = pointerRow
      let distance = Infinity
      // 分类标题不接收高亮；经过间隙时提前向最近的选项滑动，避免入行后才追赶。
      for (const row of container.querySelectorAll<HTMLElement>(rowSelector)) {
        const rect = row.getBoundingClientRect()
        if (rect.height === 0) continue
        const nextDistance = Math.abs(event.clientY - rect.top - rect.height / 2)
        if (nextDistance < distance) { nearest = row; distance = nextDistance }
      }
      if (nearest === pointerRow) return
      pointerRow = nearest
      show(nearest)
    }
    const onPointerLeave = (): void => {
      pointerRow = null
      show(focusRow)
    }
    const onFocusIn = (event: FocusEvent): void => {
      focusRow = rowFor(event.target)
      if (focusRow !== null) show(focusRow)
    }
    const onFocusOut = (event: FocusEvent): void => {
      focusRow = rowFor(event.relatedTarget)
      show(focusRow ?? pointerRow)
    }
    const onScroll = (): void => {
      // 滚动后旧指针行可能已离开视口，键盘焦点仍保持定位。
      pointerRow = null
      show(focusRow)
    }
    const onDragStart = (): void => {
      pointerRow = null
      hide()
    }

    container.addEventListener('pointerover', onPointerOver)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerleave', onPointerLeave)
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)
    container.addEventListener('scroll', onScroll)
    container.addEventListener('dragstart', onDragStart)
    return () => {
      window.cancelAnimationFrame(placementFrame)
      container.removeEventListener('pointerover', onPointerOver)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerleave', onPointerLeave)
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('dragstart', onDragStart)
      layer.style.opacity = '0'
      delete layer.dataset.glidePlaced
      delete container.dataset.glideActive
    }
  }, [className, rowSelector, bridgeGaps])

  return className === undefined ? null : <span ref={layerRef} className={className} aria-hidden="true" />
}
