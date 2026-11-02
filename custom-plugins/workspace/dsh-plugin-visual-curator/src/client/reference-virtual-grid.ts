/** Reference cards retain their CSS grid while the maintained virtualizer windows complete rows. */
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/virtual-core'
import type { RefObject } from 'react'

interface Options {
  scrollRef: RefObject<HTMLDivElement>; gridRef: RefObject<HTMLDivElement>
  count: number; identity: string; resetKey: string; view: 'grid' | 'list'; enabled: boolean
  restoreOffset(): number
}
interface Geometry { identity: string; view: Options['view']; columns: number; height: number; gap: number; margin: number }

/**
 * Bind row virtualization to the caller's React runtime without wrapping card figures.
 * @param React React instance supplied by the owning Host.
 * @returns A hook returning an exclusive item range, gap-adjusted grid spacers and readiness for scroll persistence. A changed reset key returns to the top; appends retain the current offset.
 */
export function createReferenceVirtualGrid(React: typeof import('react')) {
  return function useReferenceVirtualGrid(options: Options) {
    const { scrollRef, gridRef, count, identity, resetKey, view, enabled } = options
    const [, render] = React.useReducer((revision: number) => revision + 1, 0)
    const [geometry, setGeometry] = React.useState<Geometry | null>(null)
    const latest = React.useRef(options); latest.current = options
    const viewport = React.useRef({ width: 0, height: 0 })
    const context = React.useRef({ identity, resetKey, view, enabled: false })
    const restore = React.useRef({ pending: true, offset: 0 })
    if (context.current.identity !== identity || context.current.resetKey !== resetKey) restore.current = { pending: true, offset: 0 }
    else if (enabled && (!context.current.enabled || context.current.view !== view)) restore.current = { pending: true, offset: Math.max(0, options.restoreOffset()) }
    context.current = { identity, resetKey, view, enabled }
    const layout = geometry?.identity === identity && geometry.view === view ? geometry : null
    const currentLayout = React.useRef(layout); currentLayout.current = layout
    const getScrollElement = React.useCallback(() => scrollRef.current, [scrollRef])
    const estimateSize = React.useCallback(() => currentLayout.current?.height ?? 1, [])
    const virtualizer = React.useMemo(() => new Virtualizer<HTMLDivElement, HTMLElement>({
      count: 0, getScrollElement, estimateSize, scrollToFn: elementScroll, observeElementOffset, observeElementRect,
      initialOffset: () => restore.current.pending ? restore.current.offset : Math.max(0, latest.current.restoreOffset()),
    }), [identity, resetKey, getScrollElement, estimateSize])
    const rowCount = layout ? Math.ceil(count / layout.columns) : 0
    const scroller = scrollRef.current
    virtualizer.setOptions({ ...virtualizer.options, count: rowCount, enabled: enabled && count > 0 && !!layout, estimateSize,
      gap: layout?.gap ?? 0, scrollMargin: layout?.margin ?? 0, overscan: 2,
      initialRect: { width: scroller?.clientWidth || viewport.current.width, height: scroller?.clientHeight || viewport.current.height }, onChange: () => render(),
    })
    const rows = virtualizer.getVirtualItems(), first = rows[0], last = rows.at(-1)
    const ready = enabled && !!layout && !!first && !!last
    const measured = React.useRef<{ virtualizer: typeof virtualizer; columns: number; height: number; gap: number } | null>(null)
    React.useLayoutEffect(() => virtualizer._didMount(), [virtualizer])
    React.useLayoutEffect(() => {
      const element = scrollRef.current
      if (enabled && element && restore.current.pending && (ready || count === 0 && restore.current.offset === 0)) {
        element.scrollTop = restore.current.offset
        restore.current.pending = false
      }
      virtualizer._willUpdate()
      if (!ready || !layout) return
      const prior = measured.current
      if (!prior || prior.virtualizer !== virtualizer || prior.height !== layout.height || prior.columns !== layout.columns || prior.gap !== layout.gap) {
        measured.current = { virtualizer, columns: layout.columns, height: layout.height, gap: layout.gap }
        // Changing estimateSize alone does not invalidate the maintained library's measurement cache.
        virtualizer.measure()
      }
    })
    const observer = React.useRef<ResizeObserver | null>(null), watched = React.useRef(new Set<Element>())
    const read = React.useRef(() => {})
    read.current = () => {
      const current = latest.current, element = current.scrollRef.current, grid = current.gridRef.current
      if (!current.enabled || !element || !grid || element.clientHeight <= 0 || grid.getBoundingClientRect().width <= 0) return
      const figure = grid.querySelector<HTMLElement>(':scope > figure')
      if (!figure) return
      const height = figure.getBoundingClientRect().height, styles = getComputedStyle(grid)
      const columns = current.view === 'list' ? 1 : styles.gridTemplateColumns === 'none' ? 0 : styles.gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length
      if (height <= 0 || columns === 0) return
      const next: Geometry = { identity: current.identity, view: current.view, columns, height, gap: Number.parseFloat(styles.rowGap) || 0,
        margin: grid.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop + element.scrollTop }
      viewport.current = { width: element.clientWidth, height: element.clientHeight }
      setGeometry(previous => previous && previous.identity === next.identity && previous.view === next.view && previous.columns === columns && previous.height === height && previous.gap === next.gap && Math.abs(previous.margin - next.margin) < 0.5 ? previous : next)
    }
    const disconnect = React.useCallback(() => { observer.current?.disconnect(); observer.current = null; watched.current.clear() }, [])
    React.useLayoutEffect(() => disconnect, [disconnect])
    React.useLayoutEffect(() => {
      const grid = gridRef.current
      if (!enabled || !grid) { disconnect(); return }
      if (!observer.current) {
        const native = new ResizeObserver(() => { if (observer.current === native) read.current() })
        observer.current = native
      }
      const figure = grid.querySelector<HTMLElement>(':scope > figure'), next = new Set<Element>(figure ? [grid, figure] : [grid])
      for (const element of watched.current) if (!next.has(element)) observer.current.unobserve(element)
      for (const element of next) if (!watched.current.has(element)) observer.current.observe(element)
      watched.current = next
      read.current()
    })
    if (!ready) return { start: 0, end: enabled ? Math.min(count, 1) : 0, top: 0, bottom: 0, before: false, after: false, ready: false }
    const before = first.index > 0, after = last.index < rowCount - 1
    return { start: first.index * layout.columns, end: Math.min(count, (last.index + 1) * layout.columns),
      top: before ? Math.max(0, first.start - layout.margin - layout.gap) : 0,
      bottom: after ? Math.max(0, virtualizer.getTotalSize() - (last.end - layout.margin) - layout.gap) : 0,
      before, after, ready: true }
  }
}
